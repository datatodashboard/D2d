import {evaluateThinking, thinkingIsReady, thinkingText} from './thinking.js';
import {EMPTY, readProgress, saveProgress, mergeProgress, nextTimestamp, workFingerprint, stage, chooseNext, importLegacy, storageKey} from './progress.js';
import {createCloudSync} from './cloud.js';
import {renderSchemaCards} from './schema.js';
import {escapeHtml} from './util.js';
import {SqlEvaluator,loadBrowserPGlite} from './sql-evaluator.js';

const $ = id => document.getElementById(id);
let data, scenarios=[], ids=new Set(), state=EMPTY(), current=null, user=null;
let selectedDomain=null, selectedLevel=null, client=null, deferredPrompt=null, syncTimer=null;
let authNotice='';
let sqlEvaluator=null,sqlEvaluationRunning=false;
let storage;
try { storage=window.localStorage; } catch { storage={getItem(){return null;},setItem(){throw Error('Storage unavailable');}}; }
const labels={not_started:'Not started',thinking:'Thinking in progress',answer_viewed:'Earlier answer viewed — thinking not assessed',thinking_ready:'Thinking ready',sql_written:'SQL draft saved',fiddle_opened:'SQL draft saved',verified:'SQL verified'};
const cloud=createCloudSync({
  client: {rpc(...args){return client.rpc(...args);}},
  getContext:()=>({userId:user?.id,state:structuredClone(state)}),
  onMerged(remote,owner) {
    if(owner!==user?.id) return;
    const before=current?JSON.stringify(state.entries[current.id]):null;
    state=mergeProgress(state,remote,ids);
    persist(false); updateProgress();
    // Local edits have their own timestamp and win over older cloud snapshots.
    if(current && before!==JSON.stringify(state.entries[current.id])) renderScenario();
  },
  onStatus:message=>{ $('syncStatus').textContent=message; }
});
function persist(sync=true) {
  const saved=saveProgress(storage,user?.id,state);
  if(!saved) $('syncStatus').textContent='Browser storage is unavailable. Keep this page open; local progress cannot be saved.';
  else if(!user) $('syncStatus').textContent='Guest progress saved on this device.';
  if(sync && user && client) {
    clearTimeout(syncTimer);
    syncTimer=setTimeout(()=>cloud.request(),500);
  }
}
function entry() { return current ? state.entries[current.id] || {} : {}; }
function changeEntry(patch) {
  if(!current) return;
  state.entries[current.id]={...entry(),...patch,updatedAt:nextTimestamp(state)};
  persist(); updateProgress();
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
  const stages = activeScenarios.map(s => stage(s, state.entries[s.id]));
  const verified = stages.filter(x => x === 'verified').length;
  if ($('progressCount')) $('progressCount').textContent = verified + ' / ' + activeScenarios.length;
  if ($('progressFill')) $('progressFill').style.width = (activeScenarios.length ? verified / activeScenarios.length * 100 : 0) + '%';
  if ($('progressStages')) {
    $('progressStages').textContent = stages.filter(x => x !== 'not_started').length + ' started · ' +
      stages.filter(x => ['thinking_ready', 'sql_written', 'fiddle_opened', 'verified'].includes(x)).length + ' thinking ready · ' + verified + ' verified';
  }
  if (current) {
    if ($('learningStage')) $('learningStage').textContent = labels[stage(current, entry())];
    if ($('doneTag')) {
      $('doneTag').classList.toggle('show', stage(current, entry()) === 'verified');
      $('doneTag').textContent = 'SQL verified';
    }
  }
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
  
  $('score').textContent = `Thinking Score: ${score} / 10 points`;
  $('assessmentMessage').textContent = result.message;
  
  const sourcePassed = result.items.some(i => i.category === 'data' && i.passed);
  const actionPassed = result.items.some(i => i.category === 'approach' && i.passed);
  const resultPassed = result.items.some(i => i.category === 'result' && i.passed);
  
  const updateChip = (id, name, passed, weight) => {
    const el = $(id);
    if (!el) return;
    el.className = 'score-chip ' + (passed ? 'pass' : 'fail');
    el.textContent = (passed ? '✓ ' : '○ ') + name + ` (${weight})`;
  };
  updateChip('chipSources', 'Sources', sourcePassed, '3 pts');
  updateChip('chipSteps', 'Logic / Action', actionPassed, '4 pts');
  updateChip('chipGoal', 'Expected Output', resultPassed, '3 pts');
  const chipCheck = $('chipCheck');
  if (chipCheck) chipCheck.style.display = 'none';
  
  $('improve').replaceChildren(...result.items.map(item => {
    const li = document.createElement('li');
    const pts = item.weight || (item.category === 'approach' ? 4 : 3);
    li.textContent = (item.passed ? `✓ [${item.name} +${pts} pts]: ` : `○ [${item.name} missing]: `) + item.label;
    if (item.passed) li.classList.add('pass-item');
    return li;
  }));

  // Decode and show: "This is how you have to think"
  if (howToThinkBox && current) {
    howToThinkBox.hidden = false;
    howToThinkBox.innerHTML = `
      <div class="how-to-think-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px;">
          <strong style="color:#0369a1;font-size:14px;">💡 How to Think Like a Data Engineer (Decoded):</strong>
          <span style="font-size:11px;background:#e0f2fe;color:#0369a1;padding:2px 8px;border-radius:12px;font-weight:700;">Human Thought Flow</span>
        </div>
        <div style="font-size:13px;line-height:1.6;color:var(--ink);">
          <div style="margin-bottom:6px;"><strong>1. Data Source:</strong> From the <code>${current.tables.join(', ')}</code> table${current.tables.length > 1 ? 's' : ''}, where this data lives.</div>
          <div style="margin-bottom:6px;"><strong>2. Core Action / Logic:</strong> ${escapeHtml(current.pseudo || 'Apply the required filter, join, or aggregation logic to isolate the target rows.')}</div>
          <div><strong>3. Desired Result:</strong> Show the requested details in the final output.</div>
        </div>
        <div style="margin-top:14px;">
          <button class="action primary" onclick="generateSql()" style="font-size:14px;padding:10px 20px;background:var(--primary);color:#fff;font-weight:800;border-radius:10px;cursor:pointer;border:none;">
            ⚡ Click here to generate the proper SQL
          </button>
        </div>
      </div>
    `;
  }
}
function updateGates() {
  const e = entry(), ready = current && thinkingIsReady(current, e), hasSql = !!e.sql?.trim();
  if ($('sqlSection')) $('sqlSection').hidden = false;
  if ($('checkSqlButton')) $('checkSqlButton').disabled = !hasSql || sqlEvaluationRunning;
  if ($('checkSqlBtnLabel')) {
    $('checkSqlBtnLabel').textContent = sqlEvaluationRunning ? 'Checking query…' : 'Check / Run SQL';
  }
  if ($('sqlGate')) {
    if (!hasSql) {
      $('sqlGate').textContent = 'Write your PostgreSQL query or click "⚡ Generate SQL" to load the query.';
      $('sqlGate').style.color = 'var(--muted)';
    } else {
      $('sqlGate').textContent = 'Ready: Click "Check / Run SQL" (or Ctrl + Enter) to test your query against PostgreSQL.';
      $('sqlGate').style.color = 'var(--ink)';
    }
  }
  if ($('practiceStatus')) $('practiceStatus').textContent = current ? labels[stage(current, e)] : '';
  const verified = current && stage(current, e) === 'verified';
  if ($('nextButton')) $('nextButton').disabled = !verified;
  if ($('solutionHelp')) $('solutionHelp').hidden = !verified;
  if (!verified && $('solutionHelp')) {
    $('solutionHelp').open = false;
    if ($('referenceSql')) $('referenceSql').textContent = '';
    if ($('pseudo')) $('pseudo').textContent = '';
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
      ${preview ? `<pre id="sqlPreview" class="sql-preview-table">${escapeHtml(previewText)}</pre>` : '<pre id="sqlPreview" hidden></pre>'}
    `;
  } else {
    updateSqlEditorStatus('PostgreSQL • Query error', 'error');
    box.className = 'sql-error-card';
    let guidance = 'Check the column name and try again.';
    if (/relation .* does not exist/i.test(result.message || '')) {
      guidance = 'Check the table name and try again.';
    } else if (/syntax error/i.test(result.message || '')) {
      guidance = 'Check your SQL syntax and try again.';
    }
    box.innerHTML = `
      <div class="sql-error-title-row">
        <span class="sql-error-icon">⚠</span>
        <span class="sql-error-label" id="sqlEvaluationTitle">SQL Error</span>
      </div>
      <div class="sql-error-code-msg" id="sqlEvaluationMessage">${escapeHtml(result.message || 'Query execution error or mismatch.')}</div>
      <div class="sql-error-guidance">${escapeHtml(guidance)}</div>
      <pre id="sqlPreview" hidden></pre>
    `;
  }
}

function renderScenario() {
  $('home').classList.remove('active');$('progressScreen').classList.remove('active');$('practice').classList.add('active');
  if ($('navHome')) { $('navHome').classList.remove('active'); $('navProgress').classList.remove('active'); $('navPractice').classList.add('active'); }
  $('meta').textContent=current.domain+' • '+current.level;
  $('title').textContent=current.id;$('question').textContent=current.question;
  const pool=scenarios.filter(s=>s.domain===current.domain&&s.level===current.level);
  $('qno').textContent='Exercise '+current.questionNo+' / '+pool.length;
  $('tags').textContent='Think → Write → Validate';
  renderSchemaCards(current.schemaText);
  setSchemaTab('schema');
  const e=entry();
  $('thinking').value=thinkingText(e.thinking);
  $('learnerSql').value=e.sql||'';
  if ($('fiddleFallback')) $('fiddleFallback').hidden = true;
  if ($('manualCopy')) $('manualCopy').hidden = true;
  renderAssessment(e.assessment?evaluateThinking(current,e.thinking||{}):null);
  renderSqlEvaluation(e.evaluationFingerprint===workFingerprint(e)?e.evaluationResult:null);
  updateSqlEditorView();
  updateProgress();updateGates();
}
function loadScenario() {
  if(!selectedDomain||!selectedLevel) return;
  const pool=scenarios.filter(s=>s.domain===selectedDomain&&s.level===selectedLevel);
  current=chooseNext(pool,state,null)||pool[0];
  if(current) renderScenario();
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
  const thinking=readThinking(),assessment=evaluateThinking(current,thinking);
  changeEntry({thinking,assessment});
  renderAssessment(assessment);updateGates();
  if(assessment.ready) $('learnerSql').focus();
}
function nextScenario() {
  if(!current || stage(current,entry())!=='verified') {alert('Finish your thinking and pass the SQL result check before continuing.');return;}
  const pool=scenarios.filter(s=>s.domain===selectedDomain&&s.level===selectedLevel);
  const next=chooseNext(pool,state,current.id);
  if(!next) {
    current=pool[(pool.findIndex(s=>s.id===current.id)+1)%pool.length];renderScenario();
    $('practiceStatus').textContent='All exercises in this selection are verified. You are reviewing completed work.';return;
  }
  current=next;renderScenario();
}
function showScreen(name) {
  $('home').classList.toggle('active', name === 'home');
  $('practice').classList.toggle('active', name === 'practice');
  $('progressScreen').classList.toggle('active', name === 'progress');
  if ($('navHome')) $('navHome').classList.toggle('active', name === 'home');
  if ($('navPractice')) $('navPractice').classList.toggle('active', name === 'practice');
  if ($('navProgress')) $('navProgress').classList.toggle('active', name === 'progress');
  if (name === 'progress') {
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
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function goHome() { showScreen('home'); }
function openScenario(id) {
  const target = scenarios.find(s => s.id === id);
  if (!target) return;
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
  $('thinking').value = current.exampleThinking || current.pseudo;
  evaluatePlan();
}
function improveLogic() {
  if (!current) return;
  const currentThinking = $('thinking').value.trim();
  const evaluation = evaluateThinking(current, { response: currentThinking });
  const unpassed = evaluation.items.filter(i => !i.passed);
  if (unpassed.length === 0) {
    $('assessmentMessage').textContent = 'Your plan already satisfies all rubric criteria! You are ready to write SQL.';
    return;
  }
  const suggestions = [];
  unpassed.forEach(item => {
    if (item.category === 'result') {
      suggestions.push('• Target Goal: We need to ' + current.question.toLowerCase().replace(/\.$/, '') + '.');
    } else if (item.category === 'data') {
      suggestions.push('• Data Sources: Query the table(s) ' + current.tables.join(', ') + '.');
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
  const userPlan = $('thinking').value.trim() || '(No thinking written yet)';
  $('userThinkingCompare').textContent = userPlan;
  $('expertThinkingCompare').textContent = current.exampleThinking || current.pseudo;
  $('expertPseudoCompare').textContent = current.pseudo;
  const evaluation = evaluateThinking(current, { response: userPlan });
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
  const sql = current.sql;
  $('learnerSql').value = sql;
  changeEntry({ sql, fiddleFingerprint: null, evaluationFingerprint: null, evaluationResult: null });
  renderSqlEvaluation(null);
  updateSqlEditorView();
  updateGates();
  updateSqlEditorStatus('PostgreSQL • Ready', 'ready');
  if ($('sqlGate')) {
    $('sqlGate').textContent = '✨ PostgreSQL query generated from plan! Review or check it locally, or copy to DB Fiddle.';
    $('sqlGate').style.color = '#166534';
  }
  // Scroll smoothly to SQL section
  const sec = $('sqlSection');
  if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('learnerSql').focus();
}

function useStarterSql() {
  if (!current) return;
  let starter = '';
  if (/^WITH\b/i.test(current.sql)) {
    starter = `-- Starter CTE Template\nWITH base_data AS (\n  SELECT *\n  FROM ${current.tables[0]}\n  -- Filter or transform here\n)\nSELECT *\nFROM base_data;\n`;
  } else {
    starter = `-- Starter Query Template\nSELECT \n  -- specify required columns\nFROM ${current.tables[0]}\n${current.tables.length > 1 ? current.tables.slice(1).map(t => 'JOIN ' + t + ' ON ...').join('\n') + '\n' : ''}-- WHERE condition\n;\n`;
  }
  $('learnerSql').value = starter;
  changeEntry({ sql: starter, fiddleFingerprint: null, evaluationFingerprint: null, evaluationResult: null });
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
  const tableNames = current.tables.filter(t => parsed[t]).length ? current.tables.filter(t => parsed[t]) : Object.keys(parsed);
  if (tableNames.length === 0) {
    container.innerHTML = '<p class="small">No sample data available for this scenario.</p>';
    return;
  }
  if (!currentSampleTable || !tableNames.includes(currentSampleTable)) {
    currentSampleTable = tableNames[0];
  }
  const tData = parsed[currentSampleTable];
  if (!tData) {
    container.innerHTML = '<p class="small">Sample table data not found.</p>';
    return;
  }
  container.innerHTML = `
    <div class="sample-table-tabs">
      ${tableNames.map(t => `
        <button class="sample-tab ${t === currentSampleTable ? 'active' : ''}" onclick="selectSampleTable('${t}')">
          ${t} (${parsed[t]?.rows?.length || 0} rows)
        </button>
      `).join('')}
    </div>
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
    ${tData.rows.length > 10 ? `<div class="small muted" style="margin-top:6px;">Showing first 10 of ${tData.rows.length} sample rows in database fixture</div>` : ''}
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
    const stg = stage(s, e);
    const isCurrent = current && current.id === s.id;
    let badgeClass = 'status-pill not-started';
    let badgeText = 'Not started';
    if (stg === 'verified') {
      badgeClass = 'status-pill verified';
      badgeText = '✓ Verified';
    } else if (stg === 'thinking_ready') {
      badgeClass = 'status-pill thinking';
      badgeText = '🧠 Ready';
    } else if (stg === 'sql_written') {
      badgeClass = 'status-pill draft';
      badgeText = '📝 Draft';
    }
    return `
      <div class="catalog-item ${isCurrent ? 'active' : ''}" onclick="openScenario('${s.id}')">
        <div class="catalog-item-header">
          <span class="catalog-id">${s.id}</span>
          <span class="catalog-domain-tag">${s.domain} • ${s.level}</span>
          <span class="${badgeClass}">${badgeText}</span>
        </div>
        <div class="catalog-question">${escapeHtml(s.question)}</div>
      </div>
    `;
  }).join('');
}

