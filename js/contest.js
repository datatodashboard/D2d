// Crack SQL Thinking Contest — Participant Client Controller
// Completely isolated module for Admin-controlled thinking contests
import { escapeHtml } from './util.js';
import { parseSchema, inferReference, TABLE_ICONS } from './schema.js';

let activeClient = null;
let activeUser = null;
let activeIsAdmin = false;
let currentCompletedCount = 0;
let currentContest = null;
let currentRegistration = null;
let currentPayment = null;
let currentAttempt = null;
let currentEvaluation = null;

let timerInterval = null;
let autoSaveInterval = null;
let isSubmitting = false;

const $ = id => document.getElementById(id);

export function getContestState() {
  return {
    contest: currentContest,
    registration: currentRegistration,
    payment: currentPayment,
    attempt: currentAttempt,
    evaluation: currentEvaluation,
    isAdmin: activeIsAdmin
  };
}

// Initialize Contest on login or refresh
export async function initContest(client, user, completedCount = 0, isAdmin = false) {
  activeClient = client;
  activeUser = user;
  activeIsAdmin = Boolean(isAdmin);
  currentCompletedCount = Number(completedCount) || 0;

  hideContestCard();
  closeContestModal();

  if (!client || !user) {
    currentContest = null;
    return;
  }

  // 1. Enforce Qualification: Learners must have completed >= 18 questions.
  // Admins are exempt from the 18-completion requirement for testing.
  if (currentCompletedCount < 18 && !activeIsAdmin) {
    currentContest = null;
    hideContestCard();
    return;
  }

  // For legitimate learners with >= 18 completions, persist contest_eligible
  if (currentCompletedCount >= 18) {
    try {
      await client.from('profiles').update({
        contest_eligible: true,
        completed_count: currentCompletedCount,
        last_active: new Date().toISOString()
      }).eq('id', user.id);
    } catch (profErr) {
      console.warn('Profile contest_eligible update notice:', profErr);
    }
  }

  try {
    // 2. Fetch admin published/enabled contest
    const { data: contests, error: contestErr } = await client
      .from('contests')
      .select('*')
      .in('status', ['PUBLISHED', 'REGISTRATION_CLOSED', 'CONTEST_CLOSED', 'EVALUATION', 'RESULTS_PUBLISHED'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (contestErr || !contests || contests.length === 0) {
      currentContest = null;
      if (activeIsAdmin) {
        renderAdminNoContestCard();
      } else if (currentCompletedCount >= 18) {
        renderContestWaitingCard();
      }
      return;
    }

    const contest = contests[0];

    // If contest is not published/enabled for participation, and no attempt has been started:
    if (contest.status !== 'PUBLISHED' && contest.status !== 'RESULTS_PUBLISHED') {
      currentContest = null;
      if (activeIsAdmin) {
        renderAdminNoContestCard();
      } else if (currentCompletedCount >= 18) {
        renderContestWaitingCard();
      }
      return;
    }

    // 3. Check audience eligibility: Admins can access any published contest regardless of audience
    if (contest.audience_type !== 'ALL' && !activeIsAdmin) {
      const { data: elig, error: eligErr } = await client
        .from('contest_eligibility')
        .select('id')
        .eq('contest_id', contest.id)
        .eq('user_id', user.id)
        .maybeSingle();

      if (eligErr || !elig) {
        // Not in targeted audience
        currentContest = null;
        renderContestWaitingCard();
        return;
      }
    }

    currentContest = contest;

    // 4. Load user's contest registration, payment, attempt
    await refreshUserContestRecords();

    // 5. Render official contest invitation card
    renderContestCard();

    // 6. If user was in the middle of an attempt (IN_PROGRESS), automatically restore contest modal
    if (currentAttempt && currentAttempt.status === 'IN_PROGRESS') {
      openContestModal('active');
    }
  } catch (err) {
    console.warn('[Contest] Initialization check notice:', err);
    if (activeIsAdmin) {
      renderAdminNoContestCard();
    } else if (currentCompletedCount >= 18) {
      renderContestWaitingCard();
    }
  }
}

export async function refreshUserContestRecords() {
  if (!activeClient || !activeUser || !currentContest) return;

  const [regRes, payRes, attRes, evalRes] = await Promise.all([
    activeClient.from('contest_registrations').select('*').eq('contest_id', currentContest.id).eq('user_id', activeUser.id).maybeSingle(),
    activeClient.from('contest_payments').select('*').eq('contest_id', currentContest.id).eq('user_id', activeUser.id).maybeSingle(),
    activeClient.from('contest_attempts').select('*').eq('contest_id', currentContest.id).eq('user_id', activeUser.id).maybeSingle(),
    currentContest.status === 'RESULTS_PUBLISHED'
      ? activeClient.from('contest_evaluations').select('*').eq('contest_id', currentContest.id).eq('user_id', activeUser.id).maybeSingle()
      : Promise.resolve({ data: null })
  ]);

  currentRegistration = regRes.data || null;
  currentPayment = payRes.data || null;
  currentAttempt = attRes.data || null;
  currentEvaluation = evalRes?.data || null;
}

export function hideContestCard() {
  const card = $('contestCardWrapper');
  if (card) card.style.display = 'none';
}

export function renderContestWaitingCard() {
  let wrapper = $('contestCardWrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = 'contestCardWrapper';
    const home = $('home');
    const progressCard = document.querySelector('.progress-card');
    if (home && progressCard) {
      home.insertBefore(wrapper, progressCard);
    } else if (home) {
      home.prepend(wrapper);
    }
  }

  wrapper.style.display = 'block';
  wrapper.innerHTML = `
    <div class="contest-invitation-card" style="border: 1px solid #bae6fd; background: linear-gradient(135deg, #f0fdf4 0%, #f8fafc 100%);">
      <div class="contest-card-header">
        <div class="contest-tag" style="background:#dcfce7;color:#15803d;padding:4px 10px;border-radius:999px;font-weight:800;font-size:0.8rem;">
          <span>🏆 Contest Eligible</span>
        </div>
        <div class="contest-fee-badge" style="background:#e0f2fe;color:#0284c7;font-weight:700;">18+ Solved</div>
      </div>
      <h3 class="contest-card-title" style="font-size:1.05rem;margin-top:8px;line-height:1.4;">
        Congratulations! You have completed 18 SQL thinking challenges and are now eligible for Think and Crack SQL contests.
      </h3>
      <p style="font-size:0.88rem;color:var(--muted);margin:8px 0 0;line-height:1.5;">
        You're contest eligible. The next contest will appear here when it is announced.
      </p>
    </div>
  `;
}

export function renderAdminNoContestCard() {
  let wrapper = $('contestCardWrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = 'contestCardWrapper';
    const home = $('home');
    const progressCard = document.querySelector('.progress-card');
    if (home && progressCard) {
      home.insertBefore(wrapper, progressCard);
    } else if (home) {
      home.prepend(wrapper);
    }
  }

  wrapper.style.display = 'block';
  wrapper.innerHTML = `
    <div class="contest-invitation-card" style="border: 1px solid #cbd5e1; background: #f8fafc;">
      <div class="contest-card-header">
        <div class="contest-tag" style="background:#e2e8f0;color:#334155;padding:4px 10px;border-radius:999px;font-weight:800;font-size:0.8rem;">
          <span>🛠️ Contest Management</span>
        </div>
        <div class="contest-fee-badge" style="background:#f1f5f9;color:#64748b;">Admin Mode</div>
      </div>
      <h3 class="contest-card-title" style="font-size:1.05rem;margin-top:8px;line-height:1.4;">
        No contest is currently published for participation.
      </h3>
      <p style="font-size:0.88rem;color:var(--muted);margin:8px 0 12px;line-height:1.5;">
        As an administrator, you can create, publish, and manage contests from the Admin Portal.
      </p>
      <button class="action secondary sm" onclick="window.openAdminPortal ? window.openAdminPortal() : (window.location.href='admin.html')" style="font-weight:700;">
        Open Contest Management →
      </button>
    </div>
  `;
}

export function renderContestCard() {
  if (!currentContest) {
    hideContestCard();
    return;
  }

  let wrapper = $('contestCardWrapper');
  if (!wrapper) {
    wrapper = document.createElement('div');
    wrapper.id = 'contestCardWrapper';
    // Insert nicely on the Home screen right above the progress card
    const home = $('home');
    const progressCard = document.querySelector('.progress-card');
    if (home && progressCard) {
      home.insertBefore(wrapper, progressCard);
    } else if (home) {
      home.prepend(wrapper);
    }
  }

  wrapper.style.display = 'block';

  let btnLabel = 'Join Contest';
  let btnIcon = '🚀';
  let badgeText = activeIsAdmin ? 'ADMIN ACCESS' : '🏆 Contest Eligible';
  let badgeClass = 'contest-badge-live';

  if (currentAttempt?.status === 'SUBMITTED') {
    btnLabel = currentContest.status === 'RESULTS_PUBLISHED' ? 'VIEW RESULTS & RANK 🏆' : 'VIEW OFFICIAL SUBMISSION';
    btnIcon = '📋';
    badgeText = 'SUBMITTED';
    badgeClass = 'contest-badge-submitted';
  } else if (currentAttempt?.status === 'IN_PROGRESS') {
    btnLabel = 'RESUME CONTEST ⚡';
    btnIcon = '⏱️';
    badgeText = 'IN PROGRESS';
    badgeClass = 'contest-badge-progress';
  } else if (activeIsAdmin || currentPayment?.status === 'VERIFIED' || Number(currentContest.entry_fee) === 0) {
    btnLabel = 'Join Contest';
    btnIcon = '🚪';
    badgeText = activeIsAdmin ? 'ADMIN EXEMPT' : 'READY';
    badgeClass = 'contest-badge-ready';
  } else if (currentRegistration) {
    btnLabel = 'Join Contest';
    btnIcon = '💳';
    badgeText = 'PAYMENT PENDING';
    badgeClass = 'contest-badge-pending';
  }

  const feeDisplay = activeIsAdmin 
    ? 'ADMIN EXEMPT' 
    : (Number(currentContest.entry_fee) > 0 ? `₹${currentContest.entry_fee}` : 'FREE ENTRY');

  const subtitleHtml = activeIsAdmin && currentCompletedCount < 18
    ? 'Administrator Contest Access — Testing Mode (Payment &amp; 18-Question Exempt)'
    : 'Congratulations! You have completed 18 SQL thinking challenges and are now eligible for Think and Crack SQL contests.';

  wrapper.innerHTML = `
    <div class="contest-invitation-card" style="border: 2px solid #2563eb; background: linear-gradient(135deg, #eff6ff 0%, #ffffff 100%);">
      <div class="contest-card-glow"></div>
      <div class="contest-card-header">
        <div class="contest-tag" style="background:#dcfce7;color:#15803d;padding:4px 10px;border-radius:999px;font-weight:800;font-size:0.8rem;">
          <span class="pulse-dot"></span>
          <span>${activeIsAdmin ? '🛠️ Admin Contest' : '🏆 Contest Eligible'}</span>
          <span class="${badgeClass}" style="margin-left:6px;">${badgeText}</span>
        </div>
        <div class="contest-fee-badge">${feeDisplay}</div>
      </div>

      <div style="font-size:0.88rem;font-weight:700;color:#1e40af;margin-top:8px;line-height:1.4;">
        ${subtitleHtml}
      </div>

      <h3 class="contest-card-title" style="margin-top:6px;">${escapeHtml(currentContest.title)}</h3>
      <p class="contest-card-tagline">Think beyond syntax. Solve with logic.</p>
      
      <div class="contest-card-prizes">
        <div class="prize-pill">🥇 1st: <strong>${escapeHtml(currentContest.first_prize || '₹1,000')}</strong></div>
        <div class="prize-pill">🥈 2nd: <strong>${escapeHtml(currentContest.second_prize || '₹500')}</strong></div>
        <div class="prize-pill">🥉 3rd: <strong>${escapeHtml(currentContest.third_prize || '₹250')}</strong></div>
      </div>

      <div class="contest-card-footer">
        <button id="contestJoinBtn" class="contest-action-btn">
          <span>${btnIcon}</span>
          <span>${btnLabel}</span>
        </button>
      </div>
    </div>
  `;

  $('contestJoinBtn')?.addEventListener('click', handleContestAction);
}

function handleContestAction() {
  if (!currentContest) return;

  // Route to the appropriate screen
  if (currentAttempt?.status === 'SUBMITTED') {
    openContestModal('submitted');
  } else if (currentAttempt?.status === 'IN_PROGRESS') {
    openContestModal('active');
  } else if (currentRegistration?.agreed_rules) {
    if (activeIsAdmin || currentPayment?.status === 'VERIFIED' || Number(currentContest.entry_fee) === 0) {
      openContestModal('ready');
    } else {
      openContestModal('payment');
    }
  } else {
    openContestModal('details');
  }
}

// Modal View Switcher: 'details' | 'payment' | 'ready' | 'active' | 'submitted'
export function openContestModal(stage = 'details') {
  let modal = $('contestModalContainer');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'contestModalContainer';
    modal.className = 'contest-modal-overlay';
    document.body.appendChild(modal);
  }

  modal.style.display = 'flex';
  modal.innerHTML = renderModalContent(stage);
  attachModalListeners(stage);

  if (stage === 'active') {
    startActiveContestRuntime();
  }
}

export function closeContestModal() {
  const modal = $('contestModalContainer');
  if (modal) modal.style.display = 'none';
  stopTimers();
}

export function parseContestTestContent(contest) {
  const c = contest || {};
  let question = (c.question || '').trim();
  let scenarioDesc = '';
  let expectedOutput = c.expected_output || c.expected_columns || null;
  let schemaText = (c.schema_text || c.schema || '').trim();

  const rawScenario = (c.scenario_text || '').trim();

  // If rawScenario contains explicit section markers:
  if (rawScenario) {
    const hasQuestionMarker = /^(?:Question|Problem Statement|Task|Challenge Question):\s*/im.test(rawScenario);
    const hasScenarioMarker = /(?:Scenario|Background|Business Context|Scenario Description):\s*/im.test(rawScenario);
    const hasOutputMarker = /(?:Expected Output|Expected Output Columns|Output Columns|Target Columns):\s*/im.test(rawScenario);
    const hasSchemaMarker = /(?:Database Schema|Schema|Tables):\s*/im.test(rawScenario);

    if (hasQuestionMarker || hasScenarioMarker || hasOutputMarker || hasSchemaMarker) {
      const lines = rawScenario.split('\n');
      let currentSection = 'scenario';
      const sectionBuffers = { question: [], scenario: [], output: [], schema: [] };

      for (const line of lines) {
        if (/^(?:Question|Problem Statement|Task|Challenge Question):\s*/i.test(line)) {
          currentSection = 'question';
          const rem = line.replace(/^(?:Question|Problem Statement|Task|Challenge Question):\s*/i, '').trim();
          if (rem) sectionBuffers.question.push(rem);
        } else if (/^(?:Scenario|Background|Business Context|Scenario Description):\s*/i.test(line)) {
          currentSection = 'scenario';
          const rem = line.replace(/^(?:Scenario|Background|Business Context|Scenario Description):\s*/i, '').trim();
          if (rem) sectionBuffers.scenario.push(rem);
        } else if (/^(?:Expected Output|Expected Output Columns|Output Columns|Target Columns):\s*/i.test(line)) {
          currentSection = 'output';
          const rem = line.replace(/^(?:Expected Output|Expected Output Columns|Output Columns|Target Columns):\s*/i, '').trim();
          if (rem) sectionBuffers.output.push(rem);
        } else if (/^(?:Database Schema|Schema|Tables):\s*/i.test(line)) {
          currentSection = 'schema';
          const rem = line.replace(/^(?:Database Schema|Schema|Tables):\s*/i, '').trim();
          if (rem) sectionBuffers.schema.push(rem);
        } else {
          sectionBuffers[currentSection].push(line);
        }
      }

      if (sectionBuffers.question.length && !question) question = sectionBuffers.question.join('\n').trim();
      if (sectionBuffers.scenario.length) scenarioDesc = sectionBuffers.scenario.join('\n').trim();
      if (sectionBuffers.output.length && !expectedOutput) expectedOutput = sectionBuffers.output.join('\n').trim();
      if (sectionBuffers.schema.length && !schemaText) schemaText = sectionBuffers.schema.join('\n').trim();
    } else {
      // Plain text scenario:
      // Separate background narrative and the specific operational question
      const questionRegex = /(?:Explain step by step how you would|Your task is to|Identify all|Calculate the|Find the|Determine the)[\s\S]+$/i;
      const qMatch = rawScenario.match(questionRegex);
      if (qMatch && !question) {
        question = qMatch[0].trim();
        scenarioDesc = rawScenario.substring(0, qMatch.index).trim();
      } else {
        scenarioDesc = rawScenario;
      }
    }
  }

  // Fallbacks if missing
  if (!question) {
    question = c.title ? `Contest Challenge: ${c.title}` : 'Explain step by step how you would identify the required data, join keys, filtering logic, and calculate the final expected results.';
  }
  if (!scenarioDesc) {
    scenarioDesc = rawScenario || 'You are presented with a real-world enterprise database challenge. Carefully examine the problem statement and database schema below to formulate your solution strategy.';
  }

  // Deduce or provide standard schema and expected output if not provided
  if (!schemaText) {
    const combined = (rawScenario + ' ' + question).toLowerCase();
    if (combined.includes('patient') || combined.includes('appointment') || combined.includes('doctor') || combined.includes('clinic')) {
      schemaText = 'patients(patient_id PK, patient_name, city, segment, joined_date); doctors(doctor_id PK, doctor_name, category, status, base_value); appointments(appointment_id PK, patient_id FK, doctor_id FK, appointment_date, status, bill_amount); visits(visit_id PK, appointment_id FK, visit_date, visit_type, quantity, amount, status)';
      if (!expectedOutput) {
        expectedOutput = [
          { column: 'patient_id', description: 'Unique patient identifier' },
          { column: 'patient_name', description: 'Full name of the patient' },
          { column: 'total_appointments', description: 'Total scheduled appointments' },
          { column: 'cancelled_appointments', description: 'Total number of cancelled appointments' },
          { column: 'cancellation_rate', description: 'Calculated cancellation percentage' }
        ];
      }
    } else {
      // Default Banking / Financial Fraud scenario
      schemaText = 'customers(customer_id PK, customer_name, city, segment, joined_date); accounts(account_id PK, customer_id FK, product_id FK, open_date, status, balance); transactions(transaction_id PK, account_id FK, transaction_date, transaction_type, quantity, amount, status); account_products(product_id PK, product_name, category, status, base_value)';
      if (!expectedOutput) {
        expectedOutput = [
          { column: 'account_id', description: 'Unique account identifier' },
          { column: 'customer_name', description: 'Name of the impacted account holder' },
          { column: 'compromised_transactions', description: 'Count of abnormal or flagged transactions' },
          { column: 'total_financial_exposure', description: 'Sum total of compromised transaction amounts in INR' },
          { column: 'first_incident_at', description: 'Timestamp of earliest detected anomalous transaction' }
        ];
      }
    }
  }

  return {
    title: c.title || 'Crack SQL Thinking Contest',
    question,
    scenarioDescription: scenarioDesc,
    expectedOutput,
    schemaText,
    instructions: c.instructions
  };
}

function renderExpectedOutputBlock(expectedOutput) {
  if (!expectedOutput) return '';

  if (Array.isArray(expectedOutput) && expectedOutput.length > 0) {
    return `
      <div class="test-expected-output-card">
        <div class="expected-output-heading">
          <span class="out-icon">📋</span>
          <strong>Expected Output Columns:</strong>
        </div>
        <table class="test-columns-table">
          <thead>
            <tr>
              <th style="width:38%;">Column Name</th>
              <th>Description / Expectation</th>
            </tr>
          </thead>
          <tbody>
            ${expectedOutput.map(col => `
              <tr>
                <td class="col-name-cell font-mono"><code>${escapeHtml(col.column || col.name || '')}</code></td>
                <td class="col-desc-cell">${escapeHtml(col.description || col.desc || 'Required output attribute')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  if (typeof expectedOutput === 'string' && expectedOutput.trim()) {
    const lines = expectedOutput.trim().split('\n').filter(Boolean);
    return `
      <div class="test-expected-output-card">
        <div class="expected-output-heading">
          <span class="out-icon">📋</span>
          <strong>Expected Output Columns:</strong>
        </div>
        <ul style="margin: 0; padding-left: 20px; font-size: 0.9rem; color: #334155; line-height: 1.6;">
          ${lines.map(line => `<li>${escapeHtml(line.replace(/^[-*•]\s*/, ''))}</li>`).join('')}
        </ul>
      </div>
    `;
  }

  return '';
}

function renderContestSchemaBlock(schemaText) {
  const tables = parseSchema(schemaText);
  if (!tables.length) {
    return `<div class="test-schema-empty text-muted">No explicit schema defined.</div>`;
  }

  const tableNames = tables.map(t => t.name);

  return `
    <div class="test-schema-intro">The following database tables and attributes are available to construct your solution:</div>
    <div class="test-schema-grid">
      ${tables.map(t => {
        const icon = TABLE_ICONS[t.name] || '🗂️';
        return `
          <div class="test-schema-card">
            <div class="test-schema-card-head">
              <div style="display:flex;align-items:center;gap:6px;">
                <span class="test-table-icon">${icon}</span>
                <span class="test-table-name font-mono">${escapeHtml(t.name)}</span>
              </div>
              <span class="test-table-count">${t.columns.length} columns</span>
            </div>
            <div class="test-schema-card-body">
              <table class="test-schema-table">
                <thead>
                  <tr>
                    <th>Column</th>
                    <th>Key / Relationship</th>
                  </tr>
                </thead>
                <tbody>
                  ${t.columns.map(c => {
                    let keyBadge = '';
                    if (c.key === 'PK') {
                      keyBadge = '<span class="test-badge-pk" title="Primary Key">PK</span>';
                    } else if (c.key === 'FK') {
                      const refTarget = inferReference(c.name, tableNames, t.name);
                      keyBadge = `<span class="test-badge-fk" title="Foreign Key">FK</span> ${refTarget ? `<span class="test-fk-ref">→ ${escapeHtml(refTarget)}</span>` : ''}`;
                    } else {
                      keyBadge = '<span class="test-badge-none">—</span>';
                    }

                    return `
                      <tr>
                        <td class="test-col-name font-mono" style="font-weight:600;">${escapeHtml(c.name)}</td>
                        <td class="test-col-key">${keyBadge}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderModalContent(stage) {
  if (!currentContest) return '';

  const feeDisplay = Number(currentContest.entry_fee) > 0 ? `₹${currentContest.entry_fee}` : 'FREE';

  if (stage === 'details') {
    return `
      <div class="contest-modal-window">
        <div class="contest-modal-header">
          <div>
            <div class="contest-badge-header">CONTEST DETAILS &amp; INSTRUCTIONS</div>
            <h2 class="contest-modal-title">${escapeHtml(currentContest.title)}</h2>
          </div>
          <button class="contest-modal-close" onclick="window.closeContestModal()">✕</button>
        </div>
        <div class="contest-modal-body">
          <div class="contest-info-grid">
            <div class="info-cell">
              <span class="cell-label">Entry Fee</span>
              <span class="cell-val highlight">${feeDisplay}</span>
            </div>
            <div class="info-cell">
              <span class="cell-label">🥇 1st Prize</span>
              <span class="cell-val">${escapeHtml(currentContest.first_prize || '₹1,000')}</span>
            </div>
            <div class="info-cell">
              <span class="cell-label">🥈 2nd Prize</span>
              <span class="cell-val">${escapeHtml(currentContest.second_prize || '₹500')}</span>
            </div>
            <div class="info-cell">
              <span class="cell-label">🥉 3rd Prize</span>
              <span class="cell-val">${escapeHtml(currentContest.third_prize || '₹250')}</span>
            </div>
          </div>

          <div class="contest-section-block">
            <h4>Description</h4>
            <p>${escapeHtml(currentContest.description || 'Welcome to the official Crack SQL Thinking Contest. Put your data architecture and logical deduction skills to the test.')}</p>
          </div>

          <div class="contest-section-block highlight-box">
            <h4>🧠 What is evaluated?</h4>
            <p><strong>This contest evaluates HOW YOU THINK about a data problem.</strong></p>
            <p>Participants are <strong>NOT required to write SQL</strong>. You will be asked to explain the procedural and logical steps you would follow to solve the business challenge.</p>
          </div>

          <div class="contest-section-block">
            <h4>Contest Rules &amp; Guidelines</h4>
            <ul class="contest-rules-list">
              <li>Each participant is permitted exactly <strong>ONE official attempt</strong>.</li>
              <li>Once you click <em>Start Contest</em>, your official timer begins and <strong>cannot be paused or reset</strong>.</li>
              <li>Your draft approach is auto-saved as you type. If you refresh, your timer and draft will resume smoothly.</li>
              <li>Evaluation is based on requirement comprehension, entity identification, procedural logic, and operational reasoning.</li>
              <li>${escapeHtml(currentContest.rules || 'Submission deadline and decisions made by the evaluation panel are final.')}</li>
            </ul>
          </div>

          <div class="contest-agreement-check">
            <label>
              <input type="checkbox" id="agreeRulesCheckbox" />
              <span>I have read and agree to the contest rules and conditions.</span>
            </label>
          </div>
        </div>

        <div class="contest-modal-footer">
          <button class="ghost-btn" onclick="window.closeContestModal()">Cancel</button>
          <button id="btnProceedToPayment" class="action primary" disabled>Continue to Registration →</button>
        </div>
      </div>
    `;
  }

  if (stage === 'payment') {
    const isPending = currentPayment?.status === 'PENDING';
    const isFee = Number(currentContest.entry_fee) > 0;

    return `
      <div class="contest-modal-window">
        <div class="contest-modal-header">
          <div>
            <div class="contest-badge-header">STEP 2 OF 3: REGISTRATION &amp; PAYMENT</div>
            <h2 class="contest-modal-title">Entry Fee Verification</h2>
          </div>
          <button class="contest-modal-close" onclick="window.closeContestModal()">✕</button>
        </div>

        <div class="contest-modal-body">
          <div class="payment-card">
            <div class="payment-amount-row">
              <span>Required Entry Fee:</span>
              <strong class="payment-fee">${feeDisplay}</strong>
            </div>
            <div class="payment-status-badge ${isPending ? 'pending' : 'ready'}">
              Status: <strong>${currentPayment ? currentPayment.status : (isFee ? 'UNPAID' : 'FREE')}</strong>
            </div>
          </div>

          ${isFee ? `
            <div class="contest-section-block">
              <h4>Payment Instructions</h4>
              <p>To participate, transfer the entry fee of <strong>₹${currentContest.entry_fee}</strong> via UPI or online transfer.</p>
              <div class="upi-box">
                <span class="upi-label">Admin UPI ID / Payment Handle:</span>
                <span class="upi-id"><strong>datatodashboard@upi</strong> (or scan desk QR)</span>
              </div>
              <p class="small text-muted" style="margin-top:8px;">
                Enter your transaction reference / UTR number below. Our administrator will verify your payment and activate your challenge room.
              </p>

              <div class="form-group" style="margin-top:14px;">
                <label for="txnRefInput" style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:6px;">Transaction Reference / UTR Number:</label>
                <input type="text" id="txnRefInput" class="contest-input" placeholder="e.g. UPI Ref 328491823901" value="${escapeHtml(currentPayment?.transaction_ref || '')}" />
              </div>

              <div id="paymentNotice" class="alert-box" style="margin-top:12px;${isPending ? '' : 'display:none;'}">
                ⏳ Payment verification submitted. Waiting for Admin verification. You can refresh anytime to check status.
              </div>
            </div>
          ` : `
            <div class="contest-section-block">
              <p>This contest has <strong>FREE entry</strong>! You can proceed directly to the challenge room.</p>
            </div>
          `}
        </div>

        <div class="contest-modal-footer">
          <button class="ghost-btn" onclick="openContestModal('details')">← Back</button>
          <button id="btnSubmitPayment" class="action primary">
            ${isPending ? 'Refresh Verification Status 🔄' : (isFee ? 'Submit Reference for Verification' : 'Proceed to Ready Screen →')}
          </button>
        </div>
      </div>
    `;
  }

  if (stage === 'ready') {
    return `
      <div class="contest-modal-window">
        <div class="contest-modal-header">
          <div>
            <div class="contest-badge-header">FINAL STEP</div>
            <h2 class="contest-modal-title">🏆 YOU’RE IN!</h2>
          </div>
          <button class="contest-modal-close" onclick="window.closeContestModal()">✕</button>
        </div>

        <div class="contest-modal-body text-center" style="padding:30px 20px;">
          <div class="ready-badge-icon">🎯</div>
          <h3>Your Crack SQL Challenge is ready.</h3>
          <p class="text-muted" style="max-width:440px;margin:10px auto 20px;">
            You have satisfied all entry and verification requirements for <strong>${escapeHtml(currentContest.title)}</strong>.
          </p>

          <div class="contest-warning-card">
            <span class="warning-icon">⚠️</span>
            <div class="warning-text">
              <strong>Official Timer Warning:</strong> Your official timer will start the instant you click <strong>START CONTEST</strong> and cannot be paused or reset.
            </div>
          </div>
        </div>

        <div class="contest-modal-footer" style="justify-content:center;gap:16px;">
          <button class="ghost-btn" onclick="window.closeContestModal()">I'll start later</button>
          <button id="btnBeginContest" class="action primary btn-lg">START CONTEST NOW 🚀</button>
        </div>
      </div>
    `;
  }

  if (stage === 'active') {
    const testData = parseContestTestContent(currentContest);

    return `
      <div class="contest-modal-window contest-fullscreen-mode">
        <div class="contest-active-topbar">
          <div class="contest-topbar-left">
            <span class="contest-live-dot"></span>
            <strong>🏆 CRACK SQL THINKING CHALLENGE</strong>
            <span class="text-muted" style="margin-left:8px;">| ${escapeHtml(testData.title)}</span>
          </div>
          <div class="contest-topbar-right">
            <div class="contest-timer-pill" id="contestTimerDisplay">
              ⏱️ <span id="timerDigits">00:00</span>
            </div>
            <span id="draftSaveIndicator" class="draft-indicator">Draft saved</span>
          </div>
        </div>

        <div class="contest-active-content">
          <div class="contest-test-paper">

            <!-- 1. Question / Scenario block -->
            <div class="contest-test-block test-block-question">
              <div class="test-block-header">
                <div class="test-block-num-badge">1</div>
                <div>
                  <h3 class="test-block-title">Question &amp; Business Scenario</h3>
                  <div class="test-block-subtitle">Understand the problem context, objectives, and expected output</div>
                </div>
              </div>

              <div class="test-block-content">
                <div class="test-question-box">
                  <div class="test-question-label">CONTEST QUESTION</div>
                  <div class="test-question-text">${escapeHtml(testData.question)}</div>
                </div>

                <div class="test-scenario-box">
                  <div class="test-scenario-label">SCENARIO DESCRIPTION</div>
                  <div class="test-scenario-body">${escapeHtml(testData.scenarioDescription)}</div>
                </div>

                ${renderExpectedOutputBlock(testData.expectedOutput)}
              </div>
            </div>

            <!-- 2. Database Schema block -->
            <div class="contest-test-block test-block-schema">
              <div class="test-block-header">
                <div class="test-block-num-badge">2</div>
                <div>
                  <h3 class="test-block-title">Database Schema</h3>
                  <div class="test-block-subtitle">Review available database tables, columns, and relationships</div>
                </div>
              </div>

              <div class="test-block-content">
                ${renderContestSchemaBlock(testData.schemaText)}
              </div>
            </div>

            <!-- 3. How to Write Your Answer block -->
            <div class="contest-test-block test-block-instructions">
              <div class="test-block-header">
                <div class="test-block-num-badge">3</div>
                <div>
                  <h3 class="test-block-title">How to Write Your Answer</h3>
                  <div class="test-block-subtitle">Submission instructions and guidelines</div>
                </div>
              </div>

              <div class="test-block-content">
                <div class="test-instructions-box">
                  <p class="test-instructions-intro">
                    Please write your solution approach clearly and step-by-step. Your answer is evaluated on your procedural logic and data thinking:
                  </p>
                  <div class="test-instructions-grid">
                    <div class="inst-item">
                      <span class="inst-badge">1</span>
                      <div>
                        <strong>Write your solution approach clearly:</strong>
                        <span>Describe your step-by-step methodology from source data to the final result.</span>
                      </div>
                    </div>
                    <div class="inst-item">
                      <span class="inst-badge">2</span>
                      <div>
                        <strong>Specify Tables &amp; Columns:</strong>
                        <span>Explicitly mention which tables and columns are required for each step.</span>
                      </div>
                    </div>
                    <div class="inst-item">
                      <span class="inst-badge">3</span>
                      <div>
                        <strong>Explain Logic &amp; Operations:</strong>
                        <span>Detail your filtering criteria, join conditions, aggregations, and business calculations.</span>
                      </div>
                    </div>
                    <div class="inst-item highlight-item">
                      <span class="inst-badge">★</span>
                      <div>
                        <strong>A full SQL query is NOT required:</strong>
                        <span>Focus on your thinking, procedural steps, and logical reasoning. You do not need to write raw SQL syntax.</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 4. Answer box block -->
            <div class="contest-test-block test-block-answer">
              <div class="test-block-header">
                <div class="test-block-num-badge">4</div>
                <div>
                  <h3 class="test-block-title">Answer Box</h3>
                  <div class="test-block-subtitle">Write your answer / thinking approach below</div>
                </div>
              </div>

              <div class="test-block-content">
                <textarea
                  id="contestThinkingInput"
                  class="contest-test-textarea"
                  placeholder="Explain your approach step by step. Consider the required data, tables, filters, relationships, calculations and expected result..."
                >${escapeHtml(currentAttempt?.draft_response || '')}</textarea>

                <div class="test-answer-footer">
                  <div class="test-footer-notes">
                    <span>🔒 Single official attempt</span>
                    <span class="footer-note-sep">•</span>
                    <span>Auto-saved to cloud</span>
                  </div>
                  <button id="btnSubmitContest" class="action primary contest-submit-btn">
                    Submit Answer
                  </button>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>
    `;
  }

  if (stage === 'submitted') {
    const timeFormatted = formatSeconds(currentAttempt?.elapsed_seconds || 0);
    const hasResults = currentContest.status === 'RESULTS_PUBLISHED' && currentEvaluation;

    return `
      <div class="contest-modal-window">
        <div class="contest-modal-header">
          <div>
            <div class="contest-badge-header">COMPLETION STATUS</div>
            <h2 class="contest-modal-title">🏆 CHALLENGE COMPLETED</h2>
          </div>
          <button class="contest-modal-close" onclick="window.closeContestModal()">✕</button>
        </div>

        <div class="contest-modal-body">
          <div class="submitted-confirmation-card">
            <div class="check-icon">✓</div>
            <h3>Your response has been successfully submitted!</h3>
            <p class="text-muted">Your attempt is locked and officially recorded.</p>
            <div class="submitted-meta-row">
              <div class="meta-pill">Time Taken: <strong>${timeFormatted}</strong></div>
              <div class="meta-pill">Status: <strong>${currentContest.status === 'RESULTS_PUBLISHED' ? 'RESULTS ANNOUNCED' : 'UNDER EVALUATION'}</strong></div>
            </div>
          </div>

          ${hasResults ? `
            <div class="contest-section-block results-box">
              <h4>🏆 Official Results</h4>
              <div class="results-score-row">
                <div class="score-card-big">
                  <span class="score-label">Final Score</span>
                  <span class="score-num">${currentEvaluation.admin_final_score} / 100</span>
                </div>
                ${currentEvaluation.rank ? `
                  <div class="score-card-big">
                    <span class="score-label">Rank</span>
                    <span class="score-num">#${currentEvaluation.rank}</span>
                  </div>
                ` : ''}
              </div>

              ${currentEvaluation.admin_feedback ? `
                <div class="feedback-card" style="margin-top:14px;">
                  <strong>Evaluator Feedback:</strong>
                  <p style="margin-top:6px;">${escapeHtml(currentEvaluation.admin_feedback)}</p>
                </div>
              ` : ''}
            </div>
          ` : `
            <div class="contest-section-block">
              <h4>Evaluation Notice</h4>
              <p>Our evaluation panel reviews all procedural submissions using our structured 100-point rubric. Official contest winners and prize distributions will be announced once evaluations are concluded.</p>
            </div>
          `}

          <div class="contest-section-block">
            <h4>Your Submitted Answer</h4>
            <div class="submitted-response-viewer">
              ${escapeHtml(currentAttempt?.final_response || currentAttempt?.draft_response || 'No response recorded.')}
            </div>
          </div>
        </div>

        <div class="contest-modal-footer">
          <button class="action primary" onclick="window.closeContestModal()">Return to Crack SQL</button>
        </div>
      </div>
    `;
  }

  return '';
}

function attachModalListeners(stage) {
  if (stage === 'details') {
    const chk = $('agreeRulesCheckbox');
    const btn = $('btnProceedToPayment');
    chk?.addEventListener('change', () => {
      if (btn) btn.disabled = !chk.checked;
    });

    btn?.addEventListener('click', async () => {
      if (!chk?.checked) return;
      btn.disabled = true;
      btn.textContent = 'Saving…';

      try {
        // Record registration
        await activeClient.from('contest_registrations').upsert({
          contest_id: currentContest.id,
          user_id: activeUser.id,
          user_email: activeUser.email,
          agreed_rules: true,
          agreed_at: new Date().toISOString()
        }, { onConflict: 'contest_id,user_id' });

        await refreshUserContestRecords();

        if (Number(currentContest.entry_fee) === 0 || activeIsAdmin) {
          openContestModal('ready');
        } else {
          openContestModal('payment');
        }
      } catch (err) {
        alert('Could not save registration: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Continue to Registration →';
      }
    });
  }

  if (stage === 'payment') {
    const btn = $('btnSubmitPayment');
    btn?.addEventListener('click', async () => {
      const isFee = Number(currentContest.entry_fee) > 0;
      if (!isFee) {
        openContestModal('ready');
        return;
      }

      const txnRef = $('txnRefInput')?.value.trim();
      btn.disabled = true;
      btn.textContent = 'Verifying…';

      try {
        await activeClient.from('contest_payments').upsert({
          contest_id: currentContest.id,
          user_id: activeUser.id,
          amount: Number(currentContest.entry_fee),
          currency: 'INR',
          status: 'PENDING',
          transaction_ref: txnRef || null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'contest_id,user_id' });

        await refreshUserContestRecords();

        if (currentPayment?.status === 'VERIFIED') {
          openContestModal('ready');
        } else {
          const notice = $('paymentNotice');
          if (notice) notice.style.display = 'block';
          btn.disabled = false;
          btn.textContent = 'Refresh Verification Status 🔄';
        }
      } catch (err) {
        alert('Payment recording notice: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Retry';
      }
    });
  }

  if (stage === 'ready') {
    const btn = $('btnBeginContest');
    btn?.addEventListener('click', async () => {
      // Enforce ONE attempt rule
      if (currentAttempt && currentAttempt.status === 'SUBMITTED') {
        alert('You have already completed your official attempt for this contest. Only one attempt is permitted.');
        openContestModal('submitted');
        return;
      }

      const confirmed = confirm('Are you ready to start? Your official timer will start now and cannot be paused or reset.');
      if (!confirmed) return;

      btn.disabled = true;
      btn.textContent = 'Starting…';

      try {
        // Enforce ONE attempt: check or create attempt
        if (!currentAttempt) {
          const { data: newAttempt, error: attErr } = await activeClient
            .from('contest_attempts')
            .insert({
              contest_id: currentContest.id,
              user_id: activeUser.id,
              started_at: new Date().toISOString(),
              draft_response: '',
              status: 'IN_PROGRESS'
            })
            .select('*')
            .single();

          if (attErr) throw attErr;
          currentAttempt = newAttempt;
        }

        openContestModal('active');
      } catch (err) {
        alert('Could not start attempt: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'START CONTEST NOW 🚀';
      }
    });
  }

  if (stage === 'active') {
    const textarea = $('contestThinkingInput');
    const submitBtn = $('btnSubmitContest');

    // Auto-save debounced on input
    let debounceTimer = null;
    textarea?.addEventListener('input', () => {
      const ind = $('draftSaveIndicator');
      if (ind) ind.textContent = 'Saving draft…';
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => saveDraftResponse(false), 1200);
    });

    submitBtn?.addEventListener('click', async () => {
      const responseText = textarea?.value.trim() || '';
      if (!responseText) {
        alert('Please write your step-by-step thinking approach before submitting.');
        return;
      }

      const confirmed = confirm('This is your final submission. You cannot edit your answer after submission. Continue?');
      if (!confirmed) return;

      await submitFinalContestResponse(responseText);
    });
  }
}

// Runtime: Persistent Timer & Draft Recovery
function startActiveContestRuntime() {
  stopTimers();

  if (!currentAttempt || !currentAttempt.started_at) return;

  const startTime = new Date(currentAttempt.started_at).getTime();

  function updateTimer() {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const digitsEl = $('timerDigits');
    if (digitsEl) {
      digitsEl.textContent = formatSeconds(elapsedSeconds);
    }
  }

  updateTimer();
  timerInterval = setInterval(updateTimer, 1000);

  // Auto-save draft every 15 seconds
  autoSaveInterval = setInterval(() => {
    saveDraftResponse(true);
  }, 15000);
}

function stopTimers() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (autoSaveInterval) {
    clearInterval(autoSaveInterval);
    autoSaveInterval = null;
  }
}

async function saveDraftResponse(isPeriodic = false) {
  if (!activeClient || !activeUser || !currentContest || !currentAttempt) return;
  if (currentAttempt.status !== 'IN_PROGRESS' || isSubmitting) return;

  const textarea = $('contestThinkingInput');
  const text = textarea ? textarea.value : '';

  try {
    // Local backup
    try {
      localStorage.setItem(`contestDraft:${currentContest.id}:${activeUser.id}`, text);
    } catch {}

    await activeClient
      .from('contest_attempts')
      .update({
        draft_response: text,
        updated_at: new Date().toISOString()
      })
      .eq('id', currentAttempt.id);

    const ind = $('draftSaveIndicator');
    if (ind) ind.textContent = 'Draft saved ✓';
  } catch (err) {
    const ind = $('draftSaveIndicator');
    if (ind) ind.textContent = 'Offline (cached locally)';
  }
}

async function submitFinalContestResponse(finalText) {
  if (!activeClient || !activeUser || !currentContest || !currentAttempt) return;
  if (isSubmitting) return;

  isSubmitting = true;
  stopTimers();

  const submitBtn = $('btnSubmitContest');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
  }

  const startTime = new Date(currentAttempt.started_at).getTime();
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));

  try {
    const { data: updated, error } = await activeClient
      .from('contest_attempts')
      .update({
        final_response: finalText,
        submitted_at: new Date().toISOString(),
        elapsed_seconds: elapsedSeconds,
        status: 'SUBMITTED',
        updated_at: new Date().toISOString()
      })
      .eq('id', currentAttempt.id)
      .select('*')
      .single();

    if (error) throw error;

    currentAttempt = updated;
    isSubmitting = false;

    // Refresh and transition to submitted screen
    renderContestCard();
    openContestModal('submitted');
  } catch (err) {
    isSubmitting = false;
    alert('Submission error: ' + err.message);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'SUBMIT FINAL ANSWER 🏁';
    }
  }
}

function formatSeconds(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Global modal close hook
if (typeof window !== 'undefined') {
  window.closeContestModal = closeContestModal;
  window.openContestModal = openContestModal;
}
