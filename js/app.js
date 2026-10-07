import {evaluateThinking, thinkingIsReady, thinkingText} from './thinking.js';
import {EMPTY, readProgress, saveProgress, mergeProgress, sanitize, nextTimestamp, workFingerprint, stage, isCompleted, isAttempted, chooseNext, importLegacy, storageKey} from './progress.js';
import {getEffectiveScenario, recordSkillAttempt} from './curriculum.js';
import {createCloudSync} from './cloud.js';
import {renderSchemaCards} from './schema.js';
import {escapeHtml, getOAuthRedirectUrl} from './util.js';
import {SqlEngineManager, loadBrowserPGlite} from './sql-evaluator.js?v=4';
import {initContest, renderContestCard, closeContestModal, getContestState} from './contest.js';
import {
  initNotificationsState,
  getNotifications,
  claimCertificateNotification,
  markNotificationRead,
  markAllNotificationsAsRead,
  renderNotificationsUI
} from './notifications.js';
import {
  CERTIFICATE_DOMAINS,
  CERTIFICATE_LEVELS,
  checkLevelCompletion,
  getEarnedCertificates,
  getAllCertificatesStatus,
  generateCertificateSvg,
  downloadCertificateImage,
  printCertificate,
  getLearnerDisplayName,
  formatCertificateLevel,
  formatCertificateDomain,
  formatCompletionDate
} from './certificate.js';

const $ = id => document.getElementById(id);
let data, scenarios=[], ids=new Set(), state=EMPTY(), current=null, user=null;
let selectedDomain=null, selectedLevel=null, client=null, deferredPrompt=null, syncTimer=null;
let isPaidUnlocked = false, userPendingPayment = null;
let authNotice='';
let currentUsername = null;
let storage;
try { storage=window.localStorage; } catch { storage={getItem(){return null;},setItem(){throw Error('Storage unavailable');}}; }

// Centralized SQL Engine Manager instance
const sqlEngineManager = new SqlEngineManager({ loadPGlite: loadBrowserPGlite, timeoutMs: 4000 });

sqlEngineManager.onStateChange((engineState, details) => {
  const isBusy = sqlEngineManager.isBusy();
  const runBtn = $('checkSqlButton');
  const runLabel = $('checkSqlBtnLabel');
  const resetBtn = $('resetSqlButton');
  const resetIdeBtn = $('resetSqlIdeBtn');
  const resetLabel = $('resetSqlBtnLabel');

  if (resetBtn) resetBtn.disabled = isBusy;
  if (resetIdeBtn) resetIdeBtn.disabled = isBusy;

  switch (engineState) {
    case 'initializing':
      updateSqlEditorStatus('PostgreSQL • Initializing database...', 'initializing');
      if (runBtn) runBtn.disabled = true;
      if (runLabel) runLabel.textContent = 'Initializing...';
      if (resetLabel) resetLabel.textContent = 'Reset SQL';
      break;
    case 'ready':
      updateSqlEditorStatus('PostgreSQL • Ready', 'ready');
      if (runLabel) runLabel.textContent = 'Check / Run SQL';
      if (resetLabel) resetLabel.textContent = 'Reset SQL';
      updateGates();
      break;
    case 'running':
      updateSqlEditorStatus('PostgreSQL • Running query...', 'running');
      if (runBtn) runBtn.disabled = true;
      if (runLabel) runLabel.textContent = 'Checking query…';
      break;
    case 'completed':
      if (details?.passed) {
        updateSqlEditorStatus('PostgreSQL • Query verified ✓', 'verified');
      } else {
        updateSqlEditorStatus('PostgreSQL • Query error', 'error');
      }
      if (runLabel) runLabel.textContent = 'Check / Run SQL';
      if (resetLabel) resetLabel.textContent = 'Reset SQL';
      updateGates();
      break;
    case 'error':
      updateSqlEditorStatus('PostgreSQL • Engine error', 'error');
      if (runLabel) runLabel.textContent = 'Check / Run SQL';
      if (resetLabel) resetLabel.textContent = 'Reset SQL';
      updateGates();
      break;
    case 'resetting':
      updateSqlEditorStatus('PostgreSQL • Resetting database...', 'resetting');
      if (runBtn) runBtn.disabled = true;
      if (runLabel) runLabel.textContent = 'Resetting...';
      if (resetLabel) resetLabel.textContent = 'Resetting...';
      break;
    default:
      updateSqlEditorStatus('PostgreSQL • Ready', 'ready');
      if (runLabel) runLabel.textContent = 'Check / Run SQL';
      updateGates();
      break;
  }
});
const labels={not_started:'Not started',thinking:'Thinking in progress',answer_viewed:'Earlier answer viewed — thinking not assessed',thinking_ready:'Thinking ready',sql_written:'SQL draft saved',fiddle_opened:'SQL draft saved',verified:'SQL verified'};
const cloud=createCloudSync({
  client: () => client,
  getContext:()=>({userId:user?.id,state:structuredClone(state)}),
  onMerged(remote,owner) {
    if(!user || owner!==user.id) return;
    const before=current?JSON.stringify(state.entries[current.id]):null;
    state=mergeProgress(state,remote,ids);
    saveProgress(storage, user.id, state);
    updateProgress();
    // Local edits have their own timestamp and win over older cloud snapshots.
    if(current && before!==JSON.stringify(state.entries[current.id])) renderScenario();
  },
  onStatus:message=>{
    if ($('syncStatus')) $('syncStatus').textContent=message;
    if ($('modalProfileSync')) {
      $('modalProfileSync').textContent = user ? message : 'Saved on Device';
      $('modalProfileSync').style.color = (message.includes('synced') || message.includes('Sync')) ? '#166534' : '#64748b';
    }
  }
});
function persist(sync=true, immediateSync=true) {
  const saved=saveProgress(storage,user?.id,state);
  if(!saved) {
    if ($('syncStatus')) $('syncStatus').textContent='Browser storage is unavailable. Keep this page open; local progress cannot be saved.';
  } else if(!user) {
    if ($('syncStatus')) $('syncStatus').textContent='Guest progress saved on this device.';
  }
  if(sync && user && client) {
    clearTimeout(syncTimer);
    if (immediateSync) {
      cloud.request();
    } else {
      syncTimer=setTimeout(()=>cloud.request(),100);
    }
  }
  updateProgress();
}
function entry() { return current ? state.entries[current.id] || {} : {}; }
function changeEntry(patch, immediateSync=true) {
  if(!current) return;
  state.entries[current.id]={...entry(),...patch,updatedAt:nextTimestamp(state)};
  persist(true, immediateSync);
}
function readThinking() {
  return {response:$('thinking').value};
}
const CORE_DOMAINS = ['Banking', 'Healthcare', 'Insurance', 'Retail'];
let currentDomainTrack = 'core'; // 'core' (240 scenarios) or 'all' (420 scenarios)

function setDomainTrack(track) {
  currentDomainTrack = track;
  if ($('trackCoreBtn')) $('trackCoreBtn').classList.toggle('active', track === 'core');
  if ($('trackAllBtn')) $('trackAllBtn').classList.toggle('active', track === 'all');
  if ($('extraDomainsWrapper')) $('extraDomainsWrapper').hidden = (track === 'core');
  if ($('progressTrackLabel')) $('progressTrackLabel').textContent = track === 'core' ? 'Verified SQL Progress (4 Core Domains)' : 'Verified SQL Progress (All Domains)';
  if ($('scenarioSearch')) {
    $('scenarioSearch').placeholder = track === 'core' 
      ? '🔍 Search 240 scenarios across 4 core domains...' 
      : '🔍 Search 420 scenarios by title, keyword, or query...';
  }
  updateProgress();
  renderScenarioCatalog();
}

function updateProgress() {
  const activeScenarios = (currentDomainTrack === 'core' && !scenarioSearchQuery)
    ? scenarios.filter(s => CORE_DOMAINS.includes(s.domain))
    : scenarios;
  const completed = activeScenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
  const inProgress = activeScenarios.filter(s => isAttempted(s, state.entries[s.id]) && !isCompleted(s, state.entries[s.id])).length;
  if ($('progressCount')) $('progressCount').textContent = completed + ' / ' + activeScenarios.length;
  if ($('progressFill')) $('progressFill').style.width = (activeScenarios.length ? (completed / activeScenarios.length * 100) : 0) + '%';
  if ($('progressStages')) {
    const started = activeScenarios.filter(s => isAttempted(s, state.entries[s.id])).length;
    $('progressStages').textContent = `${completed} completed (score ≥ 7) · ${inProgress} in progress · ${activeScenarios.length - started} not started`;
  }
  if (current) {
    const e = entry();
    const isCurCompleted = isCompleted(current, e);
    const isCurAttempted = isAttempted(current, e);
    if ($('learningStage')) {
      if (isCurCompleted) {
        $('learningStage').textContent = 'Completed (Score ≥ 7)';
      } else if (isCurAttempted) {
        $('learningStage').textContent = (typeof e.assessment?.score === 'number') 
          ? `Attempted • Thinking Score: ${e.assessment.score}/10` 
          : 'In progress';
      } else {
        $('learningStage').textContent = 'Not started';
      }
    }
    if ($('doneTag')) {
      $('doneTag').classList.toggle('show', isCurCompleted || isCurAttempted);
      if (isCurCompleted) {
        $('doneTag').textContent = 'Completed ✓';
        $('doneTag').style.background = '#dcfce7';
        $('doneTag').style.color = '#15803d';
      } else if (isCurAttempted) {
        $('doneTag').textContent = (typeof e.assessment?.score === 'number') ? 'Attempted' : 'In Progress';
        $('doneTag').style.background = '#fef3c7';
        $('doneTag').style.color = '#b45309';
      }
    }
  }
  renderProgressScreen();
  updateNotificationsUI();
}

function updateNotificationsUI() {
  const contestState = typeof getContestState === 'function' ? getContestState() : null;
  renderNotificationsUI({
    scenarios,
    state,
    user,
    currentUsername,
    activeContest: contestState?.contest || null
  });
}
function renderAssessment(result) {
  $('feedback').classList.toggle('active', !!result);
  const ring = $('scoreRing');
  const num = $('scoreNum');
  const headline = $('scoreHeadline');
  const howToThinkBox = $('howToThinkBox');
  
  if (!result) {
    if (ring) ring.style.background = 'conic-gradient(var(--line) 0deg, var(--line) 360deg)';
    if (num) num.textContent = '0';
    if (headline) headline.textContent = 'Explain your plan to calculate score (Goal, Sources, Logic)';
    if (howToThinkBox) { howToThinkBox.hidden = true; howToThinkBox.innerHTML = ''; }
    ['Goal', 'Sources', 'Steps', 'Check'].forEach(k => {
      const chip = $('chip' + k);
      if (chip) { chip.className = 'score-chip'; chip.textContent = k; }
    });
    return;
  }
  
  const score = result.score;
  const deg = (score / 10) * 360;
  const ringColor = result.ready ? 'var(--good)' : score >= 5 ? 'var(--warn)' : 'var(--primary)';
  if (ring) ring.style.background = `conic-gradient(${ringColor} ${deg}deg, var(--line) 0deg)`;
  if (num) num.textContent = String(score);
  
  if (headline) {
    headline.textContent = result.ready
      ? `✓ Score ${score}/10 — Great intuition! (Ready to generate SQL)`
      : score >= 5
      ? `Thinking Score: ${score}/10 — Good intuition! Review the decoded plan below.`
      : `Thinking Score: ${score}/10 — Review how a data engineer thinks below.`;
  }
  
  if ($('score')) $('score').textContent = `Thinking Score: ${score}/10`;
  if ($('assessmentMessage')) $('assessmentMessage').textContent = result.message;
  
  if ($('improve')) $('improve').innerHTML = '';

  // Decode and show: "How to Think Like a Data Engineer"
  if (howToThinkBox && current) {
    howToThinkBox.hidden = false;
    howToThinkBox.innerHTML = `
      <div class="how-to-think-card" style="margin-top:12px;padding:12px 14px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;">
        <div style="margin-bottom:8px;">
          <strong style="color:#0369a1;font-size:14px;">💡 How to Think Like a Data Engineer:</strong>
        </div>
        <div style="font-size:13px;line-height:1.6;color:var(--ink);">
          <div style="margin-bottom:6px;"><strong>1. Table:</strong> From the <code>${current.tables.join(', ')}</code> table${current.tables.length > 1 ? 's' : ''}, where this data lives.</div>
          <div style="margin-bottom:6px;"><strong>2. What to do:</strong> ${escapeHtml(current.pseudo || 'Apply the required filter, join, or aggregation logic to isolate the target rows.')}</div>
          <div><strong>3. Expected result:</strong> Show the requested details in the final output.</div>
        </div>
      </div>
    `;
  }
}
function updateGates() {
  const e = entry();
  if ($('practiceStatus')) $('practiceStatus').textContent = current ? labels[stage(current, e)] : '';
  const thinkingScore = typeof e.assessment?.score === 'number' ? e.assessment.score : 0;
  if ($('nextButton')) $('nextButton').disabled = thinkingScore < 7;
}

async function copySchemaAndOpenFiddle() {
  if (!current || !data?.assets?.[current.domain]) return;
  const asset = data.assets[current.domain];
  const schema = (asset.schema || '').trim();
  const sample = (asset.sample || '').trim();
  const completeSetup = (schema + '\n\n' + sample).trim();

  let copied = false;
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(completeSetup);
      copied = true;
    }
  } catch (err) {
    console.warn('Clipboard writeText failed, using fallback', err);
  }

  if (!copied) {
    try {
      const textarea = document.createElement('textarea');
      textarea.value = completeSetup;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      copied = true;
    } catch (e) {
      console.warn('Fallback copy failed', e);
    }
  }

  const confirmEl = $('fiddleCopyConfirmation');
  if (confirmEl) {
    confirmEl.textContent = 'Schema and sample data copied. Paste it into DB Fiddle and write your SQL query.';
  }

  try {
    window.open('https://www.db-fiddle.com/', '_blank', 'noopener,noreferrer');
  } catch (err) {
    console.warn('window.open blocked or failed:', err);
  }
}

function updateSqlEditorStatus(label, type) {
  const textEl = $('sqlStatusText');
  const dotEl = $('sqlStatusDot');
  if (textEl) textEl.textContent = label;
  if (dotEl) {
    dotEl.className = 'sql-status-indicator ' + type;
  }
}

function highlightSql(code) {
  if (!code) return '';
  let html = code
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // SQL comments (-- ...)
  const comments = [];
  html = html.replace(/(--.*$)/gm, (match) => {
    comments.push(match);
    return `__SQL_COMMENT_${comments.length - 1}__`;
  });

  // SQL strings ('...')
  const strings = [];
  html = html.replace(/('([^'\\]|\\.)*')/g, (match) => {
    strings.push(match);
    return `__SQL_STRING_${strings.length - 1}__`;
  });

  // SQL keywords
  const keywords = [
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'IS', 'NULL',
    'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'FULL JOIN', 'CROSS JOIN', 'JOIN',
    'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'ON',
    'DISTINCT', 'UNION', 'ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
    'WITH', 'OVER', 'PARTITION BY', 'BY', 'BETWEEN', 'LIKE', 'ILIKE',
    'ASC', 'DESC', 'INTO', 'VALUES', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'TABLE'
  ];
  keywords.sort((a, b) => b.length - a.length);
  const kwRegex = new RegExp(`\\b(${keywords.join('|')})\\b`, 'gi');
  html = html.replace(kwRegex, '<span class="tok-kw">$1</span>');

  // SQL aggregate & scalar functions
  const funcs = [
    'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'ROUND', 'NOW',
    'DATE_TRUNC', 'EXTRACT', 'CONCAT', 'LOWER', 'UPPER', 'TRIM', 'CAST',
    'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'LAG', 'LEAD', 'FIRST_VALUE', 'LAST_VALUE'
  ];
  funcs.sort((a, b) => b.length - a.length);
  const fnRegex = new RegExp(`\\b(${funcs.join('|')})\\b(?=\\s*\\()`, 'gi');
  html = html.replace(fnRegex, '<span class="tok-fn">$1</span>');

  // Numbers
  html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');

  // Restore strings
  strings.forEach((str, i) => {
    html = html.replace(`__SQL_STRING_${i}__`, `<span class="tok-str">${str}</span>`);
  });

  // Restore comments
  comments.forEach((comm, i) => {
    html = html.replace(`__SQL_COMMENT_${i}__`, `<span class="tok-cmt">${comm}</span>`);
  });

  return html;
}

function updateSqlEditorView() {
  const textarea = $('learnerSql');
  if (!textarea) return;
  const sql = textarea.value;

  const highlightCode = $('sqlHighlightCode');
  if (highlightCode) {
    highlightCode.innerHTML = highlightSql(sql) + (sql.endsWith('\n') ? ' ' : '');
  }

  const gutter = $('sqlGutter');
  if (gutter) {
    const lines = sql.split('\n').length;
    let gutterHtml = '';
    for (let i = 1; i <= Math.max(lines, 1); i++) {
      gutterHtml += `<div class="sql-line-num">${i}</div>`;
    }
    gutter.innerHTML = gutterHtml;
  }

  const lineCountEl = $('sqlLineCount');
  if (lineCountEl) {
    lineCountEl.textContent = `Lines: ${sql.split('\n').length}`;
  }

  const charCountEl = $('sqlCharCount');
  if (charCountEl) {
    charCountEl.textContent = `Chars: ${sql.length}`;
  }

  syncEditorScroll();
}

function syncEditorScroll() {
  const textarea = $('learnerSql');
  const highlightPre = $('sqlHighlightPre');
  const gutter = $('sqlGutter');
  if (textarea && highlightPre) {
    highlightPre.scrollTop = textarea.scrollTop;
    highlightPre.scrollLeft = textarea.scrollLeft;
  }
  if (textarea && gutter) {
    gutter.scrollTop = textarea.scrollTop;
  }
}

function copyLearnerSql() {
  const sql = ($('learnerSql')?.value || '').trim();
  if (!sql) {
    updateSqlEditorStatus('PostgreSQL • Editor empty', 'ready');
    setTimeout(() => updateSqlEditorStatus('PostgreSQL • Ready', 'ready'), 1500);
    return;
  }
  try {
    navigator.clipboard.writeText(sql);
    const btn = $('copySqlBtn');
    if (btn) {
      const origHtml = btn.innerHTML;
      btn.innerHTML = '<span class="ide-btn-icon">✓</span><span>Copied!</span>';
      setTimeout(() => { if (btn) btn.innerHTML = origHtml; }, 2000);
    }
  } catch (err) {
    console.error('Clipboard error:', err);
  }
}