function renderProgressScreen() {
  if (!scenarios.length) return;
  const stages = scenarios.map(s => stage(s, state.entries[s.id]));
  const verified = stages.filter(x => x === 'verified').length;
  const started = stages.filter(x => x !== 'not_started').length;
  const pct = ((verified / scenarios.length) * 100).toFixed(1);
  
  let totalScore = 0, countWithScore = 0;
  for (const s of scenarios) {
    const e = state.entries[s.id];
    if (e?.assessment?.score !== undefined) {
      totalScore += e.assessment.score;
      countWithScore++;
    }
  }
  const avgScore = countWithScore ? (totalScore / countWithScore).toFixed(1) : '0.0';
  
  if ($('progressScreenCount')) $('progressScreenCount').textContent = `${verified} / ${scenarios.length}`;
  if ($('progressScreenPct')) $('progressScreenPct').textContent = `${pct}%`;
  if ($('progressScreenAvg')) $('progressScreenAvg').textContent = `${avgScore} / 10`;
  if ($('progressScreenStarted')) $('progressScreenStarted').textContent = `${started}`;
  
  const domains = ['Banking', 'Healthcare', 'Insurance', 'Capital Markets', 'Semiconductor', 'Education', 'Retail'];
  const domainIcons = {
    'Banking': '🏦', 'Healthcare': '🏥', 'Insurance': '🛡️',
    'Capital Markets': '📈', 'Semiconductor': '🔬', 'Education': '🎓', 'Retail': '🛒'
  };
  const domainNotes = {
    'Banking': 'Accounts & transactions', 'Healthcare': 'Patients & visits',
    'Insurance': 'Policies & claims', 'Capital Markets': 'Investors & trades',
    'Semiconductor': 'Batches & chip tests', 'Education': 'Students & assessments',
    'Retail': 'Orders & products'
  };
  
  if ($('progressDomainCards')) {
    $('progressDomainCards').innerHTML = domains.map(d => {
      const dScenarios = scenarios.filter(s => s.domain === d);
      const dVerified = dScenarios.filter(s => stage(s, state.entries[s.id]) === 'verified').length;
      const dPct = ((dVerified / dScenarios.length) * 100).toFixed(0);
      const beg = dScenarios.filter(s => s.level === 'Beginner' && stage(s, state.entries[s.id]) === 'verified').length;
      const int = dScenarios.filter(s => s.level === 'Intermediate' && stage(s, state.entries[s.id]) === 'verified').length;
      const exp = dScenarios.filter(s => s.level === 'Expert' && stage(s, state.entries[s.id]) === 'verified').length;
      
      return `
        <div class="domain-stat-card">
          <div class="domain-stat-head">
            <div class="domain-stat-icon">${domainIcons[d] || '📁'}</div>
            <div style="flex:1">
              <div class="domain-stat-title">${d}</div>
              <div class="domain-stat-sub">${domainNotes[d] || ''}</div>
            </div>
            <div class="domain-stat-count"><b>${dVerified}</b> / ${dScenarios.length} (${dPct}%)</div>
          </div>
          <div class="progress-track" style="margin: 8px 0 6px;"><div class="progress-fill" style="width:${dPct}%"></div></div>
          <div class="domain-stat-levels">
            <span>Beg: ${beg}/20</span>
            <span>Int: ${int}/20</span>
            <span>Exp: ${exp}/20</span>
            <button class="ghost-btn-sm" onclick="practiceDomain('${escapeHtml(d)}')">Practice Domain</button>
          </div>
        </div>
      `;
    }).join('');
  }
  renderProgressTable();
}