function clearLearnerSql() {
  const textarea = $('learnerSql');
  if (!textarea || !textarea.value.trim()) return;
  textarea.value = '';
  changeEntry({ sql: '', fiddleFingerprint: null, evaluationFingerprint: null, evaluationResult: null });
  renderSqlEvaluation(null);
  updateSqlEditorView();
  updateGates();
  updateSqlEditorStatus('PostgreSQL • Ready', 'ready');
  textarea.focus();
}

function renderResultTable(result) {
  if (!result || !Array.isArray(result.columns) || !result.columns.length || !Array.isArray(result.rows) || !result.rows.length) {
    return '';
  }
  const total = result.actualRows || result.rows.length;
  const displayRows = result.rows.slice(0, 25);
  const rowsNote = total === 1 ? '1 row' : `${total} rows`;
  const truncation = total > displayRows.length ? ` (showing first ${displayRows.length})` : '';

  return `
    <div class="sql-result-wrap">
      <div class="sql-result-meta">
        <span>Query Output: <strong>${escapeHtml(rowsNote)}</strong>${escapeHtml(truncation)}</span>
        <span class="muted small">${result.columns.length} column${result.columns.length === 1 ? '' : 's'}</span>
      </div>
      <div class="table-scroll" style="max-height: 220px; background: #ffffff;">
        <table class="sample-table">
          <thead>
            <tr>${result.columns.map(c => `<th>${escapeHtml(String(c))}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${displayRows.map(row => `
              <tr>${row.map(val => `<td>${escapeHtml(val === null ? 'NULL' : String(val))}</td>`).join('')}</tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderSqlEvaluation(result) {
  const box = $('sqlEvaluation');
  if (!box) return;
  if (!result) {
    box.hidden = true;
    box.className = 'evaluation';
    box.innerHTML = '<strong id="sqlEvaluationTitle"></strong><p id="sqlEvaluationMessage"></p><pre id="sqlPreview" hidden></pre>';
    updateSqlEditorStatus('PostgreSQL • Ready', 'ready');
    return;
  }
  box.hidden = false;
  const preview = Array.isArray(result.preview) && result.preview.length ? result.preview : null;
  const previewText = preview ? 'Result preview:\n' + preview.map(row => row.map(val => val === null ? 'NULL' : val).join(' | ')).join('\n') : '';
  const tableHtml = renderResultTable(result);

  if (result.passed) {
    updateSqlEditorStatus('PostgreSQL • Query verified ✓', 'verified');
    box.className = 'sql-verified-card';
    box.innerHTML = `
      <div class="sql-verified-title-row">
        <span class="sql-verified-icon">✓</span>
        <span class="sql-verified-label" id="sqlEvaluationTitle">SQL Result Verified</span>
        <span class="sql-verified-tag">Passed</span>
      </div>
      <div class="sql-verified-msg" id="sqlEvaluationMessage">${escapeHtml(result.message || 'Your query produced the expected result!')}</div>
      ${tableHtml || (preview ? `<pre id="sqlPreview" class="sql-preview-table">${escapeHtml(previewText)}</pre>` : '<pre id="sqlPreview" hidden></pre>')}
    `;
  } else {
    updateSqlEditorStatus('PostgreSQL • Query error', 'error');
    box.className = 'sql-error-card';
    let guidance = 'Check your query logic, filters, and column expressions.';
    if (/relation .* does not exist/i.test(result.message || '')) {
      guidance = 'Check the table name in FROM / JOIN and verify schema tabs.';
    } else if (/column .* does not exist/i.test(result.message || '')) {
      guidance = 'Check the column name in SELECT, WHERE, or GROUP BY and try again.';
    } else if (/syntax error/i.test(result.message || '')) {
      guidance = 'Check your PostgreSQL SQL syntax, commas, and keyword spelling.';
    } else if (/timed out|statement_timeout/i.test(result.message || '')) {
      guidance = 'Query exceeded the 4-second timeout limit. Check for missing JOIN conditions or cartesian products.';
    } else if (/engine|connection|could not start|failed to load/i.test(result.message || '')) {
      guidance = 'Click "Reset SQL" or reload to restart the local PostgreSQL engine.';
    } else if (/busy/i.test(result.message || '')) {
      guidance = 'The database engine is currently busy. Please wait a moment.';
    } else if (/columns but received|rows but received|values do not match/i.test(result.message || '')) {
      guidance = 'Compare your actual query output below with the expected scenario requirements.';
    }
    box.innerHTML = `
      <div class="sql-error-title-row">
        <span class="sql-error-icon">⚠</span>
        <span class="sql-error-label" id="sqlEvaluationTitle">${result.kind === 'result' ? 'Result Mismatch' : (result.kind === 'guard' ? 'Query Guard' : 'SQL Error')}</span>
      </div>
      <div class="sql-error-code-msg" id="sqlEvaluationMessage">${escapeHtml(result.message || 'Query execution error or mismatch.')}</div>
      <div class="sql-error-guidance">${escapeHtml(guidance)}</div>
      ${tableHtml || (preview ? `<pre id="sqlPreview" class="sql-preview-table">${escapeHtml(previewText)}</pre>` : '<pre id="sqlPreview" hidden></pre>')}
    `;
  }
}

async function resetCurrentSqlSession() {
  if (!current || !data?.assets?.[current.domain]) return;
  if (sqlEngineManager.isBusy()) return;

  try {
    renderSqlEvaluation(null);
    if ($('sqlGate')) {
      $('sqlGate').textContent = '🔄 Recreating clean scenario database...';
      $('sqlGate').style.color = 'var(--muted)';
    }
    const effective = getEffectiveScenario(current, user?.id || 'guest_user', state);
    await sqlEngineManager.resetScenario(effective, data.assets[effective.domain]);
    if ($('sqlGate')) {
      $('sqlGate').textContent = '✓ Scenario database session reset to clean state.';
      $('sqlGate').style.color = '#166534';
    }
    updateGates();
  } catch (err) {
    console.error('Reset scenario failed:', err);
    renderSqlEvaluation({
      passed: false,
      kind: 'engine',
      message: `Failed to reset scenario database: ${err.message}. Click "Reset SQL" to retry.`
    });
  }
}

function renderScenario() {
  if (!current) return;
  const effective = getEffectiveScenario(current, user?.id || 'guest_user', state);
  let entryNeedsSave = false;

  if (!state.entries[current.id]) {
    state.entries[current.id] = {
      thinking: { response: '' },
      sql: '',
      status: 'in_progress',
      attempts: 0,
      completed: false,
      variantIndex: effective.variantIndex,
      skill: effective.skill,
      updatedAt: nextTimestamp(state)
    };
    entryNeedsSave = true;
  } else if (!state.entries[current.id].status || state.entries[current.id].status === 'not_started') {
    state.entries[current.id].status = 'in_progress';
    state.entries[current.id].updatedAt = nextTimestamp(state);
    entryNeedsSave = true;
  }

  const e = entry();
  if (typeof e.variantIndex !== 'number' && typeof effective.variantIndex === 'number') {
    e.variantIndex = effective.variantIndex;
  }
  if (!e.skill && effective.skill) {
    e.skill = effective.skill;
  }

  if (entryNeedsSave) {
    persist(true, true);
  }

  $('home').classList.remove('active');$('progressScreen').classList.remove('active');$('practice').classList.add('active');
  if ($('navHome')) { $('navHome').classList.remove('active'); $('navProgress').classList.remove('active'); $('navPractice').classList.add('active'); }
  $('meta').textContent=effective.domain+' • '+effective.level;
  $('title').textContent=effective.id;$('question').textContent=effective.question;
  const pool=scenarios.filter(s=>s.domain===effective.domain&&s.level===effective.level);
  $('qno').textContent='Exercise '+effective.questionNo+' / '+pool.length;
  $('tags').textContent = (effective.skill ? `${effective.skill} • ` : '') + 'Think → Write → Validate';
  renderSchemaCards(effective.schemaText);
  currentSampleTable = null;
  setSchemaTab('schema');
  $('thinking').value=thinkingText(e.thinking);
  if ($('fiddleCopyConfirmation')) $('fiddleCopyConfirmation').textContent = '';
  renderAssessment(e.assessment?evaluateThinking(effective,e.thinking||{}):null);
  updateProgress();updateGates();
}

let authoritativeCompletedCount = 0;

function getGuestLifetimeCompletedCount() {
  try {
    const raw = storage.getItem('cracksql_guest_lifetime_completions');
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

function recordGuestCompletedScenario(scenarioId) {
  try {
    const raw = storage.getItem('cracksql_guest_lifetime_completions');
    const set = new Set(raw ? JSON.parse(raw) : []);
    set.add(scenarioId);
    storage.setItem('cracksql_guest_lifetime_completions', JSON.stringify(Array.from(set)));
  } catch {}
}

function getCompletedCount() {
  const localCount = (scenarios && scenarios.length && state && state.entries)
    ? scenarios.filter(s => isCompleted(s, state.entries[s.id])).length
    : 0;
  if (!user) {
    return Math.max(localCount, getGuestLifetimeCompletedCount());
  }
  return Math.max(authoritativeCompletedCount, localCount);
}

function showAccessCheckError(msg) {
  let errBanner = $('accessErrorBanner');
  if (!errBanner) {
    errBanner = document.createElement('div');
    errBanner.id = 'accessErrorBanner';
    errBanner.className = 'access-error-banner';
    errBanner.style.cssText = 'background:#fef2f2; border:1px solid #fecaca; color:#991b1b; padding:10px 14px; border-radius:8px; margin:10px auto; max-width:960px; display:flex; align-items:center; justify-content:space-between; font-size:13.5px; z-index:100;';
    const main = $('appMain');
    if (main) main.insertBefore(errBanner, main.firstChild);
  }
  errBanner.style.display = 'flex';
  errBanner.innerHTML = `
    <span>⚠️ ${escapeHtml(msg || 'Unable to verify account access status. Access features may be limited.')}</span>
    <button class="action secondary sm" onclick="window.retryUserAccessCheck ? window.retryUserAccessCheck() : window.location.reload()" style="margin-left:12px; padding:4px 10px; font-size:12px; white-space:nowrap; cursor:pointer;">
      🔄 Retry
    </button>
  `;
}

function hideAccessError() {
  const errBanner = $('accessErrorBanner');
  if (errBanner) errBanner.style.display = 'none';
}

async function retryUserAccessCheck() {
  hideAccessError();
  if (user && client) {
    await checkAdminStatus();
    await checkUserAccessStatus(user.id);
    renderScenarioCatalog();
    if (current) renderScenario();
    void initContest(client, user, getCompletedCount(), isCurrentUserAdmin);
  }
}

async function checkUserAccessStatus(userId) {
  const uid = userId || user?.id;
  if (!uid || !client) return;

  try {
    const activeUser = (user && user.id === uid) ? user : (await client.auth.getUser())?.data?.user;
    const userEmail = activeUser?.email || '';

    // Helper to query the profile row from public.profiles using the current authenticated user ID
    // Premium entitlement is authoritatively determined from profiles.paid_unlocked === true
    async function fetchProfile() {
      try {
        const { data, error } = await client
          .from('profiles')
          .select('id, email, username, is_admin, paid_unlocked')
          .eq('id', uid)
          .maybeSingle();

        if (!error && data) return { profile: data, error: null };
        if (!error && !data) return { profile: null, error: null };
        console.warn('[Access] Profiles select notice:', error?.message || error);
      } catch (ex) {
        console.warn('[Access] Profiles select exception:', ex);
      }

      // Fallback: minimal columns (id, email, paid_unlocked)
      try {
        const { data: minData, error: minErr } = await client
          .from('profiles')
          .select('id, email, paid_unlocked')
          .eq('id', uid)
          .maybeSingle();

        if (!minErr) return { profile: minData, error: null };
        return { profile: null, error: minErr };
      } catch (ex2) {
        return { profile: null, error: ex2 };
      }
    }

    let { profile, error: profErr } = await fetchProfile();

    // If profile does not exist: create profile using existing profile system (authenticated user ID and email)
    if (!profile && !profErr) {
      console.log('[Access] No profile row found for user; creating profile row for', uid);
      try {
        const { error: insErr } = await client
          .from('profiles')
          .insert({
            id: uid,
            email: userEmail,
            last_active: new Date().toISOString()
          });
        if (insErr) {
          console.warn('[Access] Insert profile error:', insErr.message || insErr);
        }
      } catch (insEx) {
        console.warn('[Access] Insert profile exception:', insEx);
      }

      // Then load the profile again
      const recheck = await fetchProfile();
      profile = recheck.profile;
      profErr = recheck.error;
    }

    // If the profile exists:
    // - Load username.
    // - Load is_admin.
    // - Continue into the app normally.
    // - Do not show the profile verification error.
    if (profile) {
      hideAccessError();

      // Load username (do not overwrite existing username with empty value)
      const dbUsername = (profile.username || '').trim();
      if (dbUsername) {
        currentUsername = dbUsername;
        try { localStorage.setItem(`cracksql_username_${uid}`, dbUsername); } catch (e) {}
        renderProfileAvatar();
        renderAuth();
      } else if (!currentUsername) {
        const cached = localStorage.getItem(`cracksql_username_${uid}`);
        if (cached) {
          currentUsername = cached.trim();
          renderProfileAvatar();
          renderAuth();
        }
      }

      // Load is_admin normally
      if (profile.is_admin === true) {
        isCurrentUserAdmin = true;
        updateAdminPortalVisibility();
      }
    } else if (isCurrentUserAdmin) {
      // If user is already verified admin (e.g. from admin_users table), never block them with an error
      hideAccessError();
    } else if (profErr) {
      console.warn('[Access] Could not verify account profile:', profErr.message || profErr);
      showAccessCheckError('Could not verify account profile. Click Retry to check again.');
    }

    // 1. Authoritative Premium Entitlement: determined strictly from profiles.paid_unlocked === true
    if (profile && profile.paid_unlocked === true) {
      isPaidUnlocked = true;
      userPendingPayment = null;
    } else {
      isPaidUnlocked = false;
    }

    // 2. Check for pending payment submissions (for user feedback/status notice only)
    if (!isPaidUnlocked) {
      try {
        const { data: payments } = await client
          .from('payments')
          .select('*')
          .eq('user_id', uid)
          .order('submitted_at', { ascending: false })
          .limit(1);

        if (payments && payments.length > 0) {
          const latestPay = payments[0];
          const s = String(latestPay.status || '').toUpperCase();
          if (s === 'PENDING') {
            userPendingPayment = latestPay;
          }
        }
      } catch (payEx) {
        console.warn('[Access] Payments check notice:', payEx);
      }
    }

    // After login or refresh: if paid_unlocked === true -> premium access unlocked automatically
    // and the user must not see the ₹49 payment popup again.
    if (isPaidUnlocked) {
      closePaywallModal();
      updateGates();
      updateProgress();
      renderScenarioCatalog();
      renderAuth();
    }

    const currentCompleted = getCompletedCount();

    // Authoritatively sync profile last_active / background sync safely
    try {
      const { data: syncRes, error: syncErr } = await client.rpc('sync_user_progress');
      if (!syncErr && syncRes && typeof syncRes.completed_count === 'number') {
        authoritativeCompletedCount = syncRes.completed_count;
      }
    } catch (e) {
      try {
        await client.from('profiles').update({
          last_active: new Date().toISOString()
        }).eq('id', uid);
      } catch (updErr) {
        // Safe ignore
      }
    }

    void initContest(client, user, getCompletedCount(), isCurrentUserAdmin);
  } catch (err) {
    console.warn('checkUserAccessStatus warning:', err);
    if (!isCurrentUserAdmin && !currentUsername && !isPaidUnlocked) {
      showAccessCheckError('Could not verify account profile. Click Retry to check again.');
    }
  }
}

let paymentPollingTimer = null;

function startPaymentPolling() {
  if (paymentPollingTimer) clearInterval(paymentPollingTimer);
  paymentPollingTimer = setInterval(async () => {
    if (!user || isPaidUnlocked || isCurrentUserAdmin) {
      stopPaymentPolling();
      return;
    }
    if (userPendingPayment && userPendingPayment.status === 'pending') {
      await checkPaymentStatusSilently(false);
    }
  }, 10000);
}

function stopPaymentPolling() {
  if (paymentPollingTimer) {
    clearInterval(paymentPollingTimer);
    paymentPollingTimer = null;
  }
}

async function checkPaymentStatusSilently(isUserAction = false) {
  if (!client || !user) return;
  const btn = $('submitPaymentBtn');
  if (isUserAction && btn) {
    btn.disabled = true;
    btn.textContent = 'Checking status…';
  }

  try {
    // 1. Authoritative check on public.profiles.paid_unlocked
    const { data: prof, error: profErr } = await client
      .from('profiles')
      .select('paid_unlocked')
      .eq('id', user.id)
      .maybeSingle();

    if (!profErr && prof && prof.paid_unlocked === true) {
      isPaidUnlocked = true;
      userPendingPayment = null;
      stopPaymentPolling();
      closePaywallModal();
      updateGates();
      updateProgress();
      if (current) renderScenario();
      renderScenarioCatalog();
      updateAdminPortalVisibility();
      renderAuth();
      return;
    }

    // 2. Check latest payment in payments table for pending status notice only
    const { data: payments } = await client
      .from('payments')
      .select('*')
      .eq('user_id', user.id)
      .order('submitted_at', { ascending: false })
      .limit(1);

    if (payments && payments.length > 0) {
      const latest = payments[0];
      const s = String(latest.status || '').toUpperCase();
      if (s === 'PENDING') {
        userPendingPayment = latest;
      }
    }

    if (isUserAction) {
      openPaywallModal();
    }
  } catch (err) {
    console.warn('checkPaymentStatusSilently notice:', err);
    if (isUserAction) {
      const notice = $('paywallNotice');
      if (notice) {
        notice.style.display = 'block';
        notice.style.background = '#fee2e2';
        notice.style.border = '1px solid #fca5a5';
        notice.style.color = '#991b1b';
        notice.innerHTML = `<strong>Connection Error:</strong> Could not refresh payment status. Please retry.`;
      }
    }
  } finally {
    if (isUserAction && btn && (!userPendingPayment || userPendingPayment.status !== 'verified')) {
      btn.disabled = false;
      if (userPendingPayment?.status === 'pending') {
        btn.textContent = 'Refresh Payment Status 🔄';
      }
    }
  }
}

async function handleScenarioCompleted(scenarioId, thinkingResponse = '', score = 0) {
  if (!scenarioId || !ids.has(scenarioId)) {
    console.warn('Unrecognized or invalid scenario ID:', scenarioId);
    return;
  }

  if (user && client) {
    try {
      // 1. Authoritative recording via record_scenario_completion RPC
      const { data: recRes, error: rpcErr } = await client.rpc('record_scenario_completion', {
        p_scenario_id: scenarioId,
        p_thinking_response: thinkingResponse || 'Reasoning validated',
        p_score: score >= 7 ? score : 7
      });

      if (!rpcErr && recRes) {
        if (typeof recRes.completed_count === 'number') {
          authoritativeCompletedCount = recRes.completed_count;
        }
        if (typeof recRes.paid_unlocked === 'boolean') {
          isPaidUnlocked = recRes.paid_unlocked;
        }
        changeEntry({
          completed: true,
          status: 'completed',
          syncPending: false,
          syncStatus: 'synced'
        }, false);
        if ($('syncStatus')) $('syncStatus').textContent = 'Progress synced';

        const completedCount = getCompletedCount();
        void initContest(client, user, completedCount, isCurrentUserAdmin);

        if (completedCount >= 5 && !isPaidUnlocked && !isCurrentUserAdmin) {
          openPaywallModal();
        }
        updateProgress();
        renderScenarioCatalog();
        return;
      }

      if (rpcErr) {
        console.warn('record_scenario_completion RPC notice:', rpcErr.message || rpcErr);
        if (String(rpcErr.message || '').includes('Free limit reached')) {
          changeEntry({
            completed: false,
            status: 'attempted',
            syncPending: false,
            syncStatus: 'limit_reached'
          }, false);
          openPaywallModal();
          updateProgress();
          renderScenarioCatalog();
          return;
        }
        // Connection or temporary failure: preserve local draft
        changeEntry({
          syncPending: true,
          syncStatus: 'pending'
        }, false);
        if ($('syncStatus')) {
          $('syncStatus').textContent = 'Saved on this device. Pending cloud sync...';
        }
      }
    } catch (err) {
      console.warn('handleScenarioCompleted persistence notice:', err);
      changeEntry({
        syncPending: true,
        syncStatus: 'pending'
      }, false);
      if ($('syncStatus')) {
        $('syncStatus').textContent = 'Saved on this device. Pending cloud sync...';
      }
    }
  } else {
    // Guest user: track lifetime completed scenarios so resets never grant extra free questions
    recordGuestCompletedScenario(scenarioId);
    const completedCount = getCompletedCount();
    if (completedCount >= 5 && !isPaidUnlocked && !isCurrentUserAdmin) {
      openPaywallModal();
    }
  }
}

function openPaywallModal() {
  if (isPaidUnlocked || isCurrentUserAdmin) {
    closePaywallModal();
    return;
  }

  const modal = $('paywallModal');
  if (!modal) return;
  modal.hidden = false;

  const notice = $('paywallNotice');
  const payBtn = $('paywallPayBtn');

  // State: Admin Exemption
  if (isCurrentUserAdmin) {
    if (notice) {
      notice.style.display = 'block';
      notice.style.background = '#e0f2fe';
      notice.style.color = '#0369a1';
      notice.innerHTML = '<strong>Admin access — payment exempt</strong><br><span style="font-size:0.85rem;">As an administrator, you have full access to all practice questions without payment.</span>';
    }
    if (payBtn) payBtn.style.display = 'none';
    return;
  }

  // State: Verified / Access Unlocked
  if (isPaidUnlocked) {
    if (notice) {
      notice.style.display = 'block';
      notice.style.background = '#dcfce7';
      notice.style.border = '1px solid #86efac';
      notice.style.color = '#15803d';
      notice.innerHTML = '<strong>✓ Access Unlocked!</strong> You have full lifetime access to all 420 challenges.';
    }
    if (payBtn) {
      payBtn.style.display = 'block';
      payBtn.disabled = false;
      payBtn.textContent = 'Continue Practice (Question 6+) →';
      payBtn.onclick = () => {
        closePaywallModal();
        if (current) renderScenario();
        renderScenarioCatalog();
      };
    }
    return;
  }

  // State: Initial Payment Required
  if (notice) notice.style.display = 'none';
  if (payBtn) {
    payBtn.style.display = 'inline-flex';
    payBtn.disabled = false;
    payBtn.innerHTML = '<span>Pay ₹49</span>';
    payBtn.onclick = payCourseUnlockWithRazorpay;
  }
}

function closePaywallModal() {
  const modal = $('paywallModal');
  if (modal) modal.hidden = true;
}

function loadRazorpaySdk() {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src*="checkout.razorpay.com"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.Razorpay));
      existing.addEventListener('error', () => reject(new Error('Failed to load Razorpay SDK')));
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve(window.Razorpay);
    script.onerror = () => reject(new Error('Failed to load Razorpay SDK'));
    document.head.appendChild(script);
  });
}

async function payCourseUnlockWithRazorpay() {
  const notice = $('paywallNotice');
  const payBtn = $('paywallPayBtn');

  if (!user) {
    if (notice) {
      notice.style.display = 'block';
      notice.style.background = '#fee2e2';
      notice.style.border = '1px solid #fca5a5';
      notice.style.color = '#991b1b';
      notice.innerHTML = 'Please sign in first to unlock full access.';
    }
    const authModal = $('authModal');
    if (authModal) authModal.hidden = false;
    return;
  }

  if (payBtn) {
    payBtn.disabled = true;
    payBtn.textContent = 'Creating order…';
  }

  try {
    // 1. Call create-razorpay-order
    const { data, error } = await client.functions.invoke('create-razorpay-order', {
      body: { contest_id: 'course_unlock' }
    });

    if (error) {
      let safeMsg = error.message || 'Failed to create payment order.';
      let corrId = '';
      if (error.context) {
        try {
          const bodyJson = typeof error.context.json === 'function' ? await error.context.json() : JSON.parse(await error.context.text());
          if (bodyJson?.error) safeMsg = bodyJson.error;
          if (bodyJson?.correlation_id) corrId = bodyJson.correlation_id;
        } catch (_) {}
      }
      if (safeMsg && safeMsg.includes('non-2xx')) {
        safeMsg = 'Payment service unavailable. Please try again.';
      }
      throw new Error(safeMsg + (corrId ? ` (Ref: ${corrId})` : ''));
    }

    if (!data || !data.order_id || !data.key_id) {
      throw new Error(data?.error || data?.message || 'Invalid order response received.');
    }

    // 2. Load Razorpay Checkout SDK
    const RazorpaySDK = await loadRazorpaySdk();
    if (!RazorpaySDK) {
      throw new Error('Could not load Razorpay Checkout SDK.');
    }

    // 3. Open Razorpay Checkout
    const rzp = new RazorpaySDK({
      key: data.key_id,
      amount: data.amount || 4900,
      currency: data.currency || 'INR',
      name: 'Think and Crack SQL',
      description: 'Premium Unlock - Lifetime Access',
      order_id: data.order_id,
      prefill: {
        email: user.email || '',
        name: user.user_metadata?.name || user.user_metadata?.full_name || ''
      },
      theme: {
        color: '#2563eb'
      },
      handler: async function (response) {
        if (!response || !response.razorpay_payment_id || !response.razorpay_signature) {
          if (notice) {
            notice.style.display = 'block';
            notice.style.background = '#fee2e2';
            notice.style.border = '1px solid #fca5a5';
            notice.style.color = '#991b1b';
            notice.textContent = 'Payment response incomplete from Razorpay.';
          }
          return;
        }

        if (payBtn) {
          payBtn.disabled = true;
          payBtn.textContent = 'Verifying payment…';
        }

        try {
          // 4. Call verify-razorpay-payment
          const { data: verifyData, error: verifyErr } = await client.functions.invoke('verify-razorpay-payment', {
            body: {
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
              contest_id: 'course_unlock'
            }
          });

          if (verifyErr) {
            let safeMsg = verifyErr.message || 'Payment verification failed on server.';
            let corrId = '';
            if (verifyErr.context) {
              try {
                const bodyJson = typeof verifyErr.context.json === 'function' ? await verifyErr.context.json() : JSON.parse(await verifyErr.context.text());
                if (bodyJson?.error) safeMsg = bodyJson.error;
                if (bodyJson?.correlation_id) corrId = bodyJson.correlation_id;
              } catch (_) {}
            }
            if (safeMsg && safeMsg.includes('non-2xx')) {
              safeMsg = 'Payment verification could not be completed by the server.';
            }
            throw new Error(safeMsg + (corrId ? ` (Ref: ${corrId})` : ''));
          }

          if (!verifyData || !verifyData.success) {
            throw new Error(verifyData?.error || verifyData?.message || 'Payment verification failed.');
          }

          // 5. Authoritatively reload user access status from database
          await checkUserAccessStatus(user.id);
          isPaidUnlocked = true;

          if (notice) {
            notice.style.display = 'block';
            notice.style.background = '#dcfce7';
            notice.style.border = '1px solid #86efac';
            notice.style.color = '#15803d';
            notice.innerHTML = '<strong>✓ Payment Successful!</strong> Premium lifetime access unlocked.';
          }

          if (payBtn) {
            payBtn.disabled = false;
            payBtn.textContent = 'Continue Practice (Question 6+) →';
            payBtn.onclick = () => {
              closePaywallModal();
              if (current) renderScenario();
              renderScenarioCatalog();
            };
          }

          if (typeof renderScenarioCatalog === 'function') {
            renderScenarioCatalog();
          }
          if (typeof updatePaywallUI === 'function') {
            updatePaywallUI();
          }
        } catch (vErr) {
          console.error('[Course Payment] Verification error:', vErr);
          const errStr = String(vErr.message || '').toLowerCase();
          const isPending = errStr.includes('pending') ||
                            errStr.includes('provider_lookup_failed') ||
                            errStr.includes('gateway_network_error');

          if (notice) {
            notice.style.display = 'block';
            if (isPending) {
              notice.style.background = '#fef3c7';
              notice.style.border = '1px solid #fcd34d';
              notice.style.color = '#92400e';
              notice.innerHTML = `<strong>Payment received; verification pending.</strong><br><span style="font-size:0.85rem;">Your payment was recorded, but server confirmation is still finalizing. Click below to recheck your status without making a duplicate payment.</span>`;
            } else {
              notice.style.background = '#fee2e2';
              notice.style.border = '1px solid #fca5a5';
              notice.style.color = '#991b1b';
              notice.innerHTML = `<strong>Verification Error:</strong> ${escapeHtml(vErr.message || 'Verification could not be confirmed.')}`;
            }
          }

          if (payBtn) {
            if (isPending) {
              payBtn.disabled = false;
              payBtn.textContent = 'Check Payment Status 🔄';
              payBtn.onclick = () => checkPaymentStatusSilently(true);
            }
          }
        } finally {
          if (payBtn && !isPaidUnlocked && !payBtn.textContent.includes('Check Payment Status')) {
            payBtn.disabled = false;
            payBtn.innerHTML = '<span>Pay ₹49</span>';
          }
        }
      }
    });

    rzp.open();
  } catch (err) {
    console.error('[Course Payment] Order error:', err);
    if (notice) {
      notice.style.display = 'block';
      notice.style.background = '#fee2e2';
      notice.style.border = '1px solid #fca5a5';
      notice.style.color = '#991b1b';
      notice.innerHTML = `<strong>Order Error:</strong> ${escapeHtml(err.message || 'Failed to start payment.')}`;
    }
  } finally {
    if (payBtn && !isPaidUnlocked && !payBtn.textContent.includes('Check Payment Status')) {
      payBtn.disabled = false;
      payBtn.innerHTML = '<span>Pay ₹49</span>';
    }
  }
}

window.payCourseUnlockWithRazorpay = payCourseUnlockWithRazorpay;

function loadScenario() {
  if(!selectedDomain||!selectedLevel) return;
  const pool=scenarios.filter(s=>s.domain===selectedDomain&&s.level===selectedLevel);
  const next=chooseNext(pool,state,null)||pool[0];
  if(next) {
    const isTargetCompleted = isCompleted(next, state.entries[next.id]);
    const completedCount = getCompletedCount();
    if (!isTargetCompleted && completedCount >= 5 && !isPaidUnlocked && !isCurrentUserAdmin) {
      const completedCandidate = pool.find(s => isCompleted(s, state.entries[s.id])) || scenarios.find(s => isCompleted(s, state.entries[s.id]));
      if (completedCandidate) {
        current = completedCandidate;
        renderScenario();
      }
      openPaywallModal();
      return;
    }
    current=next;
    renderScenario();
  }
}
function selectDomain(domain,el) {
  selectedDomain=domain;
  document.querySelectorAll('.domain').forEach(x=>x.classList.toggle('active',x===el));
  renderScenarioCatalog();
  loadScenario();
}
function selectLevel(level,el) {
  selectedLevel=level;
  document.querySelectorAll('.level').forEach(x=>x.classList.toggle('active',x===el));
  renderScenarioCatalog();
  loadScenario();
}
function evaluatePlan() {
  if(!current) return;
  const effective = getEffectiveScenario(current, user?.id || 'guest_user', state);
  const thinking = readThinking();
  const assessment = evaluateThinking(effective, thinking);
  const score = typeof assessment?.score === 'number' ? assessment.score : 0;
  const completed = score >= 7;
  const curAttempts = (entry().attempts || 0) + 1;
  const status = completed ? 'completed' : 'attempted';
  changeEntry({
    thinking,
    assessment,
    completed,
    status,
    attempts: curAttempts,
    variantIndex: effective.variantIndex,
    skill: effective.skill
  }, true);
  renderAssessment(assessment);
  updateGates();

  // Handle completion tracking and paywall/eligibility gates
  if (completed) {
    void handleScenarioCompleted(current.id, thinking.response, score);
  }

  openMotivationPopup(score);
}

const MOTIVATION_STATES = {
  5: {
    scoreDisplay: '5 / 10',
    title: 'Keep Going!',
    subtitle: "You're on the right track!",
    tip: 'A little more thinking will make it even better!',
    theme: {
      scoreColor: '#ea580c',
      titleColor: '#ea580c',
      tipBg: '#fff7ed',
      tipBorder: '#ffedd5',
      tipText: '#9a3412',
      cardBorder: '#fdba74',
      cardGlow: '0 0 35px rgba(249, 115, 22, 0.28), 0 20px 45px rgba(15, 23, 42, 0.18)',
      starColor: '#f97316'
    },
    showNext: false
  },
  6: {
    scoreDisplay: '6 / 10',
    title: 'Getting Better!',
    subtitle: "You're making progress!",
    tip: 'Try to explain a bit more for an even stronger answer!',
    theme: {
      scoreColor: '#d97706',
      titleColor: '#d97706',
      tipBg: '#fefce8',
      tipBorder: '#fef08a',
      tipText: '#854d0e',
      cardBorder: '#fde047',
      cardGlow: '0 0 35px rgba(245, 158, 11, 0.28), 0 20px 45px rgba(15, 23, 42, 0.18)',
      starColor: '#f59e0b'
    },
    showNext: false
  },
  7: {
    scoreDisplay: '7 / 10',
    title: 'Good Job!',
    subtitle: 'Well thought out!',
    tip: 'Nice thinking! Keep this level and aim higher!',
    theme: {
      scoreColor: '#15803d',
      titleColor: '#15803d',
      tipBg: '#f0fdf4',
      tipBorder: '#bbf7d0',
      tipText: '#166534',
      cardBorder: '#86efac',
      cardGlow: '0 0 35px rgba(34, 197, 94, 0.28), 0 20px 45px rgba(15, 23, 42, 0.18)',
      starColor: '#22c55e'
    },
    showNext: true
  },
  8: {
    scoreDisplay: '8 / 10',
    title: 'Great Thinking!',
    subtitle: "You're doing really well!",
    tip: 'Clear and logical thinking! Keep it up!',
    theme: {
      scoreColor: '#0284c7',
      titleColor: '#1d4ed8',
      tipBg: '#f0f9ff',
      tipBorder: '#bae6fd',
      tipText: '#0369a1',
      cardBorder: '#7dd3fc',
      cardGlow: '0 0 35px rgba(14, 165, 233, 0.32), 0 20px 45px rgba(15, 23, 42, 0.18)',
      starColor: '#38bdf8'
    },
    showNext: true
  },
  9: {
    scoreDisplay: '9 / 10',
    title: 'Excellent Work!',
    subtitle: "You're almost there!",
    tip: 'Very strong thinking! Just a bit more to reach perfection!',
    theme: {
      scoreColor: '#7c3aed',
      titleColor: '#6d28d9',
      tipBg: '#faf5ff',
      tipBorder: '#e9d5ff',
      tipText: '#6b21a8',
      cardBorder: '#d8b4fe',
      cardGlow: '0 0 35px rgba(147, 51, 234, 0.32), 0 20px 45px rgba(15, 23, 42, 0.18)',
      starColor: '#a855f7'
    },
    showNext: true
  },
  10: {
    scoreDisplay: '10 / 10',
    title: 'Perfect!',
    subtitle: 'Outstanding Thinking!',
    tip: "Amazing! You've got a clear and complete understanding!",
    theme: {
      scoreColor: '#d97706',
      titleColor: '#b45309',
      tipBg: '#fefce8',
      tipBorder: '#fef08a',
      tipText: '#92400e',
      cardBorder: '#fde047',
      cardGlow: '0 0 45px rgba(245, 158, 11, 0.42), 0 20px 45px rgba(15, 23, 42, 0.18)',
      starColor: '#fbbf24'
    },
    showNext: true
  }
};

function getMotivationMascotSvg(score) {
  if (score >= 10) {
    return `<svg viewBox="0 0 120 120" width="115" height="115" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="18" y="32" width="5" height="5" rx="1" fill="#EF4444" transform="rotate(25 18 32)"/>
      <rect x="98" y="24" width="5" height="5" rx="1" fill="#3B82F6" transform="rotate(40 98 24)"/>
      <circle cx="26" cy="54" r="2.5" fill="#22C55E"/>
      <circle cx="102" cy="48" r="3" fill="#F59E0B"/>
      <path d="M12 42L14 38L16 42L20 43.5L16 45L14 49L12 45L8 43.5L12 42Z" fill="#FBBF24"/>
      <path d="M96 68L97.5 64L99 68L103 69.5L99 71L97.5 75L96 71L92 69.5L96 68Z" fill="#FBBF24"/>
      <path d="M38 38L34 25L43 30L52 20L61 30L70 25L66 38H38Z" fill="#FBBF24" stroke="#0F172A" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="52" cy="20" r="2" fill="#EF4444"/>
      <circle cx="34" cy="25" r="1.5" fill="#3B82F6"/>
      <circle cx="70" cy="25" r="1.5" fill="#3B82F6"/>
      <path d="M30 84C22 66 30 46 54 46C74 46 84 64 78 84C76 94 66 98 54 98C42 98 34 94 30 84Z" fill="#FFFFFF" stroke="#0F172A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <ellipse cx="42" cy="99" rx="7" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
      <ellipse cx="66" cy="99" rx="7" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
      <ellipse cx="38" cy="69" rx="4.5" ry="3" fill="#FCA5A5"/>
      <ellipse cx="68" cy="69" rx="4.5" ry="3" fill="#FCA5A5"/>
      <path d="M38 59C40 56 44 56 46 59" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="62" cy="58" r="3.2" fill="#0F172A"/>
      <path d="M46 67C46 74 60 74 60 67Z" fill="#EF4444" stroke="#0F172A" stroke-width="2"/>
      <g transform="translate(68, 44)">
        <path d="M10 2C18 2 24 6 24 16C24 24 18 28 10 28C2 28 -4 24 -4 16C-4 6 2 2 10 2Z" fill="#FBBF24" stroke="#0F172A" stroke-width="2"/>
        <path d="M-4 6C-9 6 -11 12 -8 16C-6 19 -4 18 -4 18" stroke="#0F172A" stroke-width="2" stroke-linecap="round"/>
        <path d="M24 6C29 6 31 12 28 16C26 19 24 18 24 18" stroke="#0F172A" stroke-width="2" stroke-linecap="round"/>
        <rect x="8" y="28" width="4" height="6" fill="#F59E0B" stroke="#0F172A" stroke-width="1.5"/>
        <rect x="4" y="34" width="12" height="5" rx="1.5" fill="#D97706" stroke="#0F172A" stroke-width="2"/>
        <line x1="0" y1="8" x2="20" y2="8" stroke="#FEF08A" stroke-width="1.5" stroke-linecap="round"/>
      </g>
      <path d="M30 68C24 70 24 76 30 78" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
      <ellipse cx="68" cy="68" rx="4.5" ry="3.5" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
    </svg>`;
  } else if (score === 9) {
    return `<svg viewBox="0 0 120 120" width="115" height="115" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M60 12L62 18L68 20L62 22L60 28L58 22L52 20L58 18L60 12Z" fill="#A855F7"/>
      <path d="M26 28L28 34L34 36L28 38L26 44L24 38L18 36L24 34L26 28Z" fill="#F59E0B"/>
      <path d="M94 28L96 34L102 36L96 38L94 44L92 38L86 36L92 34L94 28Z" fill="#F59E0B"/>
      <circle cx="16" cy="62" r="3" fill="#C084FC"/>
      <circle cx="104" cy="62" r="3" fill="#C084FC"/>
      <path d="M34 82C26 62 34 42 60 42C86 42 94 62 86 82C82 92 72 96 60 96C48 96 38 92 34 82Z" fill="#FFFFFF" stroke="#0F172A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <ellipse cx="48" cy="97" rx="7" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
      <ellipse cx="72" cy="97" rx="7" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
      <ellipse cx="42" cy="68" rx="5" ry="3" fill="#FCA5A5"/>
      <ellipse cx="78" cy="68" rx="5" ry="3" fill="#FCA5A5"/>
      <path d="M48 52L50 58L56 60L50 62L48 68L46 62L40 60L46 58L48 52Z" fill="#F59E0B" stroke="#0F172A" stroke-width="1.2"/>
      <path d="M72 52L74 58L80 60L74 62L72 68L70 62L64 60L70 58L72 52Z" fill="#F59E0B" stroke="#0F172A" stroke-width="1.2"/>
      <ellipse cx="60" cy="68" rx="4.5" ry="5.5" fill="#EF4444" stroke="#0F172A" stroke-width="2"/>
      <ellipse cx="53" cy="80" rx="5.5" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
      <ellipse cx="67" cy="80" rx="5.5" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
    </svg>`;
  } else if (score === 8) {
    return `<svg viewBox="0 0 120 120" width="115" height="115" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M60 10L62 16L68 18L62 20L60 26L58 20L52 18L58 16L60 10Z" fill="#38BDF8"/>
      <path d="M34 22L35.5 26L40 27.5L35.5 29L34 33L32.5 29L28 27.5L32.5 26L34 22Z" fill="#F59E0B"/>
      <path d="M86 22L87.5 26L92 27.5L87.5 29L86 33L84.5 29L80 27.5L84.5 26L86 22Z" fill="#F59E0B"/>
      <circle cx="22" cy="50" r="3" fill="#7DD3FC"/>
      <circle cx="98" cy="50" r="3" fill="#7DD3FC"/>
      <path d="M36 86C28 66 36 46 60 46C84 46 92 66 84 86C80 96 70 100 60 100C48 100 40 96 36 86Z" fill="#FFFFFF" stroke="#0F172A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <ellipse cx="48" cy="101" rx="7" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
      <ellipse cx="72" cy="101" rx="7" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
      <path d="M36 56C28 50 22 42 20 36C20 34 24 34 26 38L34 50" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M84 56C92 50 98 42 100 36C100 34 96 34 94 38L86 50" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5" stroke-linejoin="round"/>
      <ellipse cx="44" cy="71" rx="4.5" ry="3" fill="#FCA5A5"/>
      <ellipse cx="76" cy="71" rx="4.5" ry="3" fill="#FCA5A5"/>
      <path d="M46 62C48 59 52 59 54 62" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M66 62C68 59 72 59 74 62" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M52 69C52 76 68 76 68 69Z" fill="#EF4444" stroke="#0F172A" stroke-width="2"/>
    </svg>`;
  } else if (score === 7) {
    return `<svg viewBox="0 0 120 120" width="115" height="115" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18 42L20 36L22 42L28 44L22 46L20 52L18 46L12 44L18 42Z" fill="#4ADE80"/>
      <path d="M96 28L98 22L100 28L106 30L100 32L98 38L96 32L90 30L96 28Z" fill="#22C55E"/>
      <circle cx="28" cy="74" r="3" fill="#86EFAC"/>
      <circle cx="94" cy="68" r="2.5" fill="#FDE047"/>
      <path d="M40 84C32 64 40 42 64 42C86 42 94 64 88 84C86 94 76 98 64 98C50 98 42 94 40 84Z" fill="#FFFFFF" stroke="#0F172A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <ellipse cx="52" cy="99" rx="7" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
      <ellipse cx="76" cy="99" rx="7" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
      <ellipse cx="48" cy="69" rx="4.5" ry="3" fill="#FCA5A5"/>
      <ellipse cx="78" cy="69" rx="4.5" ry="3" fill="#FCA5A5"/>
      <circle cx="53" cy="59" r="3.2" fill="#0F172A"/>
      <circle cx="73" cy="59" r="3.2" fill="#0F172A"/>
      <path d="M57 68C57 73 69 73 69 68" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
      <g transform="translate(24, 58)">
        <path d="M16 14C12 14 8 12 6 8" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
        <ellipse cx="8" cy="10" rx="5" ry="4.5" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
        <path d="M8 8V2C8 0.5 6.5 0 5 0C3.5 0 3 1.5 3 3V8" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5" stroke-linejoin="round"/>
      </g>
      <path d="M88 72C92 74 94 78 91 82" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`;
  } else if (score === 6) {
    return `<svg viewBox="0 0 120 120" width="115" height="115" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M22 36L24 30L26 36L32 38L26 40L24 46L22 40L16 38L22 36Z" fill="#FBBF24"/>
      <path d="M30 75L31.5 71L33 75L37 76.5L33 78L31.5 82L30 78L26 76.5L30 75Z" fill="#F59E0B"/>
      <circle cx="88" cy="24" r="3" fill="#FDE047"/>
      <path d="M32 82C26 62 34 40 56 40C76 40 84 60 80 82C78 92 68 96 56 96C44 96 34 92 32 82Z" fill="#FFFFFF" stroke="#0F172A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <ellipse cx="44" cy="97" rx="7" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
      <ellipse cx="68" cy="97" rx="7" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
      <ellipse cx="40" cy="66" rx="4.5" ry="3" fill="#FCA5A5"/>
      <ellipse cx="66" cy="66" rx="4.5" ry="3" fill="#FCA5A5"/>
      <path d="M41 57C43 54 47 54 49 57" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="63" cy="56" r="3" fill="#0F172A"/>
      <path d="M49 66C49 71 57 71 57 66Z" fill="#EF4444" stroke="#0F172A" stroke-width="2"/>
      <path d="M32 70C28 72 28 77 34 78" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
      <g transform="rotate(-15 80 65)">
        <rect x="76" y="24" width="16" height="8" rx="3" fill="#F472B6" stroke="#0F172A" stroke-width="2"/>
        <rect x="76" y="32" width="16" height="6" fill="#94A3B8" stroke="#0F172A" stroke-width="2"/>
        <rect x="76" y="38" width="16" height="38" fill="#F59E0B" stroke="#0F172A" stroke-width="2"/>
        <line x1="81" y1="38" x2="81" y2="76" stroke="#D97706" stroke-width="1.5"/>
        <line x1="87" y1="38" x2="87" y2="76" stroke="#D97706" stroke-width="1.5"/>
        <polygon points="76,76 92,76 84,94" fill="#FDE68A" stroke="#0F172A" stroke-width="2"/>
        <polygon points="81,87 87,87 84,94" fill="#0F172A"/>
      </g>
      <ellipse cx="74" cy="70" rx="5" ry="4" fill="#FFFFFF" stroke="#0F172A" stroke-width="2.5"/>
    </svg>`;
  } else {
    // 5 / 10 and below
    return `<svg viewBox="0 0 120 120" width="115" height="115" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M60 6C54.5 6 50 10.5 50 16C50 19.5 52 22.5 55 24.5V28H65V24.5C68 22.5 70 19.5 70 16C70 10.5 65.5 6 60 6Z" fill="#FBBF24"/>
      <path d="M57 28H63V30C63 30.5 62.5 31 62 31H58C57.5 31 57 30.5 57 30V28Z" fill="#94A3B8"/>
      <circle cx="60" cy="16" r="4.5" fill="#FEF08A"/>
      <line x1="60" y1="2" x2="60" y2="0" stroke="#F59E0B" stroke-width="2" stroke-linecap="round"/>
      <line x1="48" y1="8" x2="45" y2="5" stroke="#F59E0B" stroke-width="2" stroke-linecap="round"/>
      <line x1="72" y1="8" x2="75" y2="5" stroke="#F59E0B" stroke-width="2" stroke-linecap="round"/>
      <line x1="43" y1="18" x2="40" y2="18" stroke="#F59E0B" stroke-width="2" stroke-linecap="round"/>
      <line x1="77" y1="18" x2="80" y2="18" stroke="#F59E0B" stroke-width="2" stroke-linecap="round"/>
      <path d="M36 78C32 64 38 46 60 46C82 46 88 64 84 78C82 85 76 88 60 88C44 88 38 85 36 78Z" fill="#FFFFFF" stroke="#0F172A" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <ellipse cx="46" cy="67" rx="4" ry="2.5" fill="#FCA5A5" opacity="0.8"/>
      <ellipse cx="74" cy="67" rx="4" ry="2.5" fill="#FCA5A5" opacity="0.8"/>
      <path d="M47 59C49 61 51 61 53 59" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M67 59C69 61 71 61 73 59" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M59 67H62" stroke="#0F172A" stroke-width="2" stroke-linecap="round"/>
      <path d="M37 54C37 54 35 57 35 58C35 59.1 35.9 60 37 60C38.1 60 39 59.1 39 58C39 57 37 54 37 54Z" fill="#38BDF8"/>
      <rect x="18" y="94" width="22" height="7" rx="2" fill="#0284C7" stroke="#0F172A" stroke-width="2"/>
      <rect x="19" y="87" width="20" height="7" rx="2" fill="#16A34A" stroke="#0F172A" stroke-width="2"/>
      <path d="M36 86L58 84V102L36 104Z" fill="#F97316" stroke="#0F172A" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M84 86L62 84V102L84 104Z" fill="#F97316" stroke="#0F172A" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M38 88L58 86V99L38 101Z" fill="#FFF7ED"/>
      <path d="M82 88L62 86V99L82 101Z" fill="#FFF7ED"/>
      <line x1="42" y1="91" x2="54" y2="90" stroke="#CBD5E1" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="42" y1="94" x2="52" y2="93" stroke="#CBD5E1" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="66" y1="90" x2="78" y2="91" stroke="#CBD5E1" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="68" y1="93" x2="78" y2="94" stroke="#CBD5E1" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M42 80L38 72L42 70" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round"/>
      <rect x="36" y="66" width="4" height="12" rx="1.5" transform="rotate(-30 36 66)" fill="#EAB308" stroke="#0F172A" stroke-width="1.5"/>
    </svg>`;
  }
}

function getPopupStarsHtml(color, isPerfect) {
  const star = (top, left, size, fill, opacity = 1) => `
    <svg style="position:absolute;top:${top};left:${left};pointer-events:none;opacity:${opacity};" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 0L14.9 8.5L24 12L14.9 15.5L12 24L9.1 15.5L0 12L9.1 8.5L12 0Z"/>
    </svg>
  `;
  let html = `
    ${star('-12px', '40px', '22', color, '0.9')}
    ${star('-8px', 'calc(50% - 11px)', '26', color, '1')}
    ${star('-14px', 'calc(100% - 55px)', '18', color, '0.85')}
    ${star('28px', '-10px', '16', color, '0.75')}
    ${star('34px', 'calc(100% - 6px)', '18', color, '0.8')}
    ${star('calc(100% - 35px)', '-8px', '14', color, '0.7')}
    ${star('calc(100% - 40px)', 'calc(100% - 4px)', '16', color, '0.75')}
  `;
  if (isPerfect) {
    html += `
      <span style="position:absolute;top:-10px;left:25%;width:6px;height:6px;background:#ef4444;border-radius:1px;transform:rotate(18deg);"></span>
      <span style="position:absolute;top:-6px;right:25%;width:6px;height:6px;background:#3b82f6;border-radius:1px;transform:rotate(45deg);"></span>
      <span style="position:absolute;top:50%;left:-12px;width:7px;height:5px;background:#22c55e;border-radius:1px;transform:rotate(30deg);"></span>
      <span style="position:absolute;top:60%;right:-10px;width:6px;height:6px;background:#ec4899;border-radius:1px;transform:rotate(12deg);"></span>
    `;
  }
  return html;
}

function openMotivationPopup(score) {
  const modal = $('motivationModal');
  if (!modal) return;

  const rawScore = typeof score === 'number' ? score : 0;
  const clampedScore = Math.max(0, Math.min(10, Math.round(rawScore)));
  const stateKey = clampedScore < 5 ? 5 : clampedScore;
  const config = MOTIVATION_STATES[stateKey] || MOTIVATION_STATES[5];

  const card = $('motivationCard');
  const mascot = $('motivationMascot');
  const scoreNum = $('motivationScoreNum');
  const title = $('motivationTitle');
  const subtitle = $('motivationSubtitle');
  const tipBox = $('motivationTipBox');
  const tipText = $('motivationTipText');
  const starsLayer = $('motivationStarsLayer');
  const retryBtn = $('motivationRetryBtn');
  const nextBtn = $('nextButton');

  // Compatibility elements
  if ($('motivationScoreBadge')) {
    $('motivationScoreBadge').textContent = `Thinking Score: ${clampedScore}/10`;
  }
  if ($('motivationMessage')) {
    $('motivationMessage').textContent = config.title;
  }

  // Mascot SVG illustration
  if (mascot) {
    mascot.innerHTML = getMotivationMascotSvg(clampedScore);
  }

  // Score display
  if (scoreNum) {
    scoreNum.textContent = clampedScore < 5 ? `${clampedScore} / 10` : config.scoreDisplay;
    scoreNum.style.color = config.theme.scoreColor;
  }

  // Title
  if (title) {
    title.textContent = config.title;
    title.style.color = config.theme.titleColor;
  }

  // Subtitle
  if (subtitle) {
    subtitle.textContent = config.subtitle;
  }

  // Tip box
  if (tipBox && tipText) {
    tipText.textContent = config.tip;
    tipBox.style.background = config.theme.tipBg;
    tipBox.style.border = `1px solid ${config.theme.tipBorder}`;
    tipBox.style.color = config.theme.tipText;
  }

  // Card border & colored outer glow matching reference image
  if (card) {
    card.style.border = `2px solid ${config.theme.cardBorder}`;
    card.style.boxShadow = config.theme.cardGlow;
  }

  // Stars & decorative layer
  if (starsLayer) {
    starsLayer.innerHTML = getPopupStarsHtml(config.theme.starColor, clampedScore === 10);
  }

  // Retry is shown for every score (full-width if alone, half-width if next is shown)
  if (retryBtn) {
    retryBtn.hidden = false;
    retryBtn.style.display = 'inline-flex';
  }

  // Next Scenario is shown only for scores 7, 8, 9, 10
  if (nextBtn) {
    if (config.showNext && clampedScore >= 7) {
      nextBtn.hidden = false;
      nextBtn.style.display = 'inline-flex';
      nextBtn.disabled = false;

      // Check if this completion marks all 20 scenarios complete in this domain and level
      const pool = scenarios.filter(s => s.domain === selectedDomain && s.level === selectedLevel);
      const isLevelComplete = pool.length > 0 && pool.every(s => isCompleted(s, state.entries[s.id]));
      if (isLevelComplete) {
        nextBtn.innerHTML = `<span>Complete Level & View Certificate</span> <span class="btn-icon">🏆</span>`;
      } else {
        nextBtn.innerHTML = `<span>Next Scenario</span> <span class="btn-icon">→</span>`;
      }
    } else {
      nextBtn.hidden = true;
      nextBtn.style.display = 'none';
      nextBtn.disabled = true;
    }
  }

  modal.hidden = false;
}

function closeMotivationModal() {
  const modal = $('motivationModal');
  if (modal) modal.hidden = true;
}

function handleMotivationRetry() {
  closeMotivationModal();
  const input = $('thinking');
  if (input) {
    input.focus();
  }
}

function handleMotivationNext() {
  closeMotivationModal();
  nextScenario();
}

function nextScenario() {
  closeMotivationModal();
  const e = entry();
  const thinkingScore = typeof e.assessment?.score === 'number' ? e.assessment.score : 0;
  if (!current || thinkingScore < 7) {
    return;
  }

  // Paywall check: After Question 5 completed, do not unlock Question 6 for unpaid learner (Admins exempt)
  const completedCount = getCompletedCount();
  if (completedCount >= 5 && !isPaidUnlocked && !isCurrentUserAdmin) {
    openPaywallModal();
    return;
  }

  const pool = scenarios.filter(s => s.domain === selectedDomain && s.level === selectedLevel);
  if (!pool.length) return;
  const currentIndex = pool.findIndex(s => s.id === current.id);
  let next = null;
  for (let i = 1; i < pool.length; i++) {
    const candidate = pool[(currentIndex + i) % pool.length];
    const candidateEntry = state.entries[candidate.id];
    const candidateCompleted = isCompleted(candidate, candidateEntry);
    if (!candidateCompleted) {
      next = candidate;
      break;
    }
  }

  // LEVEL COMPLETION: If all 20 scenarios are completed, DO NOT reset to Question 1!
  // Permanently mark domain/level completed and display the achievement screen.
  if (!next) {
    const allCompleted = pool.every(s => isCompleted(s, state.entries[s.id]));
    if (allCompleted) {
      openLevelCompletionModal(selectedDomain, selectedLevel);
      return;
    }
    next = pool.find(s => !isCompleted(s, state.entries[s.id]));
    if (!next) {
      openLevelCompletionModal(selectedDomain, selectedLevel);
      return;
    }
  }

  current = next;
  renderScenario();
}

let currentCertificateTarget = null;

function openLevelCompletionModal(domain, level) {
  closeMotivationModal();
  domain = domain || selectedDomain || 'Banking';
  level = level || selectedLevel || 'Beginner';
  
  const status = checkLevelCompletion(domain, level, scenarios, state);
  const learnerName = getLearnerDisplayName(user, currentUsername);
  
  currentCertificateTarget = {
    domain,
    level,
    userName: learnerName,
    completionDate: status.completionDate || formatCompletionDate(Date.now())
  };

  const modal = $('levelCompletionModal');
  if (!modal) return;

  if ($('levelCompletionTitle')) {
    $('levelCompletionTitle').textContent = `${level} Level Completed`;
  }
  if ($('levelCompletionSubtitle')) {
    $('levelCompletionSubtitle').textContent = `You have successfully completed all 20 scenarios in ${domain}.`;
  }
  if ($('levelCompletionDomainVal')) {
    $('levelCompletionDomainVal').textContent = domain;
  }
  if ($('levelCompletionDateVal')) {
    $('levelCompletionDateVal').textContent = currentCertificateTarget.completionDate;
  }

  // Setup Next Level buttons
  const navRow = $('levelCompletionNavRow');
  if (navRow) {
    if (level === 'Beginner') {
      navRow.innerHTML = `
        <button class="action primary" style="width:100%;padding:11px;font-size:14px;font-weight:700;" onclick="startNextLevel('${domain}','Intermediate')">
          Start Intermediate Level →
        </button>
      `;
    } else if (level === 'Intermediate') {
      navRow.innerHTML = `
        <button class="action primary" style="width:100%;padding:11px;font-size:14px;font-weight:700;" onclick="startNextLevel('${domain}','Expert')">
          Start Expert Level →
        </button>
      `;
    } else if (level === 'Expert') {
      const begComp = checkLevelCompletion(domain, 'Beginner', scenarios, state).isCompleted;
      const intComp = checkLevelCompletion(domain, 'Intermediate', scenarios, state).isCompleted;
      const allThreeDone = begComp && intComp;

      if (allThreeDone) {
        navRow.innerHTML = `
          <div style="background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46;padding:10px 14px;border-radius:12px;font-size:13.5px;font-weight:700;">
            🌟 All three levels completed in ${domain}!
          </div>
        `;
      } else {
        const remaining = [];
        if (!begComp) remaining.push(`<button class="action secondary" style="flex:1;padding:9px;font-size:13px;" onclick="startNextLevel('${domain}','Beginner')">Start Beginner</button>`);
        if (!intComp) remaining.push(`<button class="action secondary" style="flex:1;padding:9px;font-size:13px;" onclick="startNextLevel('${domain}','Intermediate')">Start Intermediate</button>`);
        navRow.innerHTML = `
          <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Remaining levels in ${domain}:</div>
          <div style="display:flex;gap:8px;">${remaining.join('')}</div>
        `;
      }
    }
  }

  modal.hidden = false;
}

function closeLevelCompletionModal() {
  const modal = $('levelCompletionModal');
  if (modal) modal.hidden = true;
}

function handleViewCertificateFromAchievement() {
  closeLevelCompletionModal();
  if (currentCertificateTarget) {
    openCertificateModal(currentCertificateTarget);
  }
}

function handleDownloadCertificateFromAchievement() {
  if (currentCertificateTarget) {
    void handleDownloadCertificatePng();
  }
}

function startNextLevel(domain, level) {
  closeLevelCompletionModal();
  selectedDomain = domain;
  selectedLevel = level;
  document.querySelectorAll('.domain').forEach(x => {
    x.classList.toggle('active', x.textContent.includes(domain));
  });
  document.querySelectorAll('.level').forEach(x => {
    x.classList.toggle('active', x.textContent.trim() === level);
  });
  loadScenario();
  showScreen('practice');
}

function handlePracticeAgain() {
  closeLevelCompletionModal();
  // Keep the learner on practice screen preserving earned progress
  showScreen('practice');
}

function openCertificateModal(certData) {
  if (!certData) {
    const learnerName = getLearnerDisplayName(user, currentUsername);
    const status = checkLevelCompletion(selectedDomain, selectedLevel, scenarios, state);
    certData = {
      domain: selectedDomain || 'Banking',
      level: selectedLevel || 'Beginner',
      userName: learnerName,
      completionDate: status.completionDate || formatCompletionDate(Date.now())
    };
  }

  currentCertificateTarget = certData;

  const modal = $('certificateModal');
  if (!modal) return;

  if ($('certModalHeading')) {
    $('certModalHeading').textContent = `Certificate of Completion — ${certData.domain} (${certData.level})`;
  }

  const previewCard = $('certPreviewCard');
  if (previewCard) {
    previewCard.innerHTML = generateCertificateSvg(certData);
  }

  modal.hidden = false;
}

function closeCertificateModal() {
  const modal = $('certificateModal');
  if (modal) modal.hidden = true;
}

async function handleDownloadCertificatePng() {
  if (!currentCertificateTarget) return;
  const btn = $('certDownloadPngBtn');
  const origText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Generating PNG...</span>';
  }
  try {
    await downloadCertificateImage(currentCertificateTarget);
  } catch (err) {
    console.error('Failed to download certificate image:', err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}

function handlePrintCertificatePdf() {
  if (!currentCertificateTarget) return;
  printCertificate(currentCertificateTarget);
}

let currentActiveScreen = 'home';
const pageScrollPositions = { home: 0, practice: 0 };

function showScreen(name) {
  if (name === 'profile') {
    openProfileModal();
    return;
  }
  if (!user) {
    if ($('loginScreen')) $('loginScreen').hidden = false;
    if ($('appMain')) $('appMain').hidden = true;
    if ($('bottomNav')) $('bottomNav').hidden = true;
    return;
  }
  if ($('loginScreen')) $('loginScreen').hidden = true;
  if ($('appMain')) $('appMain').hidden = false;
  if ($('bottomNav')) $('bottomNav').hidden = false;

  // Preserve scroll position of current screen before navigating away
  if (currentActiveScreen) {
    pageScrollPositions[currentActiveScreen] = window.scrollY || window.pageYOffset || 0;
  }

  const isProgress = name === 'progress' || name === 'progressScreen';
  const targetScreen = isProgress ? 'progress' : name;

  $('home').classList.toggle('active', name === 'home');
  $('practice').classList.toggle('active', name === 'practice');
  $('progressScreen').classList.toggle('active', isProgress);
  if ($('navHome')) $('navHome').classList.toggle('active', name === 'home');
  if ($('navPractice')) $('navPractice').classList.toggle('active', name === 'practice');
  if ($('navProgress')) $('navProgress').classList.toggle('active', isProgress);
  if (isProgress) {
    renderProgressScreen();
  } else if (name === 'practice') {
    if (!current) {
      selectedDomain = selectedDomain || 'Banking';
      selectedLevel = selectedLevel || 'Beginner';
      loadScenario();
    } else {
      renderScenario();
    }
  } else if (name === 'home') {
    renderScenarioCatalog();
    if (user && client) {
      void initContest(client, user, getCompletedCount(), isCurrentUserAdmin);
    }
  }

  currentActiveScreen = targetScreen;

  // When the Progress page opens, always scroll to the top.
  // Do NOT force scroll-to-top on Dashboard, Explore, Practice, or any other page.
  // Preserve the current scroll position on other pages (e.g. returning to Practice).
  if (isProgress) {
    window.scrollTo(0, 0);
  } else {
    const savedPos = pageScrollPositions[targetScreen] || 0;
    window.scrollTo(0, savedPos);
    requestAnimationFrame(() => {
      window.scrollTo(0, savedPos);
    });
  }
}
function goHome() { showScreen('home'); }
function openScenario(id) {
  const target = scenarios.find(s => s.id === id);
  if (!target) return;

  const isTargetCompleted = isCompleted(target, state.entries[target.id]);
  const completedCount = getCompletedCount();
  if (!isTargetCompleted && completedCount >= 5 && !isPaidUnlocked && !isCurrentUserAdmin) {
    openPaywallModal();
    return;
  }

  current = target;
  selectedDomain = target.domain;
  selectedLevel = target.level;
  document.querySelectorAll('.domain').forEach(x => {
    x.classList.toggle('active', x.textContent.includes(selectedDomain));
  });
  document.querySelectorAll('.level').forEach(x => {
    x.classList.toggle('active', x.textContent.trim() === selectedLevel);
  });
  renderScenario();
  showScreen('practice');
}
function showSampleThinking() {
  if (!current) return;
  const effective = getEffectiveScenario(current, user?.id || 'guest_user', state);
  $('thinking').value = effective.exampleThinking || effective.pseudo;
  evaluatePlan();
}
function improveLogic() {
  if (!current) return;
  const effective = getEffectiveScenario(current, user?.id || 'guest_user', state);
  const currentThinking = $('thinking').value.trim();
  const evaluation = evaluateThinking(effective, { response: currentThinking });
  const unpassed = evaluation.items.filter(i => !i.passed);
  if (unpassed.length === 0) {
    $('assessmentMessage').textContent = 'Your plan already satisfies all rubric criteria! You are ready to write SQL.';
    return;
  }
  const suggestions = [];
  unpassed.forEach(item => {
    if (item.category === 'result') {
      suggestions.push('• Target Goal: We need to ' + effective.question.toLowerCase().replace(/\.$/, '') + '.');
    } else if (item.category === 'data') {
      suggestions.push('• Data Sources: Query the table(s) ' + (effective.requiredTables || effective.tables).join(', ') + '.');
    } else if (item.category === 'approach') {
      suggestions.push('• Logic Step: ' + item.label + '.');
    } else if (item.category === 'check') {
      suggestions.push('• Output Validation: Verify that the output fields and filter conditions match the required logic.');
    }
  });
  let newText = currentThinking;
  if (!newText) {
    newText = suggestions.join('\n\n');
  } else {
    newText += '\n\n-- Suggested Logical Refinements --\n' + suggestions.join('\n');
  }
  $('thinking').value = newText;
  evaluatePlan();
}
function compareExpert() {
  if (!current) return;
  const effective = getEffectiveScenario(current, user?.id || 'guest_user', state);
  const userPlan = $('thinking').value.trim() || '(No thinking written yet)';
  $('userThinkingCompare').textContent = userPlan;
  $('expertThinkingCompare').textContent = effective.exampleThinking || effective.pseudo;
  $('expertPseudoCompare').textContent = effective.pseudo;
  const evaluation = evaluateThinking(effective, { response: userPlan });
  $('compareChecklist').innerHTML = evaluation.items.map(item => `
    <div class="compare-item ${item.passed ? 'passed' : 'pending'}">
      <span class="compare-icon">${item.passed ? '✓' : '○'}</span>
      <div style="flex:1">
        <div style="font-weight:700;font-size:13px;">${escapeHtml(item.label)}</div>
        <span class="compare-tag">${escapeHtml(item.category)}</span>
      </div>
    </div>
  `).join('');
  $('compareModal').hidden = false;
}
function closeCompare() { $('compareModal').hidden = true; }

function generateSql() {
  if (!current) return;
  const effective = getEffectiveScenario(current, user?.id || 'guest_user', state);
  const sql = effective.sql;
  $('learnerSql').value = sql;
  changeEntry({ sql, fiddleFingerprint: null, evaluationFingerprint: null, evaluationResult: null, variantIndex: effective.variantIndex, skill: effective.skill });
  renderSqlEvaluation(null);
  updateSqlEditorView();
  updateGates();
  updateSqlEditorStatus('PostgreSQL • Ready', 'ready');
  if ($('sqlGate')) {
    $('sqlGate').textContent = '✨ PostgreSQL query generated from plan! Click "Check / Run SQL" to test.';
    $('sqlGate').style.color = '#166534';
  }
  // Scroll smoothly to SQL section
  const sec = $('sqlSection');
  if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('learnerSql').focus();
}

function useStarterSql() {
  if (!current) return;
  const effective = getEffectiveScenario(current, user?.id || 'guest_user', state);
  let starter = '';
  const focusTable = effective.requiredTables?.[0] || effective.tables[0];
  if (/^WITH\b/i.test(effective.sql)) {
    starter = `-- Starter CTE Template\nWITH base_data AS (\n  SELECT *\n  FROM ${focusTable}\n  -- Filter or transform here\n)\nSELECT *\nFROM base_data;\n`;
  } else {
    starter = `-- Starter Query Template\nSELECT \n  -- specify required columns\nFROM ${focusTable}\n${effective.tables.length > 1 ? effective.tables.slice(1).map(t => 'JOIN ' + t + ' ON ...').join('\n') + '\n' : ''}-- WHERE condition\n;\n`;
  }
  $('learnerSql').value = starter;
  changeEntry({ sql: starter, fiddleFingerprint: null, evaluationFingerprint: null, evaluationResult: null, variantIndex: effective.variantIndex, skill: effective.skill });
  renderSqlEvaluation(null);
  updateSqlEditorView();
  updateGates();
  updateSqlEditorStatus('PostgreSQL • Ready', 'ready');
  $('learnerSql').focus();
}

function generateStepSql(scenario) {
  const steps = [];
  const sql = (scenario.sql || '').trim();
  if (/^WITH\b/i.test(sql)) {
    const cteMatches = [...sql.matchAll(/([a-zA-Z0-9_]+)\s+AS\s*\(\s*([\s\S]*?)\s*\)(?:,|$)/gi)];
    if (cteMatches.length > 0) {
      cteMatches.forEach((m, idx) => {
        steps.push({
          title: 'Step ' + (idx + 1) + ': Define CTE ' + m[1],
          code: m[1] + ' AS (\n  ' + m[2].trim() + '\n)'
        });
      });
      const finalSelectMatch = sql.match(/\)\s*(SELECT[\s\S]*;?)$/i);
      if (finalSelectMatch) {
        steps.push({
          title: 'Step ' + (steps.length + 1) + ': Final Output Projection',
          code: finalSelectMatch[1].trim()
        });
      }
    }
  }
  if (steps.length === 0) {
    const tablesStr = scenario.tables.join(', ');
    steps.push({
      title: 'Step 1: Identify Tables & Joins',
      code: '-- Base data sources:\nFROM ' + scenario.tables[0] + (scenario.tables.length > 1 ? '\nJOIN ' + scenario.tables.slice(1).join('\nJOIN ') : '')
    });
    const whereMatch = sql.match(/WHERE\s+([\s\S]*?)(?:GROUP BY|ORDER BY|LIMIT|;|$)/i);
    if (whereMatch) {
      steps.push({
        title: 'Step 2: Filter Conditions',
        code: 'WHERE ' + whereMatch[1].trim()
      });
    }
    const groupMatch = sql.match(/GROUP BY\s+([\s\S]*?)(?:HAVING|ORDER BY|LIMIT|;|$)/i);
    if (groupMatch) {
      const havingMatch = sql.match(/HAVING\s+([\s\S]*?)(?:ORDER BY|LIMIT|;|$)/i);
      steps.push({
        title: 'Step 3: Aggregation & Grouping',
        code: 'GROUP BY ' + groupMatch[1].trim() + (havingMatch ? '\nHAVING ' + havingMatch[1].trim() : '')
      });
    }
    const selectMatch = sql.match(/SELECT\s+([\s\S]*?)\s+FROM/i);
    const orderMatch = sql.match(/ORDER BY\s+([\s\S]*?)(?:LIMIT|;|$)/i);
    const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
    steps.push({
      title: 'Step ' + (steps.length + 1) + ': Select Target Columns & Order',
      code: 'SELECT ' + (selectMatch ? selectMatch[1].trim() : '*') + (orderMatch ? '\nORDER BY ' + orderMatch[1].trim() : '') + (limitMatch ? '\nLIMIT ' + limitMatch[1] : '') + ';'
    });
  }
  return steps;
}

function showStepSql() {
  if (!current) return;
  const steps = generateStepSql(current);
  $('stepSqlList').innerHTML = steps.map(s => `
    <div class="step-card">
      <div class="step-title">${escapeHtml(s.title)}</div>
      <pre class="step-code"><code>${escapeHtml(s.code)}</code></pre>
    </div>
  `).join('');
  $('stepSqlModal').hidden = false;
}
function closeStepSql() { $('stepSqlModal').hidden = true; }

function parseSampleData(sampleSql) {
  const tables = {};
  if (!sampleSql) return tables;
  const insertRegex = /INSERT INTO\s+([a-zA-Z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*([\s\S]*?);/gi;
  let match;
  while ((match = insertRegex.exec(sampleSql)) !== null) {
    const tableName = match[1];
    const cols = match[2].split(',').map(c => c.trim());
    const rawValues = match[3].trim();
    const rowRegex = /\(([^)]+)\)/g;
    const rows = [];
    let rowMatch;
    while ((rowMatch = rowRegex.exec(rawValues)) !== null) {
      const vals = rowMatch[1].split(/,(?=(?:[^']*'[^']*')*[^']*$)/).map(v => v.trim().replace(/^'|'$/g, ''));
      rows.push(vals);
    }
    tables[tableName] = { cols, rows };
  }
  return tables;
}

let currentSampleTable = null;
function setSchemaTab(tab) {
  $('tabSchema').classList.toggle('active', tab === 'schema');
  $('tabSample').classList.toggle('active', tab === 'sample');
  $('schemaOverview').hidden = tab !== 'schema';
  $('sampleDataView').hidden = tab !== 'sample';
  if (tab === 'sample') renderSampleDataView();
}

function renderSampleDataView() {
  const container = $('sampleDataView');
  if (!container || !current) return;
  const sampleSql = data.assets[current.domain]?.sample || '';
  const parsed = parseSampleData(sampleSql);
  const tableNames = Object.keys(parsed).sort();
  if (tableNames.length === 0) {
    container.innerHTML = '<p class="small muted">No sample data available for this scenario.</p>';
    return;
  }
  if (currentSampleTable && !tableNames.includes(currentSampleTable)) {
    currentSampleTable = null;
  }
  const tData = currentSampleTable ? parsed[currentSampleTable] : null;

  container.innerHTML = `
    <div style="font-weight: 800; font-size: 15px; margin-bottom: 10px; color: var(--ink);">Sample Data</div>
    <div class="sample-table-tabs">
      ${tableNames.map(t => `
        <button type="button" class="sample-tab ${t === currentSampleTable ? 'active' : ''}" onclick="selectSampleTable('${t}')">
          [ ${escapeHtml(t)} ]
        </button>
      `).join('')}
    </div>
    ${tData ? `
      <div class="table-scroll">
        <table class="sample-table">
          <thead>
            <tr>${tData.cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${tData.rows.slice(0, 10).map(r => `
              <tr>${r.map(v => `<td>${escapeHtml(v)}</td>`).join('')}</tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      ${tData.rows.length > 10 ? `<div class="small muted" style="margin-top:6px;">Showing first 10 of ${tData.rows.length} rows</div>` : ''}
    ` : `
      <div class="small muted" style="padding:14px; background:#f8fafc; border:1px dashed var(--line); border-radius:10px; text-align:center;">
        Click any table name above to view its sample data.
      </div>
    `}
  `;
}

function selectSampleTable(table) {
  currentSampleTable = table;
  renderSampleDataView();
}

let scenarioSearchQuery = '';
function filterScenarioSearch(q) {
  scenarioSearchQuery = q.toLowerCase().trim();
  renderScenarioCatalog();
}

function renderScenarioCatalog() {
  const container = $('scenarioCatalog');
  if (!container) return;
  let list = [];
  if (scenarioSearchQuery) {
    list = scenarios.filter(s => 
      s.id.toLowerCase().includes(scenarioSearchQuery) ||
      s.question.toLowerCase().includes(scenarioSearchQuery) ||
      s.domain.toLowerCase().includes(scenarioSearchQuery) ||
      s.level.toLowerCase().includes(scenarioSearchQuery)
    );
    $('catalogTitle').textContent = `Search: "${scenarioSearchQuery}" (${list.length} matches)`;
  } else if (selectedDomain && selectedLevel) {
    list = scenarios.filter(s => s.domain === selectedDomain && s.level === selectedLevel);
    $('catalogTitle').textContent = `${selectedDomain} • ${selectedLevel} (${list.length} exercises)`;
  } else {
    $('catalogTitle').textContent = currentDomainTrack === 'core'
      ? 'Explore 4 Core Domains (Pick Domain & Level above)'
      : 'Explore All Scenarios (Pick Domain & Level above)';
    const baseList = currentDomainTrack === 'core'
      ? scenarios.filter(s => CORE_DOMAINS.includes(s.domain))
      : scenarios;
    list = baseList.slice(0, 8);
  }
  
  if (list.length === 0) {
    container.innerHTML = '<div class="hint">No matching scenarios found.</div>';
    return;
  }
  
  container.innerHTML = list.slice(0, 50).map(s => {
    const e = state.entries[s.id] || {};
    const effective = getEffectiveScenario(s, user?.id || 'guest_user', state);
    const completed = isCompleted(s, e);
    const attempted = isAttempted(s, e);
    const isCurrent = current && current.id === s.id;
    const totalCompleted = getCompletedCount();
    const isLocked = !completed && totalCompleted >= 5 && !isPaidUnlocked && !isCurrentUserAdmin;
    let badgeClass = 'status-pill not-started';
    let badgeText = 'Not started';
    if (isLocked) {
      badgeClass = 'status-pill warn';
      badgeText = '🔒 Unlock (₹49)';
    } else if (completed) {
      badgeClass = 'status-pill verified';
      badgeText = '✓ Completed';
    } else if (attempted) {
      badgeClass = 'status-pill thinking';
      badgeText = (typeof e.assessment?.score === 'number') ? `Attempted (${e.assessment.score}/10)` : 'In Progress';
    } else if (e.sql && String(e.sql).trim()) {
      badgeClass = 'status-pill draft';
      badgeText = '📝 Draft';
    }
    return `
      <div class="catalog-item ${isCurrent ? 'active' : ''}" onclick="openScenario('${s.id}')">
        <div class="catalog-item-header">
          <span class="catalog-id">${s.id}</span>
          <span class="catalog-domain-tag">${s.domain} • ${s.level}${effective.skill ? ' • ' + effective.skill : ''}</span>
          <span class="${badgeClass}">${badgeText}</span>
        </div>
        <div class="catalog-question">${escapeHtml(effective.question)}</div>
      </div>
    `;
  }).join('');
}

function renderProgressScreen() {
  if (!scenarios.length) return;
  const trackScenarios = (currentDomainTrack === 'core')
    ? scenarios.filter(s => CORE_DOMAINS.includes(s.domain))
    : scenarios;
  
  const totalQuestions = trackScenarios.length;
  const completedCount = trackScenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
  const inProgressCount = trackScenarios.filter(s => isAttempted(s, state.entries[s.id]) && !isCompleted(s, state.entries[s.id])).length;
  const completionPct = totalQuestions > 0 ? Math.round((completedCount / totalQuestions) * 100) : 0;

  let totalScore = 0, countWithScore = 0;
  for (const s of trackScenarios) {
    const e = state.entries[s.id];
    if (e?.assessment?.score !== undefined && typeof e.assessment.score === 'number') {
      totalScore += e.assessment.score;
      countWithScore++;
    }
  }
  const avgScore = countWithScore ? (totalScore / countWithScore).toFixed(1) : '0.0';

  if ($('progressTrackSubtitle')) {
    const trackTitle = currentDomainTrack === 'core' 
      ? '4 Core Domains Track (240 questions)' 
      : 'All Domains Track (420 questions)';
    $('progressTrackSubtitle').textContent = `${trackTitle} • ${completedCount} Completed • ${inProgressCount} In Progress`;
  }
  if ($('progressTotalQuestions')) $('progressTotalQuestions').textContent = String(totalQuestions);
  if ($('progressCompletedQuestions')) $('progressCompletedQuestions').textContent = String(completedCount);
  if ($('progressCompletionPct')) $('progressCompletionPct').textContent = `${completionPct}%`;
  if ($('progressAvgThinkingScore')) $('progressAvgThinkingScore').textContent = `${avgScore} / 10`;

  // Domain-wise completed questions: Banking, Healthcare, Insurance, Retail
  const targetDomains = [
    { name: 'Banking', icon: '🏦', color: '#2563eb' },
    { name: 'Healthcare', icon: '🏥', color: '#059669' },
    { name: 'Insurance', icon: '🛡️', color: '#7c3aed' },
    { name: 'Retail', icon: '🛒', color: '#ea580c' }
  ];

  const domainCounts = targetDomains.map(d => {
    const dScenarios = scenarios.filter(s => s.domain === d.name);
    const count = dScenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
    return { ...d, count, total: dScenarios.length };
  });

  const sumDomainCompleted = domainCounts.reduce((acc, cur) => acc + cur.count, 0);

  const container = $('domainChartContent');
  if (container) {
    const size = 140;
    const r = 50;
    const cx = size / 2;
    const cy = size / 2;
    const circumference = 2 * Math.PI * r;

    let slicesSvg = '';
    if (sumDomainCompleted === 0) {
      slicesSvg = `
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="16" />
        <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="20" font-weight="900" fill="#94a3b8">0</text>
        <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="11" font-weight="700" fill="#94a3b8">Completed</text>
      `;
    } else {
      let accumulatedOffset = 0;
      const paths = domainCounts.map(d => {
        if (d.count === 0) return '';
        const sliceLength = (d.count / sumDomainCompleted) * circumference;
        const offset = -accumulatedOffset;
        accumulatedOffset += sliceLength;
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${d.color}" stroke-width="16" stroke-dasharray="${sliceLength.toFixed(2)} ${(circumference - sliceLength).toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}" />`;
      }).filter(Boolean);

      slicesSvg = `
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#f1f5f9" stroke-width="16" />
        <g transform="rotate(-90 ${cx} ${cy})">
          ${paths.join('')}
        </g>
        <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="22" font-weight="900" fill="var(--ink)">${sumDomainCompleted}</text>
        <text x="${cx}" y="${cy + 15}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--muted)">Completed</text>
      `;
    }

    const legendHtml = domainCounts.map(d => `
      <div class="domain-legend-row">
        <div class="domain-legend-left">
          <span class="domain-color-dot" style="background:${d.color};"></span>
          <span>${d.icon} <b>${d.name}</b></span>
        </div>
        <div class="domain-legend-count"><b>${d.count}</b> completed</div>
      </div>
    `).join('');

    container.innerHTML = `
      <div class="donut-chart-box" style="flex-shrink:0;">
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Domain completion chart">
          ${slicesSvg}
        </svg>
      </div>
      <div class="domain-legend-list">
        ${legendHtml}
      </div>
    `;
  }

  renderCertificatesSection();
}

function renderCertificatesSection() {
  const allCerts = getAllCertificatesStatus(scenarios, state, user, currentUsername);
  const earnedCerts = allCerts.filter(c => c.isCompleted);

  if ($('earnedCertificatesBadge')) {
    $('earnedCertificatesBadge').textContent = `${earnedCerts.length} / 21 Earned`;
  }

  const grid = $('certificatesGrid');
  if (!grid) return;

  grid.innerHTML = allCerts.map(c => {
    const isEarned = c.isCompleted;
    const cardClass = isEarned ? 'cert-card-item earned' : 'cert-card-item';
    const icon = isEarned ? '🏆' : '🔒';
    const statusText = isEarned
      ? `Completed 20/20 • Awarded ${c.completionDate}`
      : `${c.completedCount} / 20 Scenarios Completed`;

    const actions = isEarned ? `
      <button class="action primary sm" style="padding:6px 12px;font-size:12px;font-weight:700;" onclick="viewCertificate('${c.domain}','${c.level}','${c.completionDate}')">
        View Certificate
      </button>
      <button class="action secondary sm" style="padding:6px 10px;font-size:12px;" onclick="downloadCertificateDirect('${c.domain}','${c.level}','${c.completionDate}')" title="Download High-Res PNG">
        📥 Download
      </button>
    ` : `
      <button class="ghost-btn-sm" style="padding:6px 12px;font-size:12px;color:var(--primary);font-weight:700;" onclick="practiceDomainAndLevel('${c.domain}','${c.level}')">
        Continue Practice →
      </button>
    `;

    return `
      <div class="${cardClass}">
        <div class="cert-card-header">
          <div>
            <div class="cert-card-domain">${icon} ${escapeHtml(c.domain)}</div>
            <div class="cert-card-status">${statusText}</div>
          </div>
          <span class="cert-card-level-badge">${c.level}</span>
        </div>
        <div class="cert-card-actions">
          ${actions}
        </div>
      </div>
    `;
  }).join('');
}

function filterProgressDomain() {}
function filterProgressStatus() {}
function filterProgressSearch() {}
function renderProgressTable() {}

function practiceDomain(domain) {
  selectedDomain = domain;
  selectedLevel = selectedLevel || 'Beginner';
  document.querySelectorAll('.domain').forEach(x => {
    x.classList.toggle('active', x.textContent.includes(domain));
  });
  document.querySelectorAll('.level').forEach(x => {
    x.classList.toggle('active', x.textContent.trim() === selectedLevel);
  });
  loadScenario();
  showScreen('practice');
}

function openOnboarding() {
  const o = $('onboarding');
  if (o) o.style.display = 'flex';
}
function closeOnboarding() {
  try { storage.setItem('crack_sql_onboard_seen', '1'); } catch {}
  const o = $('onboarding');
  if (o) o.style.display = 'none';
}
function initAppChrome() {
  setTimeout(() => {
    const s = $('splashScreen');
    if (s) {
      s.classList.add('hide');
      setTimeout(() => { s.style.display = 'none'; }, 600);
    }
  }, 900);
  setTimeout(() => {
    try {
      if (!storage.getItem('crack_sql_onboard_seen')) openOnboarding();
    } catch {}
  }, 1200);
}
async function copy(text, label = 'Content') {
  try {
    await navigator.clipboard.writeText(text);
    if ($('sqlGate')) {
      $('sqlGate').textContent = `✓ ${label} copied to clipboard! Ready to paste into DB Fiddle.`;
      $('sqlGate').style.color = '#0369a1';
    }
  } catch {
    $('manualCopy').hidden = false;
    $('copyText').value = text;
    $('copyText').focus();
    $('copyText').select();
  }
}

function copySetup() {
  if (!current) return;
  const setup = (data.assets[current.domain]?.schema || '') + '\n\n' + (data.assets[current.domain]?.sample || '');
  void copy(setup, 'Schema and sample data');
}

function copyQuery() {
  if (!current) return;
  const sql = ($('learnerSql')?.value || entry().sql || current.sql || '').trim();
  if (!sql) {
    if ($('sqlGate')) {
      $('sqlGate').textContent = 'No SQL query found. Type your query first.';
      $('sqlGate').style.color = 'var(--warn)';
    }
    return;
  }
  void copy(sql, 'SQL query');
}

function copyAllScripts() {
  if (!current) return;
  const setup = (data.assets[current.domain]?.schema || '') + '\n\n' + (data.assets[current.domain]?.sample || '');
  const sql = ($('learnerSql')?.value || entry().sql || current.sql || '').trim();
  const all = `-- =========================================\n-- POSTGRESQL SCHEMA + SAMPLE DATA\n-- =========================================\n${setup}\n\n-- =========================================\n-- YOUR SQL QUERY\n-- =========================================\n${sql || current.sql};\n`;
  void copy(all, 'All scripts (Schema + Sample data + SQL)');
}

function runDbFiddle() {
  copyAllScripts();
}

function copySqlAndOpenFiddle() {
  copyLearnerSql();
}

async function evaluateSql() {
  const e = entry();
  const sql = (e.sql || $('learnerSql')?.value || '').trim();
  if (!current) return;
  if (!sql) {
    if ($('sqlGate')) {
      $('sqlGate').textContent = 'Please enter or generate a SQL query before checking.';
      $('sqlGate').style.color = 'var(--warn)';
    }
    return;
  }
  if (sqlEngineManager.isBusy()) {
    return;
  }

  updateGates();
  try {
    const targetScenarioId = current.id;
    const effective = getEffectiveScenario(current, user?.id || 'guest_user', state);
    const result = await sqlEngineManager.evaluate(effective, data.assets[effective.domain], sql);

    // If scenario changed while awaiting, don't update entry of old scenario
    if (!current || current.id !== targetScenarioId) return;

    const fingerprint = workFingerprint(entry());
    changeEntry({
      evaluationFingerprint: result.passed ? fingerprint : null,
      evaluationResult: result,
      evaluationAt: Date.now(),
      attempts: (entry().attempts || 0) + 1,
      variantIndex: effective.variantIndex,
      skill: effective.skill
    });
    recordSkillAttempt(state, effective, !!result.passed);
    renderSqlEvaluation(result);
  } catch (error) {
    const detail = error?.message ? ` (${error.message})` : '';
    renderSqlEvaluation({
      passed: false,
      kind: 'engine',
      message: `The local SQL engine encountered an error${detail}. Click "Reset SQL" or retry.`
    });
    console.error('SQL Engine execution failure:', error);
  } finally {
    updateGates();
  }
}
function resetProgress() {
  if(!confirm('Reset progress for '+(user?'this signed-in account':'this guest profile')+'? Other accounts will not be changed.'))return;
  const resetAt=nextTimestamp(state);state={...EMPTY(),resetAt};persist();updateProgress();
  if(current)renderScenario();
}
function importOldHistory() {
  if(!confirm('Earlier device history may belong to someone else. Import it into this profile only as “answer viewed”, without awarding thinking or SQL completion?'))return;
  let old;try{old=JSON.parse(storage.getItem('crackSqlProgress'));}catch{old=[];}
  state=importLegacy(old,state,data.aliases,ids);persist();updateProgress();if(current)renderScenario();
}
function importGuestProgress() {
  if(!user||!confirm('Import this device’s guest practice into your signed-in account?'))return;
  const guest=readProgress(storage,null,ids);
  // Explicit imports re-date entries so an intentional import works after a reset.
  const imported=structuredClone(guest);imported.resetAt=state.resetAt;
  let at=nextTimestamp(state);for(const e of Object.values(imported.entries))e.updatedAt=at++;
  state=mergeProgress(state,imported,ids);persist();updateProgress();if(current)renderScenario();
}
async function importCloudHistory() {
  if(!user||!client||!confirm('Import your earlier account completions as answer-viewed history? This will not award thinking or SQL completion.'))return;
  const owner=user.id;
  try {
    const {data:rows,error}=await client.from('progress').select('scenario_id').eq('user_id',owner);
    if(owner!==user?.id)return;
    if(error)throw error;
    state=importLegacy(rows.map(row=>row.scenario_id),state,data.aliases,ids);
    persist();updateProgress();if(current)renderScenario();
  } catch {if(owner===user?.id)alert('Earlier account history could not be fetched. Your current progress is unchanged.');}
}
function retrySync() {if(user&&client)cloud.request();else if($('syncStatus'))$('syncStatus').textContent='Sign in to sync. Guest practice is saved only on this device.';}
function renderAuth() {
  const loginMsg = $('loginErrorMessage');
  if (loginMsg && authNotice) loginMsg.textContent = authNotice;

  const displayHandle = currentUsername ? `@${currentUsername}` : (user?.email || 'learner');
  const emailSub = currentUsername && user?.email ? ` <span style="font-size:0.85em;color:var(--muted);">(${escapeHtml(user.email)})</span>` : '';
  const premiumBadge = (user && isPaidUnlocked) ? ' <span class="premium-badge">⭐ PREMIUM</span>' : '';
  $('authBox').innerHTML=user?'<div class="auth-row"><span>Signed in as <strong>'+escapeHtml(displayHandle)+'</strong>'+emailSub+premiumBadge+'</span><button class="linkbtn" onclick="signOut()">Sign out</button></div>':'';
  if($('authMessage'))$('authMessage').textContent=authNotice;
  if($('importGuest'))$('importGuest').hidden=!user;
  if($('importCloud'))$('importCloud').hidden=!user;

  const headerBadge = $('headerPremiumBadge');
  if (headerBadge) {
    headerBadge.style.display = (user && isPaidUnlocked) ? 'inline-flex' : 'none';
  }

  renderProfileAvatar();
}

async function loadAndRestoreUserProgress(userId) {
  if (!userId) return;

  console.log('[D2D Progress] User authenticated:', userId);

  // 1. Isolate in-memory state for this authenticated user (never reuse guest or previous user data)
  const localCached = readProgress(storage, userId, ids);
  const localHasEntries = localCached && Object.keys(localCached.entries).length > 0;
  let workingState = localHasEntries ? localCached : EMPTY();

  console.log('[D2D Progress] Loading cloud progress');

  // 2. Fetch that user's learning_progress record from Supabase
  if (client) {
    try {
      const { data: row, error } = await client
        .from('learning_progress')
        .select('state, updated_at')
        .eq('user_id', userId)
        .maybeSingle();

      if (error) {
        console.error('[D2D Progress] Supabase load error:', error.message || error);
      } else if (row && row.state) {
        console.log('[D2D Progress] Cloud progress found');
        // 3. Sanitize cloud state
        const cloudState = sanitize(row.state, ids);
        const cloudHasEntries = cloudState && Object.keys(cloudState.entries).length > 0;
        if (cloudHasEntries) {
          // 4. Merge cloud and local progress safely (preserves score >= 7 completions)
          workingState = mergeProgress(workingState, cloudState, ids);
        }
      } else {
        console.log('[D2D Progress] No existing cloud progress found for user');
      }

      // 3. Authoritative reconciliation with public.progress
      try {
        const { data: recData, error: recErr } = await client.rpc('reconcile_user_completions', {
          p_user_id: userId
        });
        if (recErr) console.warn('reconcile_user_completions error:', recErr.message || recErr);
        if (recData && typeof recData.completed_count === 'number') {
          authoritativeCompletedCount = recData.completed_count;
        }
      } catch (recEx) {
        console.warn('reconcile_user_completions notice:', recEx);
      }

      // Fetch confirmed distinct scenario completions from public.progress
      const { data: progRows, error: progErr } = await client
        .from('progress')
        .select('scenario_id')
        .eq('user_id', userId);

      if (!progErr && progRows && Array.isArray(progRows)) {
        const confirmedSet = new Set(progRows.map(r => r.scenario_id));
        authoritativeCompletedCount = Math.max(authoritativeCompletedCount, confirmedSet.size);

        // Mark confirmed scenarios as completed in working state
        for (const sId of confirmedSet) {
          if (!workingState.entries[sId]) {
            workingState.entries[sId] = {
              thinking: { response: '' },
              sql: '',
              status: 'completed',
              completed: true,
              attempts: 1,
              updatedAt: Date.now()
            };
          } else {
            workingState.entries[sId].completed = true;
            workingState.entries[sId].status = 'completed';
          }
        }
      }
    } catch (err) {
      console.error('[D2D Progress] Exception loading cloud progress from Supabase:', err);
    }
  }

  // 5. Save merged local cache under this user's storageKey
  saveProgress(storage, userId, workingState);

  // 6. Update in-memory state
  state = workingState;

  const restoredCompleted = getCompletedCount();
  console.log('[D2D Progress] Restored completed questions:', restoredCompleted);

  // 7. Update progress UI & render scenarios
  renderAuth();
  updateProgress();
  renderScenarioCatalog();
  if (current) renderScenario();

  // 8. If there are local entries to synchronize, trigger cloud sync
  if (Object.keys(state.entries).length > 0) {
    cloud.request();
  }
}

let authSessionCounter = 0;

async function setSession(session) {
  const currentAuthToken = ++authSessionCounter;
  const next = session?.user || null;
  if (next) authNotice = '';
  const previousUserId = user?.id;
  user = next;

  if (user) {
    if (previousUserId !== user.id) {
      stopPaymentPolling();
      isCurrentUserAdmin = false;
      isPaidUnlocked = false;
      authoritativeCompletedCount = 0;
      userPendingPayment = null;
      updateAdminPortalVisibility();
      hideAccessError();
    }

    if ($('loginScreen')) $('loginScreen').hidden = true;
    if ($('appMain')) $('appMain').hidden = false;
    if ($('bottomNav')) $('bottomNav').hidden = false;

    clearTimeout(syncTimer);
    cloud.changeSession();
    renderAuth();

    // 1. Load user's existing progress from Supabase
    await loadAndRestoreUserProgress(user.id);
    if (currentAuthToken !== authSessionCounter) return;

    initNotificationsState(user.id);
    updateNotificationsUI();

    // 2. Authoritative server admin check (awaited before rendering gated features)
    const adminCheckResult = await checkAdminStatus();
    if (currentAuthToken !== authSessionCounter) return;

    // 3. User access status (payment & profile) (awaited)
    await checkUserAccessStatus(user.id);
    if (currentAuthToken !== authSessionCounter) return;

    // 4. Username setup
    await checkAndEnforceUsername(user.id, user.email);
    if (currentAuthToken !== authSessionCounter) return;

    // 5. Render home screen & initialize contest with authoritative admin status
    showScreen('home');
    void initContest(client, user, getCompletedCount(), isCurrentUserAdmin);
  } else {
    // Signed out: reset in-memory active state and return to login gate
    stopPaymentPolling();
    isCurrentUserAdmin = false;
    isPaidUnlocked = false;
    authoritativeCompletedCount = 0;
    userPendingPayment = null;
    currentUsername = null;
    closeUsernameModal();
    closePaywallModal();
    updateAdminPortalVisibility();
    hideAccessError();
    if ($('loginScreen')) $('loginScreen').hidden = false;
    if ($('appMain')) $('appMain').hidden = true;
    if ($('bottomNav')) $('bottomNav').hidden = true;
    closeProfileDropdown();
    closeProfileModal();
    closeContestModal();

    clearTimeout(syncTimer);
    cloud.changeSession();
    state = EMPTY();
    current = null;
    renderAuth();
    void initContest(null, null, 0, false);
  }
}

// App resume / focus listeners to refresh authoritative access without requiring logout
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && user && !isPaidUnlocked && !isCurrentUserAdmin) {
    void checkPaymentStatusSilently(false);
  }
});
window.addEventListener('focus', () => {
  if (user && !isPaidUnlocked && !isCurrentUserAdmin) {
    void checkPaymentStatusSilently(false);
  }
});
async function signInWithGoogle() {
  const button=$('googleSignIn');
  const message=$('loginErrorMessage') || $('authMessage');
  if(!client || !button || button.disabled)return;
  button.disabled=true;
  button.innerHTML=`<span>Connecting to Google…</span>`;
  authNotice='';if(message)message.textContent='';
  try {
    const redirectUrl = getOAuthRedirectUrl();
    const {error}=await client.auth.signInWithOAuth({
      provider:'google',
      options:{
        redirectTo:redirectUrl,
        queryParams:{prompt:'select_account'}
      }
    });
    if(error)throw error;
  } catch {
    button.disabled=false;
    button.innerHTML=`
      <svg class="google-icon" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/>
      </svg>
      <span>Continue with Google</span>
    `;
    authNotice='Google sign-in could not start. Please retry. If it keeps failing, check the connection or allowed redirect URLs in Supabase.';
    if(message)message.textContent=authNotice;
  }
}
async function signOut() {
  try {
    if (user?.id) {
      persist(false);
    }
    if (client) {
      const {error}=await client.auth.signOut();
      if(error) console.warn('Supabase signOut error:', error);
    }
    await setSession(null);
  }
  catch (err) {
    console.error('Sign-out error:', err);
    await setSession(null);
  }
}
async function initAuth() {
  try {
    client=window.supabase?.createClient('https://qklnaqfspvmnlequqagf.supabase.co','sb_publishable_dthVX8zmvd1HvWaYWBaojA_2YbvHWe1')||null;
    renderAuth();
    if(!client) {
      await setSession(null);
      return;
    }
    const callback=new URLSearchParams(location.hash.slice(1));
    if(callback.has('error')||callback.has('error_description')) {
      const message=$('loginErrorMessage') || $('authMessage');
      authNotice='Google sign-in was cancelled or unsuccessful. Please try again.';
      if(message)message.textContent=authNotice;
      history.replaceState(null,'',location.pathname+location.search);
    }
    let authEventSeen=false;
    client.auth.onAuthStateChange(async (_event,session)=>{
      authEventSeen=true;
      await setSession(session);
    });
    const {data:auth,error}=await client.auth.getSession();
    if(error)throw error;
    if(!authEventSeen) {
      await setSession(auth?.session || null);
    }
  } catch (err) {
    console.warn('Auth initialization error:', err);
    await setSession(null);
  }
}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredPrompt=event;$('installBanner').classList.add('show');});
async function installApp(){if(deferredPrompt){await deferredPrompt.prompt();deferredPrompt=null;$('installBanner').classList.remove('show');}}
window.addEventListener('appinstalled',()=>{$('installBanner').classList.remove('show');});
if(/iPad|iPhone|iPod/.test(navigator.userAgent)&&!navigator.standalone)$('iosHint').style.display='';
window.addEventListener('online',retrySync);
window.addEventListener('storage',event=>{
  if(event.key!==storageKey(user?.id))return;
  const merged=mergeProgress(state,readProgress(storage,user?.id,ids),ids);
  if(JSON.stringify(merged)===JSON.stringify(state))return;
  state=merged;updateProgress();if(current)renderScenario();
});