let progressDomainFilter = 'All';
let progressStatusFilter = 'All';
let progressSearchText = '';

function filterProgressDomain(d) {
  progressDomainFilter = d;
  document.querySelectorAll('.p-dom-btn').forEach(b => b.classList.toggle('active', b.textContent.trim() === d));
  renderProgressTable();
}
function filterProgressStatus(st) {
  progressStatusFilter = st;
  document.querySelectorAll('.p-status-btn').forEach(b => b.classList.toggle('active', b.dataset.status === st));
  renderProgressTable();
}
function filterProgressSearch(q) {
  progressSearchText = q.toLowerCase().trim();
  renderProgressTable();
}

function renderProgressTable() {
  const container = $('progressTableBody');
  if (!container) return;
  let list = scenarios;
  if (progressDomainFilter !== 'All') {
    list = list.filter(s => s.domain === progressDomainFilter);
  }
  if (progressStatusFilter !== 'All') {
    list = list.filter(s => {
      const st = stage(s, state.entries[s.id]);
      return progressStatusFilter === 'verified' ? st === 'verified' :
             progressStatusFilter === 'started' ? st !== 'not_started' :
             st === 'not_started';
    });
  }
  if (progressSearchText) {
    list = list.filter(s => s.id.toLowerCase().includes(progressSearchText) || s.question.toLowerCase().includes(progressSearchText));
  }
  
  if ($('progressResultCount')) $('progressResultCount').textContent = `Showing ${Math.min(list.length, 50)} of ${list.length} exercises`;
  
  container.innerHTML = list.slice(0, 50).map(s => {
    const e = state.entries[s.id] || {};
    const stg = stage(s, e);
    const score = e?.assessment?.score !== undefined ? e.assessment.score + '/10' : '—';
    let statusPill = '<span class="status-pill not-started">Not started</span>';
    if (stg === 'verified') statusPill = '<span class="status-pill verified">✓ Verified</span>';
    else if (stg === 'thinking_ready') statusPill = '<span class="status-pill thinking">🧠 Ready</span>';
    else if (stg === 'sql_written') statusPill = '<span class="status-pill draft">📝 Draft</span>';
    
    return `
      <tr>
        <td><b>${s.id}</b></td>
        <td>${s.domain}</td>
        <td>${s.level}</td>
        <td>${score}</td>
        <td>${statusPill}</td>
        <td><button class="ghost-btn-sm" onclick="openScenario('${s.id}')">Open</button></td>
      </tr>
    `;
  }).join('');
}

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
      $('sqlGate').textContent = 'No SQL query found. Type a query or click "⚡ Click here to generate the proper SQL".';
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
  const all = `-- =========================================\n-- DB FIDDLE SCHEMA + SAMPLE DATA (LEFT PANE)\n-- =========================================\n${setup}\n\n-- =========================================\n-- YOUR SQL QUERY (RIGHT PANE)\n-- =========================================\n${sql || current.sql};\n`;
  void copy(all, 'All scripts (Schema + Sample data + SQL)');
}