function toggleLandscapeMode() {
  document.querySelectorAll('.btn-landscape-toggle').forEach(btn => btn.remove());
}

function updateLandscapeToggleText() {
  document.querySelectorAll('.btn-landscape-toggle').forEach(btn => btn.remove());
}

function initLandscapeMode() {
  document.body.classList.add('landscape-layout');
  document.querySelectorAll('.btn-landscape-toggle').forEach(btn => btn.remove());
}

// -----------------------------------------------------------------------------
// Permanent First-Time Username System
// -----------------------------------------------------------------------------
function openUsernameModal(userId, userEmail) {
  const modal = $('usernameSetupModal');
  if (!modal) return;
  modal.hidden = false;

  const emailEl = $('usernameModalEmail');
  if (emailEl) emailEl.textContent = userEmail || 'your Google account';

  const input = $('usernameInput');
  const errorEl = $('usernameInputError');
  const btn = $('saveUsernameBtn');

  if (errorEl) {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = 'Save Username & Continue';
  }

  if (input) {
    if (!input.value && userEmail) {
      const suggested = userEmail.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 15);
      input.value = suggested;
    }
    setTimeout(() => {
      try { input.focus(); } catch (e) {}
    }, 150);
  }
}

function closeUsernameModal() {
  const modal = $('usernameSetupModal');
  if (modal) modal.hidden = true;
}