function runDbFiddle() {
  if (!current) return;
  window.open('https://www.db-fiddle.com/', '_blank', 'noopener,noreferrer');
  changeEntry({ fiddleFingerprint: workFingerprint(entry()) });
  if ($('fiddleFallback')) $('fiddleFallback').hidden = false;
  if ($('sqlGate')) {
    $('sqlGate').textContent = 'DB Fiddle opened! Paste schema on the left and SQL on the right, then run.';
    $('sqlGate').style.color = '#0369a1';
  }
  updateGates();
}

function copySqlAndOpenFiddle() {
  if (!current) return;
  const sql = ($('learnerSql')?.value || entry().sql || current.sql || '').trim();
  if (sql) {
    try { navigator.clipboard.writeText(sql); } catch {}
  }
  window.open('https://www.db-fiddle.com/', '_blank', 'noopener,noreferrer');
  changeEntry({ fiddleFingerprint: workFingerprint(entry()) });
  if ($('fiddleFallback')) $('fiddleFallback').hidden = false;
  if ($('sqlGate')) {
    $('sqlGate').textContent = '✓ SQL copied to clipboard & DB Fiddle opened! Select PostgreSQL and paste in query pane.';
    $('sqlGate').style.color = '#0369a1';
  }
  updateGates();
}