function validateUsernameField() {
  const input = $('usernameInput');
  const errorEl = $('usernameInputError');
  if (!input) return;
  // Allow only normal English letters: A-Z, a-z. No numbers, no spaces, no symbols.
  input.value = input.value.replace(/[^A-Za-z]/g, '');
  if (errorEl) errorEl.style.display = 'none';
}

async function checkAndEnforceUsername(userId, userEmail) {
  if (!userId || !client) return;

  try {
    // 1. If already known in-memory, ensure UI is synced and modal is closed
    if (currentUsername) {
      renderProfileAvatar();
      renderAuth();
      closeUsernameModal();
      return currentUsername;
    }

    // 2. Check local storage cache for instant rendering
    const cached = localStorage.getItem(`cracksql_username_${userId}`);
    if (cached && cached.trim()) {
      currentUsername = cached.trim();
      renderProfileAvatar();
      renderAuth();
      closeUsernameModal();
    }

    // 3. Check Supabase auth user metadata (syncs across devices for the same Google account)
    const metaUsername = user?.user_metadata?.username;
    if (metaUsername && typeof metaUsername === 'string' && metaUsername.trim()) {
      currentUsername = metaUsername.trim();
      try {
        localStorage.setItem(`cracksql_username_${userId}`, currentUsername);
      } catch (e) {}
      renderProfileAvatar();
      renderAuth();
      closeUsernameModal();
    }

    // 4. Query the single source of truth: public.profiles table in Supabase
    let profile = null;
    try {
      const { data, error } = await client
        .from('profiles')
        .select('id, email, username')
        .eq('id', userId)
        .maybeSingle();

      if (error) {
        console.warn('[Username] Profile query notice:', error.message || error);
        if (error.message && error.message.includes("Could not find the 'username' column")) {
          const { data: fallbackData } = await client
            .from('profiles')
            .select('id, email')
            .eq('id', userId)
            .maybeSingle();
          profile = fallbackData;
        }
      } else {
        profile = data;
      }
    } catch (queryErr) {
      console.warn('[Username] Profile query exception:', queryErr);
    }

    // If profile row doesn't exist yet, insert it
    if (!profile) {
      try {
        const { data: newProf } = await client
          .from('profiles')
          .upsert({ id: userId, email: userEmail, last_active: new Date().toISOString() }, { onConflict: 'id', ignoreDuplicates: true })
          .select('id, email')
          .maybeSingle();
        if (newProf) profile = newProf;
      } catch (insErr) {
        console.warn('[Username] Insert profile notice:', insErr);
      }
    }

    const dbUsername = (profile?.username || '').trim();
    if (dbUsername) {
      currentUsername = dbUsername;
      try {
        localStorage.setItem(`cracksql_username_${userId}`, dbUsername);
      } catch (e) {}
      renderProfileAvatar();
      renderAuth();
      closeUsernameModal();
      return dbUsername;
    }

    // If we have currentUsername from auth metadata/cache, ensure it's saved to profiles table
    if (currentUsername) {
      try {
        const { error: upErr } = await client.from('profiles').update({ username: currentUsername }).eq('id', userId);
        if (upErr) console.warn('[Username] Background sync error:', upErr.message || upErr);
      } catch (syncErr) {
        console.warn('[Username] Background sync to profiles notice:', syncErr);
      }
      closeUsernameModal();
      return currentUsername;
    }

    // 5. No permanent username exists -> Show simple Create Username box
    openUsernameModal(userId, userEmail);
  } catch (err) {
    console.error('[Username] Error checking username status:', err);
  }
}

async function saveFirstTimeUsername() {
  const input = $('usernameInput');
  const errorEl = $('usernameInputError');
  const btn = $('saveUsernameBtn');
  if (!input || !client || !user) return;

  // Allow only normal English letters: A-Z, a-z (preserve case, e.g. Sundar, DataDashboard)
  const clean = input.value.trim().replace(/[^A-Za-z]/g, '');

  if (errorEl) errorEl.style.display = 'none';

  if (!clean || !/^[A-Za-z]+$/.test(clean)) {
    if (errorEl) {
      errorEl.textContent = 'Please enter a username using only letters (A-Z, a-z).';
      errorEl.style.display = 'block';
    }
    input.focus();
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>Saving Username…</span>';
  }

  try {
    // 1. Check if another user has already taken this username (case-insensitive)
    try {
      const { data: existing } = await client
        .from('profiles')
        .select('id, username')
        .ilike('username', clean)
        .neq('id', user.id)
        .maybeSingle();

      if (existing && existing.id && existing.id !== user.id) {
        if (errorEl) {
          errorEl.textContent = `The username "${clean}" is already taken. Please choose another.`;
          errorEl.style.display = 'block';
        }
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = 'Save Username';
        }
        input.focus();
        return;
      }
    } catch (checkErr) {
      console.warn('[Username] Uniqueness check notice:', checkErr);
    }

    // 2. Persist to Supabase auth user metadata (guarantees cross-device permanence for Google account)
    try {
      await client.auth.updateUser({
        data: { username: clean }
      });
    } catch (metaErr) {
      console.warn('[Username] Auth user metadata notice:', metaErr);
    }

    // 3. Save permanently to user's existing Supabase profile linked to User ID
    try {
      const { error: saveErr } = await client
        .from('profiles')
        .upsert({
          id: user.id,
          email: user.email,
          username: clean,
          last_active: new Date().toISOString()
        }, { onConflict: 'id' });

      if (saveErr) {
        if (saveErr.code === '23505' || (saveErr.message && saveErr.message.includes('unique'))) {
          if (errorEl) {
            errorEl.textContent = `The username "${clean}" is already taken. Please choose another.`;
            errorEl.style.display = 'block';
          }
          if (btn) {
            btn.disabled = false;
            btn.innerHTML = 'Save Username';
          }
          input.focus();
          return;
        }

        if (saveErr.message && saveErr.message.includes("Could not find the 'username' column")) {
          console.warn("[Username] Database schema cache notice: 'username' column not in schema cache. Run `NOTIFY pgrst, 'reload schema';`");
        } else {
          throw saveErr;
        }
      }
    } catch (dbErr) {
      console.warn('[Username] Database save notice:', dbErr);
      if (!dbErr.message || !dbErr.message.includes("Could not find the 'username' column")) {
        if (errorEl) {
          errorEl.textContent = 'Failed to save username: ' + (dbErr.message || 'Please retry.');
          errorEl.style.display = 'block';
        }
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = 'Save Username';
        }
        return;
      }
    }

    // 4. Cache in localStorage for immediate future page loads on this device
    try {
      localStorage.setItem(`cracksql_username_${user.id}`, clean);
    } catch (e) {}

    currentUsername = clean;

    closeUsernameModal();
    renderProfileAvatar();
    renderAuth();
    console.log(`[Username] Successfully saved permanent username "${clean}" for user ${user.id}`);
  } catch (err) {
    console.error('[Username] Error saving username:', err);
    if (errorEl) {
      errorEl.textContent = 'Failed to save username: ' + (err.message || 'Please retry.');
      errorEl.style.display = 'block';
    }
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = 'Save Username';
    }
  }
}