async function evaluateSql() {
  const e = entry();
  const sql = (e.sql || $('learnerSql')?.value || '').trim();
  if (sqlEvaluationRunning || !current || !sql) {
    if (!sql && $('sqlGate')) {
      $('sqlGate').textContent = 'Please enter or generate a SQL query before checking.';
      $('sqlGate').style.color = 'var(--warn)';
    }
    return;
  }
  sqlEvaluationRunning = true;
  updateSqlEditorStatus('PostgreSQL • Checking...', 'checking');
  renderSqlEvaluation({ passed: false, message: 'Executing query in PostgreSQL sandbox engine…' });
  updateGates();
  try {
    if (!sqlEvaluator) sqlEvaluator = new SqlEvaluator(await loadBrowserPGlite());
    const result = await sqlEvaluator.evaluate(current, data.assets[current.domain], sql);
    const fingerprint = workFingerprint(entry());
    changeEntry({
      evaluationFingerprint: result.passed ? fingerprint : null,
      evaluationResult: result,
      evaluationAt: Date.now(),
      attempts: (entry().attempts || 0) + 1
    });
    renderSqlEvaluation(result);
  } catch (error) {
    renderSqlEvaluation({ passed: false, message: 'The local SQL engine could not start. Check your connection once, then retry.' });
    console.error(error);
  } finally {
    sqlEvaluationRunning = false;
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
function retrySync() {if(user&&client)cloud.request();else $('syncStatus').textContent='Sign in to sync. Guest practice is saved only on this device.';}
function renderAuth() {
  $('authBox').innerHTML=user?'<div class="auth-row"><span>Signed in as '+escapeHtml(user.email||'learner')+'</span><button class="linkbtn" onclick="signOut()">Sign out</button></div>':
    client?'<div class="auth-row"><button id="googleSignIn" class="action primary" onclick="signInWithGoogle()">Continue with Google</button></div><p class="small">Sign in to sync your progress, or choose a domain below to practise as a guest.</p><p id="authMessage" role="status" aria-live="polite"></p>':'Guest mode: accounts are unavailable. You can still practise on this device.';
  if($('authMessage'))$('authMessage').textContent=authNotice;
  $('importGuest').hidden=!user;
  $('importCloud').hidden=!user;
  renderProfileAvatar();
}
function setSession(session) {
  const next=session?.user||null;
  if(next)authNotice='';
  if(user?.id===next?.id) {renderAuth();return;}
  clearTimeout(syncTimer);cloud.changeSession();user=next;state=readProgress(storage,user?.id,ids);
  renderAuth();updateProgress();if(current)renderScenario();
  if(user)cloud.request();else $('syncStatus').textContent='Guest profile. Signed-in progress stays separate.';
}
async function signInWithGoogle() {
  const button=$('googleSignIn'),message=$('authMessage');
  if(!client || !button || button.disabled)return;
  button.disabled=true;button.textContent='Connecting to Google…';
  authNotice='';if(message)message.textContent='';
  try {
    const {error}=await client.auth.signInWithOAuth({
      provider:'google',
      options:{
        redirectTo:location.origin+location.pathname,
        queryParams:{prompt:'select_account'}
      }
    });
    if(error)throw error;
  } catch {
    button.disabled=false;button.textContent='Continue with Google';
    authNotice='Google sign-in could not start. Please retry. If it keeps failing, check the Google provider and allowed redirect URLs in Supabase. Your guest progress is saved.';
    if(message)message.textContent=authNotice;
  }
}
async function signOut() {
  try {const {error}=await client.auth.signOut();if(error)throw error;setSession(null);}
  catch {alert('Sign-out failed. Please try again; your account has not been switched.');}
}
async function initAuth() {
  try {
    client=window.supabase?.createClient('https://qklnaqfspvmnlequqagf.supabase.co','sb_publishable_dthVX8zmvd1HvWaYWBaojA_2YbvHWe1')||null;
    renderAuth();if(!client)return;
    const callback=new URLSearchParams(location.hash.slice(1));
    if(callback.has('error')||callback.has('error_description')) {
      const message=$('authMessage');
      authNotice='Google sign-in was cancelled or unsuccessful. Please try again.';
      if(message)message.textContent=authNotice;
      history.replaceState(null,'',location.pathname+location.search);
    }
    // Register first, and do database work only after the auth callback returns.
    let authEventSeen=false;
    client.auth.onAuthStateChange((_event,session)=>{authEventSeen=true;setTimeout(()=>setSession(session),0);});
    const {data:auth,error}=await client.auth.getSession();
    if(error)throw error;
    if(!authEventSeen)setSession(auth.session);
  } catch {$('syncStatus').textContent='Account connection unavailable. Local practice is still available.';renderAuth();}
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

function getUserInfo() {
  if (!user) {
    return {
      isLoggedIn: false,
      name: 'Guest Learner',
      email: 'Practicing on this device',
      initial: 'G',
      avatarUrl: null
    };
  }
  const meta = user.user_metadata || {};
  const name = meta.full_name || meta.name || (user.email ? user.email.split('@')[0] : 'Learner');
  const email = user.email || 'learner@local';
  const initial = (name[0] || email[0] || 'U').toUpperCase();
  const avatarUrl = meta.avatar_url || meta.picture || null;
  return {
    isLoggedIn: true,
    name,
    email,
    initial,
    avatarUrl
  };
}

function renderProfileAvatar() {
  const info = getUserInfo();
  
  const avatarContent = $('profileAvatarContent');
  if (avatarContent) {
    if (info.avatarUrl) {
      avatarContent.innerHTML = `<img src="${escapeHtml(info.avatarUrl)}" alt="${escapeHtml(info.name)}" class="profile-avatar-img" onerror="this.onerror=null;this.parentElement.innerHTML='<span class=\\'profile-avatar-initial\\'>${escapeHtml(info.initial)}</span>';">`;
    } else if (info.isLoggedIn) {
      avatarContent.innerHTML = `<span class="profile-avatar-initial">${escapeHtml(info.initial)}</span>`;
    } else {
      avatarContent.innerHTML = `<span style="font-size:18px;">👤</span>`;
    }
  }

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
  if (ddName) ddName.textContent = info.name;

  const ddEmail = $('dropdownEmail');
  if (ddEmail) ddEmail.textContent = info.email;

  const signOutLabel = $('profileSignOutLabel');
  if (signOutLabel) {
    signOutLabel.textContent = info.isLoggedIn ? 'Sign Out' : 'Sign in with Google';
  }
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

  if ($('modalProfileName')) $('modalProfileName').textContent = info.name;
  if ($('modalProfileEmail')) $('modalProfileEmail').textContent = info.email;
  if ($('modalProfileStatus')) {
    $('modalProfileStatus').textContent = info.isLoggedIn ? '✓ Google Account Connected' : 'Guest Mode (Local Practice)';
    $('modalProfileStatus').style.background = info.isLoggedIn ? '#dcfce7' : '#eff6ff';
    $('modalProfileStatus').style.color = info.isLoggedIn ? '#166534' : '#1e40af';
  }

  const totalExercises = scenarios.length || 240;
  const verifiedCount = scenarios.filter(s => stage(s, state.entries[s.id]) === 'verified').length;
  if ($('modalProfileSolved')) $('modalProfileSolved').textContent = `${verifiedCount} / ${totalExercises}`;
  if ($('modalProfileSync')) {
    $('modalProfileSync').textContent = info.isLoggedIn ? 'Cloud Sync Active' : 'Saved on Device';
    $('modalProfileSync').style.color = info.isLoggedIn ? '#166534' : '#64748b';
  }

  const authBtn = $('modalAuthActionBtn');
  if (authBtn) {
    authBtn.textContent = info.isLoggedIn ? 'Sign Out' : 'Sign in with Google';
    authBtn.className = info.isLoggedIn ? 'action secondary' : 'action primary';
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

document.addEventListener('click', event => {
  const container = $('profileContainer');
  if (container && !container.contains(event.target)) {
    closeProfileDropdown();
  }
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeProfileDropdown();
    closeProfileModal();
  }
});

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
  handleModalAuthAction,openMyProgress,handleProfileSignOut,
  copyLearnerSql,clearLearnerSql,updateSqlEditorView
});
try {
  initLandscapeMode();
  renderProfileAvatar();
  const response=await fetch('./data/scenarios.json');
  if(!response.ok)throw Error('Scenario download failed');
  data=await response.json();scenarios=data.scenarios;ids=new Set(scenarios.map(s=>s.id));
  state=readProgress(storage,null,ids);
  document.querySelectorAll('.domain,.level').forEach(el=>{
    el.setAttribute('role','button');el.tabIndex=0;
    el.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();el.click();}});
  });
  $('thinking').addEventListener('input',()=>{
    changeEntry({thinking:readThinking(),assessment:null,fiddleFingerprint:null,evaluationFingerprint:null,evaluationResult:null});
    renderAssessment(null);renderSqlEvaluation(null);updateGates();
  });
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
  $('solutionHelp').addEventListener('toggle',()=>{
    if($('solutionHelp').open && current && stage(current,entry())==='verified'){
      $('pseudo').textContent=current.pseudo;$('referenceSql').textContent=current.sql;changeEntry({answerViewed:true});
    }
  });
  updateProgress();
  renderScenarioCatalog();
  initAppChrome();
  void initAuth();
  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
} catch(error) {
  $('syncStatus').textContent='Could not load exercises. Reconnect and reload this page.';
  console.error(error);
}