function getUserInfo() {
  if (!user) {
    return {
      isLoggedIn: false,
      name: 'Guest Learner',
      username: null,
      email: 'Practicing on this device',
      initial: 'G',
      avatarUrl: null
    };
  }
  const meta = user.user_metadata || {};
  const metaName = meta.full_name || meta.name;
  const name = currentUsername ? currentUsername : (metaName || (user.email ? user.email.split('@')[0] : 'Learner'));
  const email = user.email || 'learner@local';
  const initial = (currentUsername ? currentUsername[0] : (name[0] || email[0] || 'U')).toUpperCase();
  const avatarUrl = meta.avatar_url || meta.picture || null;
  return {
    isLoggedIn: true,
    name,
    username: currentUsername || null,
    email,
    initial,
    avatarUrl
  };
}

function renderProfileAvatar() {
  const info = getUserInfo();
  
  document.querySelectorAll('.profile-avatar-content').forEach(avatarContent => {
    if (info.avatarUrl) {
      avatarContent.innerHTML = `<img src="${escapeHtml(info.avatarUrl)}" alt="${escapeHtml(info.name)}" class="profile-avatar-img" onerror="this.onerror=null;this.parentElement.innerHTML='<span class=\\'profile-avatar-initial\\'>${escapeHtml(info.initial)}</span>';">`;
    } else if (info.isLoggedIn) {
      avatarContent.innerHTML = `<span class="profile-avatar-initial">${escapeHtml(info.initial)}</span>`;
    } else {
      avatarContent.innerHTML = `<span style="font-size:18px;">👤</span>`;
    }
  });

  const ddAvatar = $('dropdownAvatar');
  if (ddAvatar) {
    if (info.avatarUrl) {
      ddAvatar.innerHTML = `<img src="${escapeHtml(info.avatarUrl)}" alt="${escapeHtml(info.name)}" class="profile-avatar-img" onerror="this.onerror=null;this.parentElement.innerHTML='${escapeHtml(info.initial)}';">`;
    } else if (info.isLoggedIn) {
      ddAvatar.textContent = info.initial;
    } else {
      ddAvatar.innerHTML = '👤';
    }
  }

  const ddName = $('dropdownName');
  if (ddName) {
    if (user && isPaidUnlocked) {
      ddName.innerHTML = `${escapeHtml(info.name)} <span class="premium-badge" style="font-size:0.7rem;padding:1px 6px;">⭐ PREMIUM</span>`;
    } else {
      ddName.textContent = info.name;
    }
  }

  const ddEmail = $('dropdownEmail');
  if (ddEmail) ddEmail.textContent = info.email;

  const signOutLabel = $('profileSignOutLabel');
  if (signOutLabel) {
    signOutLabel.textContent = info.isLoggedIn ? 'Sign Out' : 'Sign in with Google';
  }
  updateAdminPortalVisibility();
}

function toggleProfileDropdown(event) {
  if (event) event.stopPropagation();
  const dropdown = $('profileDropdown');
  if (!dropdown) return;
  const isHidden = dropdown.hidden;
  dropdown.hidden = !isHidden;
  const btn = $('profileBtn');
  if (btn) btn.setAttribute('aria-expanded', String(isHidden));
}

function closeProfileDropdown() {
  const dropdown = $('profileDropdown');
  if (dropdown && !dropdown.hidden) {
    dropdown.hidden = true;
    const btn = $('profileBtn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
}

function openProfileModal() {
  closeProfileDropdown();
  const info = getUserInfo();
  const modal = $('profileModal');
  if (!modal) return;
  
  const mAvatar = $('modalProfileAvatar');
  if (mAvatar) {
    if (info.avatarUrl) {
      mAvatar.innerHTML = `<img src="${escapeHtml(info.avatarUrl)}" alt="${escapeHtml(info.name)}" class="profile-avatar-img" onerror="this.onerror=null;this.parentElement.innerHTML='${escapeHtml(info.initial)}';">`;
    } else if (info.isLoggedIn) {
      mAvatar.textContent = info.initial;
    } else {
      mAvatar.innerHTML = '👤';
    }
  }

  if ($('modalProfileName')) $('modalProfileName').textContent = currentUsername ? `@${currentUsername}` : info.name;
  if ($('modalProfileEmail')) $('modalProfileEmail').textContent = info.email;
  const uBadge = $('modalProfileUsernameBadge');
  if (uBadge) {
    if (currentUsername) {
      uBadge.style.display = 'inline-block';
      uBadge.textContent = `@${currentUsername}`;
    } else {
      uBadge.style.display = 'none';
    }
  }
  if ($('modalProfileStatus')) {
    $('modalProfileStatus').textContent = info.isLoggedIn ? '✓ Google Account Connected' : 'Guest Mode (Local Practice)';
    $('modalProfileStatus').style.background = info.isLoggedIn ? '#dcfce7' : '#eff6ff';
    $('modalProfileStatus').style.color = info.isLoggedIn ? '#166534' : '#1e40af';
  }

  const totalExercises = scenarios.length || 240;
  const verifiedCount = scenarios.filter(s => isCompleted(s, state.entries[s.id])).length;
  if ($('modalProfileSolved')) $('modalProfileSolved').textContent = `${verifiedCount} / ${totalExercises}`;
  if ($('modalProfileSync')) {
    $('modalProfileSync').textContent = info.isLoggedIn ? 'Cloud Sync Active' : 'Saved on Device';
    $('modalProfileSync').style.color = info.isLoggedIn ? '#166534' : '#64748b';
  }

  const earnedCerts = getEarnedCertificates(scenarios, state, user, currentUsername);
  if ($('modalProfileCertificates')) {
    $('modalProfileCertificates').textContent = `${earnedCerts.length} / 21 Earned`;
  }

  const authBtn = $('modalAuthActionBtn');
  if (authBtn) {
    authBtn.textContent = info.isLoggedIn ? 'Sign Out' : 'Sign in with Google';
    authBtn.className = info.isLoggedIn ? 'action danger-btn' : 'action primary';
    authBtn.style.background = info.isLoggedIn ? '#dc2626' : 'var(--primary)';
    authBtn.style.color = '#ffffff';
    authBtn.style.fontWeight = '700';
  }

  modal.hidden = false;
}

function closeProfileModal() {
  const modal = $('profileModal');
  if (modal) modal.hidden = true;
}

function handleModalAuthAction() {
  closeProfileModal();
  if (user) {
    signOut();
  } else {
    signInWithGoogle();
  }
}

function openMyProgress() {
  closeProfileDropdown();
  showScreen('progressScreen');
}

function handleProfileSignOut() {
  closeProfileDropdown();
  if (user) {
    signOut();
  } else {
    signInWithGoogle();
  }
}

let isCurrentUserAdmin = false;

async function checkAdminStatus() {
  if (!user || !client) {
    isCurrentUserAdmin = false;
    updateAdminPortalVisibility();
    return { isAdmin: false, error: null };
  }

  let isAuthorized = false;
  let lastError = null;

  // 1. Authoritative check via RPC is_admin()
  try {
    const { data: rpcAdmin, error: rpcErr } = await client.rpc('is_admin');
    if (!rpcErr && typeof rpcAdmin === 'boolean') {
      isAuthorized = rpcAdmin;
    } else if (rpcErr) {
      lastError = rpcErr;
      console.warn('[AdminCheck] RPC is_admin notice:', rpcErr);
    }
  } catch (e) {
    lastError = e;
    console.warn('[AdminCheck] RPC is_admin exception:', e);
  }

  // 2. Direct protected admin_users table check (protected role source)
  if (!isAuthorized) {
    try {
      const { data: adminRow, error: adminErr } = await client
        .from('admin_users')
        .select('role')
        .eq('user_id', user.id)
        .maybeSingle();

      if (!adminErr && adminRow) {
        isAuthorized = true;
        lastError = null;
      } else if (adminErr && adminErr.code !== 'PGRST116') {
        lastError = adminErr;
        console.warn('[AdminCheck] admin_users query notice:', adminErr);
      }
    } catch (e) {
      lastError = e;
      console.warn('[AdminCheck] admin_users exception:', e);
    }
  }

  // 3. Fallback to protected profiles.is_admin
  if (!isAuthorized) {
    try {
      const { data: profileRow, error: profErr } = await client
        .from('profiles')
        .select('is_admin')
        .eq('id', user.id)
        .maybeSingle();

      if (!profErr && profileRow?.is_admin === true) {
        isAuthorized = true;
        lastError = null;
      } else if (profErr) {
        lastError = profErr;
        console.warn('[AdminCheck] profiles is_admin query notice:', profErr);
      }
    } catch (e) {
      lastError = e;
      console.warn('[AdminCheck] profiles is_admin exception:', e);
    }
  }

  isCurrentUserAdmin = isAuthorized;
  updateAdminPortalVisibility();
  return { isAdmin: isAuthorized, error: lastError };
}

function updateAdminPortalVisibility() {
  const adminBtn = $('adminPortalBtn');
  if (adminBtn) {
    adminBtn.hidden = !isCurrentUserAdmin;
  }
  const headerAdminBtn = $('headerAdminPortalBtn');
  if (headerAdminBtn) {
    headerAdminBtn.hidden = !isCurrentUserAdmin;
  }
}

function openAdminPortal() {
  closeProfileDropdown();
  const loc = window.location;
  if (loc.pathname.includes('/D2d/')) {
    const basePath = loc.pathname.substring(0, loc.pathname.indexOf('/D2d/') + 5);
    window.location.href = `${loc.origin}${basePath}admin.html`;
    return;
  }
  if (loc.pathname.endsWith('/D2d')) {
    window.location.href = `${loc.origin}${loc.pathname}/admin.html`;
    return;
  }
  window.location.href = new URL('admin.html', loc.href).href;
}

function toggleNotificationsDropdown(event) {
  if (event) event.stopPropagation();
  closeProfileDropdown();
  const dropdown = $('notificationsDropdown');
  if (!dropdown) return;
  const isHidden = dropdown.hidden;
  dropdown.hidden = !isHidden;
  const btn = $('notificationsBtn');
  if (btn) btn.setAttribute('aria-expanded', String(isHidden));
  if (isHidden) {
    updateNotificationsUI();
  }
}

function closeNotificationsDropdown() {
  const dropdown = $('notificationsDropdown');
  if (dropdown && !dropdown.hidden) {
    dropdown.hidden = true;
    const btn = $('notificationsBtn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }
}

function markAllNotificationsRead() {
  const contestState = typeof getContestState === 'function' ? getContestState() : null;
  const list = getNotifications({
    scenarios,
    state,
    user,
    currentUsername,
    activeContest: contestState?.contest || null
  });
  markAllNotificationsAsRead(list);
  updateNotificationsUI();
}

function handleNotificationAction(notifId, type, domain, level, completionDate) {
  if (type === 'certificate') {
    claimCertificateNotification(notifId);
    updateNotificationsUI();
    closeNotificationsDropdown();
    const learnerName = getLearnerDisplayName(user, currentUsername);
    openCertificateModal({
      domain: domain || 'Banking',
      level: level || 'Beginner',
      userName: learnerName,
      completionDate: completionDate || formatCompletionDate(Date.now())
    });
  } else if (type === 'contest') {
    markNotificationRead(notifId);
    updateNotificationsUI();
    closeNotificationsDropdown();
    showScreen('home');
    const contestCard = $('contestInvitationCard') || $('contestWaitingCard');
    if (contestCard) contestCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    markNotificationRead(notifId);
    updateNotificationsUI();
    closeNotificationsDropdown();
    showScreen('progressScreen');
  }
}

document.addEventListener('click', event => {
  const container = $('profileContainer');
  if (container && !container.contains(event.target)) {
    closeProfileDropdown();
  }
  const notifContainer = $('notificationsContainer');
  if (notifContainer && !notifContainer.contains(event.target)) {
    closeNotificationsDropdown();
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeProfileDropdown();
    closeNotificationsDropdown();
    closeProfileModal();
    closeMotivationModal();
    closeCertificateModal();
    closeLevelCompletionModal();
  }
});

// Global helpers for certificate interactions
window.viewCertificate = (domain, level, completionDate) => {
  const learnerName = getLearnerDisplayName(user, currentUsername);
  openCertificateModal({
    domain,
    level,
    userName: learnerName,
    completionDate: completionDate || formatCompletionDate(Date.now())
  });
};

window.downloadCertificateDirect = (domain, level, completionDate) => {
  const learnerName = getLearnerDisplayName(user, currentUsername);
  currentCertificateTarget = {
    domain,
    level,
    userName: learnerName,
    completionDate: completionDate || formatCompletionDate(Date.now())
  };
  void downloadCertificateImage(currentCertificateTarget);
};

window.practiceDomainAndLevel = (domain, level) => {
  practiceDomain(domain);
  const lvlIndex = level === 'Beginner' ? 1 : level === 'Intermediate' ? 2 : 3;
  selectLevel(level, document.querySelector(`.level:nth-child(${lvlIndex})`));
};

Object.assign(window,{
  selectDomain,selectLevel,evaluatePlan,evaluateSql,nextScenario,goHome,
  generateSql,copySqlAndOpenFiddle,copyAllScripts,
  copySetup,copyQuery,runDbFiddle,resetProgress,importOldHistory,importGuestProgress,importCloudHistory,
  retrySync,signInWithGoogle,signOut,installApp,
  showScreen,openScenario,showSampleThinking,improveLogic,compareExpert,closeCompare,
  useStarterSql,showStepSql,closeStepSql,selectSampleTable,setSchemaTab,practiceDomain,
  filterScenarioSearch,filterProgressDomain,filterProgressStatus,filterProgressSearch,
  setDomainTrack,openOnboarding,closeOnboarding,toggleLandscapeMode,
  toggleProfileDropdown,closeProfileDropdown,openProfileModal,closeProfileModal,
  handleModalAuthAction,openMyProgress,handleProfileSignOut,openAdminPortal,
  copySchemaAndOpenFiddle,isCompleted,isAttempted,
  copyLearnerSql,clearLearnerSql,updateSqlEditorView,resetCurrentSqlSession,
  saveFirstTimeUsername,validateUsernameField,closeUsernameModal,
  checkAdminStatus,retryUserAccessCheck,
  openMotivationPopup,closeMotivationModal,handleMotivationRetry,handleMotivationNext,
  openLevelCompletionModal,closeLevelCompletionModal,
  handleViewCertificateFromAchievement,handleDownloadCertificateFromAchievement,
  startNextLevel,handlePracticeAgain,
  openCertificateModal,closeCertificateModal,
  handleDownloadCertificatePng,handlePrintCertificatePdf,
  renderCertificatesSection,
  checkLevelCompletion,getEarnedCertificates,getAllCertificatesStatus,
  toggleNotificationsDropdown,closeNotificationsDropdown,markAllNotificationsRead,handleNotificationAction,
  updateNotificationsUI,
  sqlEngineManager
});
try {
  initLandscapeMode();
  initNotificationsState(null);
  renderProfileAvatar();
  const response=await fetch('./data/scenarios.json');
  if(!response.ok)throw Error('Scenario download failed');
  data=await response.json();scenarios=data.scenarios;ids=new Set(scenarios.map(s=>s.id));
  state=readProgress(storage,null,ids);
  document.querySelectorAll('.domain,.level').forEach(el=>{
    el.setAttribute('role','button');el.tabIndex=0;
    el.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();el.click();}});
  });
  const thinkingEl = $('thinking');
  if (thinkingEl) {
    thinkingEl.addEventListener('input',()=>{
      const cur = entry();
      changeEntry({
        thinking: readThinking(),
        assessment: cur.assessment || null,
        completed: false,
        status: 'in_progress',
        fiddleFingerprint: null,
        evaluationFingerprint: null,
        evaluationResult: null
      }, false);
      renderAssessment(null);
      if(typeof renderSqlEvaluation==='function') renderSqlEvaluation(null);
      updateGates();
    });
  }
  const sqlInput = $('learnerSql');
  if (sqlInput) {
    sqlInput.addEventListener('input', () => {
      changeEntry({ sql: sqlInput.value, fiddleFingerprint: null, evaluationFingerprint: null, evaluationResult: null });
      renderSqlEvaluation(null);
      updateSqlEditorView();
      updateGates();
    });
    sqlInput.addEventListener('scroll', syncEditorScroll);
    sqlInput.addEventListener('keydown', event => {
      if (event.key === 'Tab') {
        event.preventDefault();
        const start = sqlInput.selectionStart;
        const end = sqlInput.selectionEnd;
        const val = sqlInput.value;
        sqlInput.value = val.substring(0, start) + '  ' + val.substring(end);
        sqlInput.selectionStart = sqlInput.selectionEnd = start + 2;
        sqlInput.dispatchEvent(new Event('input'));
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        evaluateSql();
      }
    });
  }
  const solutionHelpEl = $('solutionHelp');
  if (solutionHelpEl) {
    solutionHelpEl.addEventListener('toggle',()=>{
      if(solutionHelpEl.open && current && stage(current,entry())==='verified'){
        if ($('pseudo')) $('pseudo').textContent=current.pseudo;
        if ($('referenceSql')) $('referenceSql').textContent=current.sql;
        changeEntry({answerViewed:true});
      }
    });
  }
  updateProgress();
  renderScenarioCatalog();
  initAppChrome();
  void initAuth();
  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
} catch(error) {
  if ($('syncStatus')) $('syncStatus').textContent='Could not load exercises. Reconnect and reload this page.';
  console.error(error);
}
