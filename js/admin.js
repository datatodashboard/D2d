// Think and Crack SQL — Admin Dashboard Controller
// Reads existing Supabase learner data from public.profiles and public.learning_progress
import { stage, isCompleted, isAttempted } from './progress.js';
import { escapeHtml } from './util.js';
import { evaluateContestSubmission } from './contest-ai-evaluator.js';

const SUPABASE_URL = 'https://qklnaqfspvmnlequqagf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_dthVX8zmvd1HvWaYWBaojA_2YbvHWe1';

let client = null;
let currentUser = null;
let isAdminUser = false;

let totalScenariosCount = 420;
const scenariosMap = new Map();

let learnersData = [];
let sortField = 'solved';
let sortAsc = false;
let currentThreshold = 0;

const $ = id => document.getElementById(id);

window.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  await loadScenarioBank();
  await initSupabase();
});

// Load scenario bank using deployment-safe relative URL
async function loadScenarioBank() {
  try {
    const url = new URL('../data/scenarios.json', import.meta.url).href;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.scenarios)) {
        totalScenariosCount = data.scenarios.length;
        scenariosMap.clear();
        data.scenarios.forEach(s => scenariosMap.set(s.id, s));
        const note = $('scenarioBankNote');
        if (note) note.textContent = `(of ${totalScenariosCount})`;
      }
    }
  } catch (err) {
    console.warn('Relative scenarios.json fetch failed, using fallback scenario map:', err);
  }
}

// Safely wait for Supabase CDN script
async function waitForSupabase(timeoutMs = 4000) {
  const start = Date.now();
  while (!window.supabase && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 100));
  }
  return window.supabase || null;
}

async function initSupabase() {
  setGateMessage('Checking authentication…');

  try {
    const supabaseLib = await waitForSupabase();
    if (!supabaseLib) {
      showGateError('Could not load Supabase client library. Check network or reload page.');
      return;
    }

    client = supabaseLib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    client.auth.onAuthStateChange(async (event, session) => {
      currentUser = session?.user || null;
      await evaluateAdminStatus();
    });

    const { data, error } = await client.auth.getSession();
    if (error) {
      console.warn('Session retrieval error:', error);
      showLoginRequired();
      return;
    }

    currentUser = data?.session?.user || null;
    await evaluateAdminStatus();
  } catch (err) {
    console.error('Supabase initialization failure:', err);
    showGateError('Authentication failed: ' + err.message);
  }
}

async function evaluateAdminStatus() {
  renderAuthBox();

  if (!currentUser) {
    showLoginRequired();
    return;
  }

  setGateMessage(`Verifying permissions for ${currentUser.email || 'user'}…`);

  try {
    let isAuthorized = false;

    // 1. Authoritative check via RPC is_admin()
    try {
      const { data: rpcAdmin, error: rpcErr } = await client.rpc('is_admin');
      if (!rpcErr && typeof rpcAdmin === 'boolean') {
        isAuthorized = rpcAdmin;
      } else if (rpcErr) {
        console.warn('RPC is_admin notice:', rpcErr);
      }
    } catch (e) {
      console.warn('RPC is_admin check exception:', e);
    }

    // 2. Direct protected admin_users table check (protected role source)
    if (!isAuthorized) {
      try {
        const { data: adminRow, error: adminErr } = await client
          .from('admin_users')
          .select('role')
          .eq('user_id', currentUser.id)
          .maybeSingle();

        if (!adminErr && adminRow) {
          isAuthorized = true;
        } else if (adminErr) {
          console.warn('admin_users query notice:', adminErr);
        }
      } catch (e) {
        console.warn('admin_users check exception:', e);
      }
    }

    // 3. Fallback to protected profiles.is_admin
    if (!isAuthorized) {
      try {
        const { data: profileRow, error: profErr } = await client
          .from('profiles')
          .select('is_admin')
          .eq('id', currentUser.id)
          .maybeSingle();

        if (!profErr && profileRow?.is_admin === true) {
          isAuthorized = true;
        } else if (profErr) {
          console.warn('profiles is_admin query notice:', profErr);
        }
      } catch (e) {
        console.warn('profiles is_admin check exception:', e);
      }
    }

    if (isAuthorized) {
      isAdminUser = true;
      showDashboard();
      await loadDashboardData();
    } else {
      isAdminUser = false;
      showAccessDenied();
    }
  } catch (err) {
    console.error('Authorization check error:', err);
    showGateRetryableError('Unable to verify administrator permissions due to a network or database error. Please retry.');
  }
}

// UI State Management
function showGateRetryableError(msg) {
  const gate = $('gate');
  const gateMsg = $('gateMsg');
  const dash = $('dashboard');
  if (dash) dash.hidden = true;
  if (gate) gate.hidden = false;

  if (gateMsg) {
    gateMsg.innerHTML = `
      <div style="font-size: 1.2rem; font-weight: 800; color: var(--error); margin-bottom: 8px;">Verification Error</div>
      <p style="margin-bottom: 16px;">
        ${escapeHtml(msg || 'Unable to verify administrative permissions due to a network or database error.')}
      </p>
      <div style="display:flex; justify-content:center; gap:12px;">
        <button class="action primary" id="retryAdminCheckBtn">Retry Verification</button>
        <button class="action secondary" id="retrySignOutBtn">Sign Out</button>
      </div>
    `;

    $('retryAdminCheckBtn')?.addEventListener('click', evaluateAdminStatus);
    $('retrySignOutBtn')?.addEventListener('click', signOut);
  }
}
function setGateMessage(msg) {
  const gate = $('gate');
  const gateMsg = $('gateMsg');
  if (gate) gate.hidden = false;
  if (gateMsg) gateMsg.innerHTML = msg;
}

function showLoginRequired() {
  const gate = $('gate');
  const gateMsg = $('gateMsg');
  const dash = $('dashboard');
  if (dash) dash.hidden = true;
  if (gate) gate.hidden = false;

  if (gateMsg) {
    gateMsg.innerHTML = `
      <div style="font-size: 1.1rem; font-weight: 700; color: var(--ink); margin-bottom: 8px;">Administrator Sign In</div>
      <p style="margin-bottom: 20px;">Please sign in with your authorized admin Google account to view learner metrics.</p>
      <div style="display:flex; justify-content:center; gap:12px; flex-wrap:wrap;">
        <button class="action primary" id="googleLoginBtn">Sign In with Google</button>
      </div>
      <div id="emailLoginForm" style="margin-top:24px; max-width:320px; margin-left:auto; margin-right:auto; text-align:left;">
        <div style="font-size:0.75rem; font-weight:700; text-transform:uppercase; color:var(--muted); margin-bottom:10px; text-align:center;">— or email &amp; password —</div>
        <input type="email" id="adminEmailInput" placeholder="admin@example.com" style="width:100%; border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:8px; font-size:0.85rem;" />
        <input type="password" id="adminPassInput" placeholder="Password" style="width:100%; border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:12px; font-size:0.85rem;" />
        <button class="action secondary" id="emailLoginBtn" style="width:100%;">Sign In</button>
      </div>
    `;

    $('googleLoginBtn')?.addEventListener('click', signInWithGoogle);
    $('emailLoginBtn')?.addEventListener('click', signInWithEmail);
  }
}

function showAccessDenied() {
  const gate = $('gate');
  const gateMsg = $('gateMsg');
  const dash = $('dashboard');
  if (dash) dash.hidden = true;
  if (gate) gate.hidden = false;

  if (gateMsg) {
    gateMsg.innerHTML = `
      <div style="font-size: 1.2rem; font-weight: 800; color: var(--error); margin-bottom: 8px;">Access Denied</div>
      <p style="margin-bottom: 16px;">
        Signed in as <strong>${escapeHtml(currentUser?.email || 'Unknown User')}</strong>, but this account is not registered as an administrator.
      </p>
      <div style="display:flex; justify-content:center; gap:12px;">
        <a href="./" class="action primary" style="text-decoration:none;">Back to Crack SQL</a>
        <button class="action secondary" id="deniedSignOutBtn">Sign Out</button>
      </div>
    `;

    $('deniedSignOutBtn')?.addEventListener('click', signOut);
  }
}

function showDashboard() {
  const gate = $('gate');
  const dash = $('dashboard');
  if (gate) gate.hidden = true;
  if (dash) dash.hidden = false;
}

function showGateError(msg) {
  const gate = $('gate');
  const gateMsg = $('gateMsg');
  if (gate) gate.hidden = false;
  if (gateMsg) {
    gateMsg.innerHTML = `
      <div style="color:var(--error); font-weight:700; margin-bottom:8px;">Error</div>
      <div>${escapeHtml(msg)}</div>
      <div style="margin-top:16px;">
        <button class="action secondary" onclick="location.reload()">Reload Page</button>
      </div>
    `;
  }
}

function renderAuthBox() {
  const box = $('authBox');
  if (!box) return;

  if (currentUser) {
    box.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px;">
        <span style="font-size:0.85rem; color:var(--muted);">${escapeHtml(currentUser.email || 'Admin')}</span>
        <button class="action secondary" id="navSignOutBtn" style="padding:6px 12px; font-size:0.8rem;">Sign Out</button>
      </div>
    `;
    $('navSignOutBtn')?.addEventListener('click', signOut);
  } else {
    box.innerHTML = `
      <button class="action primary" id="navSignInBtn" style="padding:6px 14px; font-size:0.85rem;">Sign In</button>
    `;
    $('navSignInBtn')?.addEventListener('click', signInWithGoogle);
  }
}

// Authentication Actions
async function signInWithGoogle() {
  if (!client) return alert('Supabase client not ready');
  try {
    const redirectUrl = window.location.origin + window.location.pathname;
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: redirectUrl }
    });
    if (error) throw error;
  } catch (err) {
    alert('Google sign-in error: ' + err.message);
  }
}

async function signInWithEmail() {
  if (!client) return alert('Supabase client not ready');
  const email = $('adminEmailInput')?.value.trim();
  const password = $('adminPassInput')?.value;

  if (!email || !password) {
    alert('Please enter both email and password.');
    return;
  }

  try {
    setGateMessage('Authenticating with credentials…');
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentUser = data.user;
    await evaluateAdminStatus();
  } catch (err) {
    alert('Login error: ' + err.message);
    showLoginRequired();
  }
}

async function signOut() {
  if (!client) return;
  try {
    await client.auth.signOut();
    currentUser = null;
    isAdminUser = false;
    renderAuthBox();
    showLoginRequired();
  } catch (err) {
    console.error('Sign out error:', err);
    location.reload();
  }
}

// Main Data Fetch: Reads existing Supabase tables (public.profiles and public.learning_progress)
async function loadDashboardData() {
  updateStatus('Reading existing learner records from public.profiles & public.learning_progress…');

  try {
    // Fetch directly from the two source-of-truth tables used by the application
    const [profilesRes, progressRes] = await Promise.all([
      client.from('profiles').select('*').order('created_at', { ascending: false }).limit(2000),
      client.from('learning_progress').select('user_id, state, updated_at').limit(2000)
    ]);

    if (profilesRes.error) {
      console.warn('Profiles query notice:', profilesRes.error);
    }
    if (progressRes.error) {
      console.warn('Learning progress query notice:', progressRes.error);
    }

    const profiles = profilesRes.data || [];
    const learningRows = progressRes.data || [];

    // Map learning_progress rows by user_id
    const learningProgressMap = new Map();
    learningRows.forEach(row => {
      if (row.user_id) learningProgressMap.set(row.user_id, row);
    });

    // Collect all distinct user IDs from profiles and learning_progress
    const allUserIds = new Set();
    profiles.forEach(p => allUserIds.add(p.id));
    learningRows.forEach(row => allUserIds.add(row.user_id));

    const profilesMap = new Map();
    profiles.forEach(p => profilesMap.set(p.id, p));

    let globalTotalSolved = 0;

    // Process each learner's real progress using the exact stage() rules from progress.js
    learnersData = Array.from(allUserIds).map(userId => {
      const p = profilesMap.get(userId) || { id: userId };
      const progressRow = learningProgressMap.get(userId);

      const stateObj = progressRow?.state;
      const entries = (stateObj && typeof stateObj.entries === 'object' && !Array.isArray(stateObj.entries))
        ? stateObj.entries
        : {};

      let userSolvedCount = 0;
      let userAttemptedCount = 0;
      const domainSolved = {};
      const domainAttempted = {};
      const solvedTimestamps = [];

      for (const [scenarioId, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== 'object') continue;

        const scenario = scenariosMap.get(scenarioId);
        const domain = scenario?.domain || 'General SQL';

        // Evaluate stage using the exact same function used by the Crack SQL practice interface
        const stg = scenario ? stage(scenario, entry) : (entry.evaluationResult?.passed ? 'verified' : 'not_started');

        // Evaluate solved/completed status: Thinking Score >= 7/10
        const isSolved = isCompleted(scenario, entry);
        const isAtt = isAttempted(scenario, entry);

        if (isAtt) {
          userAttemptedCount++;
          domainAttempted[domain] = (domainAttempted[domain] || 0) + 1;
        }

        if (isSolved) {
          userSolvedCount++;
          domainSolved[domain] = (domainSolved[domain] || 0) + 1;
          const ts = entry.evaluationAt || entry.updatedAt;
          if (ts) solvedTimestamps.push(Number(ts));
        }
      }

      globalTotalSolved += userSolvedCount;

      // Sort solved timestamps chronologically for contest threshold calculation
      solvedTimestamps.sort((a, b) => a - b);

      // Top domains formatted by solved count descending, then attempted count
      const allDomains = new Set([...Object.keys(domainSolved), ...Object.keys(domainAttempted)]);
      const sortedDomains = Array.from(allDomains).sort((a, b) => {
        const diffSolved = (domainSolved[b] || 0) - (domainSolved[a] || 0);
        if (diffSolved !== 0) return diffSolved;
        return (domainAttempted[b] || 0) - (domainAttempted[a] || 0);
      });

      const topDomainsText = sortedDomains.slice(0, 3).map(d => {
        const s = domainSolved[d] || 0;
        return s > 0 ? `${d} (${s})` : d;
      }).join(', ') || 'None yet';

      // Username, Name & email formatting
      const username = p.username ? String(p.username).trim() : null;
      const name = p.full_name || p.display_name || p.name || null;
      const email = p.email || null;
      const displayName = username ? `@${username}` : (name || email || 'Anonymous Learner');

      // Last active date from profiles.last_active, progressRow.updated_at, or profiles.created_at
      const lastActivity = p.last_active || (progressRow?.updated_at ? new Date(progressRow.updated_at).getTime() : null) || p.created_at || null;

      return {
        id: userId,
        username,
        name,
        email: email || '—',
        displayName,
        isAdmin: p.is_admin === true,
        paidUnlocked: p.paid_unlocked === true,
        contestEligible: p.contest_eligible === true || userSolvedCount >= 18,
        solved: userSolvedCount,
        attempted: Math.max(userSolvedCount, userAttemptedCount),
        domainSolved,
        domainAttempted,
        topDomains: topDomainsText,
        solvedTimestamps,
        lastActivity
      };
    });

    // Calculate aggregated metrics
    const totalLearners = learnersData.length;
    const avgSolved = totalLearners > 0 ? (globalTotalSolved / totalLearners).toFixed(1) : '0';

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const activeLearners = learnersData.filter(l => l.lastActivity && new Date(l.lastActivity).getTime() > weekAgo).length;

    // Update stat cards
    $('statLearners').textContent = String(totalLearners);
    $('statSolved').textContent = String(globalTotalSolved);
    $('statAvg').textContent = String(avgSolved);
    $('statActive').textContent = String(activeLearners);

    renderLearnersTable();
    updateStatus(`Loaded ${totalLearners} existing learner profiles & progress states • ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error('Error loading dashboard data:', err);
    updateStatus('Error loading learner data: ' + err.message);
  }
}

function renderLearnersTable() {
  const tbody = $('tbody');
  if (!tbody) return;

  const searchQuery = ($('search')?.value || '').trim().toLowerCase();

  // Filter
  const filtered = learnersData.filter(l => {
    if (!searchQuery) return true;
    return (
      (l.username && l.username.toLowerCase().includes(searchQuery)) ||
      l.displayName.toLowerCase().includes(searchQuery) ||
      l.email.toLowerCase().includes(searchQuery) ||
      l.id.toLowerCase().includes(searchQuery)
    );
  });

  // Calculate reached threshold timestamp per learner based on currentThreshold
  filtered.forEach(l => {
    if (currentThreshold > 0 && l.solved >= currentThreshold) {
      l.reachedAt = l.solvedTimestamps[currentThreshold - 1] || l.lastActivity;
    } else if (currentThreshold === 0 && l.solved > 0) {
      l.reachedAt = l.solvedTimestamps[l.solvedTimestamps.length - 1] || null;
    } else {
      l.reachedAt = null;
    }
  });

  // Sort
  filtered.sort((a, b) => {
    let valA = a[sortField];
    let valB = b[sortField];

    if (sortField === 'solved' || sortField === 'progress' || sortField === 'attempted') {
      const numA = (sortField === 'attempted') ? a.attempted : a.solved;
      const numB = (sortField === 'attempted') ? b.attempted : b.solved;
      return sortAsc ? (numA - numB) : (numB - numA);
    }

    if (sortField === 'lastActivity' || sortField === 'reachedAt') {
      const timeA = valA ? new Date(valA).getTime() : 0;
      const timeB = valB ? new Date(valB).getTime() : 0;
      return sortAsc ? (timeA - timeB) : (timeB - timeA);
    }

    valA = String(a.username || a.displayName || a.email || '').toLowerCase();
    valB = String(b.username || b.displayName || b.email || '').toLowerCase();

    if (valA < valB) return sortAsc ? -1 : 1;
    if (valA > valB) return sortAsc ? 1 : -1;
    return 0;
  });

  // Threshold stats label
  let eligibleCount = 0;
  if (currentThreshold > 0) {
    eligibleCount = filtered.filter(l => l.solved >= currentThreshold).length;
    const threshLabel = $('threshLabel');
    if (threshLabel) {
      threshLabel.textContent = `${eligibleCount} of ${filtered.length} learners have solved ≥ ${currentThreshold} scenarios (contest-eligible).`;
    }
  } else {
    const threshLabel = $('threshLabel');
    if (threshLabel) {
      threshLabel.textContent = 'Set a scenario count to mark contest-eligible learners.';
    }
  }

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">No matching learners found.</td></tr>';
    return;
  }

  let html = '';
  filtered.forEach((l, idx) => {
    const isEligible = (currentThreshold > 0 && l.solved >= currentThreshold) || l.contestEligible;
    const pct = Math.min(100, Math.round((l.solved / totalScenariosCount) * 100));

    const usernameHtml = l.username 
      ? `<strong style="font-size:0.92rem;color:var(--ink);font-weight:700;">${escapeHtml(l.username)}</strong>`
      : `<span style="color:var(--muted);font-style:italic;font-size:0.85rem;">Username not set</span>`;

    const emailDisplay = (l.email && l.email !== '—') ? l.email : 'No email';

    const paidBadge = l.paidUnlocked 
      ? '<span class="badge verified">✓ Unlocked (₹49)</span>' 
      : (l.solved >= 5 ? '<span class="badge warn">Paywall (₹49)</span>' : '<span class="badge draft">Free (≤5)</span>');

    const contestBadge = l.contestEligible
      ? '<span class="badge" style="background:#fef3c7;color:#92400e;font-weight:800;">🏆 Eligible (≥18)</span>'
      : `<span class="badge draft">${Math.max(0, 18 - l.solved)} to eligible</span>`;

    html += `
      <tr class="${isEligible ? 'elig' : ''}">
        <td class="num" style="color:var(--muted); font-size:0.8rem;">${idx + 1}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            ${usernameHtml}
            ${l.isAdmin ? '<span class="badge admin">Admin</span>' : ''}
            ${l.contestEligible ? '<span class="badge" style="background:#fef3c7;color:#92400e;">🏆 Eligible</span>' : ''}
          </div>
        </td>
        <td>
          <div class="learner-email" style="font-size:0.85rem;color:var(--ink);">
            ${escapeHtml(emailDisplay)}${l.name && l.name !== l.email && l.name !== l.username ? ` <span style="color:var(--muted);font-size:0.78rem;">(${escapeHtml(l.name)})</span>` : ''}
          </div>
        </td>
        <td class="num">
          <div style="font-weight:700;">${l.solved} <span class="of-total">/ ${totalScenariosCount}</span> (${pct}%)</div>
          <div class="bar"><div class="bar-fill" style="width:${pct}%;"></div></div>
        </td>
        <td class="num">${l.attempted}</td>
        <td>${paidBadge}</td>
        <td>${contestBadge}</td>
        <td class="domains">${escapeHtml(l.topDomains)}</td>
        <td style="font-size:0.82rem; color:var(--muted);">${formatDate(l.reachedAt)}</td>
        <td style="font-size:0.82rem; color:var(--muted);">${formatDate(l.lastActivity)}</td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

function setupEventListeners() {
  // Search input
  $('search')?.addEventListener('input', () => {
    renderLearnersTable();
  });

  // Threshold input
  $('threshold')?.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    currentThreshold = !isNaN(val) && val >= 0 ? val : 0;
    renderLearnersTable();
  });

  // Refresh button
  $('refreshBtn')?.addEventListener('click', async () => {
    const btn = $('refreshBtn');
    if (btn) btn.disabled = true;
    await loadDashboardData();
    if (btn) btn.disabled = false;
  });

  // Export CSV button
  $('exportBtn')?.addEventListener('click', exportCSV);

  // Table header sorting
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      if (sortField === field) {
        sortAsc = !sortAsc;
      } else {
        sortField = field;
        sortAsc = false;
      }
      renderLearnersTable();
    });
  });
}

function exportCSV() {
  if (!learnersData || learnersData.length === 0) {
    alert('No learner data available to export.');
    return;
  }

  let csv = 'Index,User ID,Username,Name,Email,Role,Solved,Attempted,Completion %,Top Domains,Reached Threshold,Last Active\n';
  learnersData.forEach((l, idx) => {
    const pct = Math.min(100, Math.round((l.solved / totalScenariosCount) * 100));
    const role = l.isAdmin ? 'Admin' : 'Learner';
    const cleanUsername = (l.username || 'Username not set').replace(/"/g, '""');
    const cleanName = (l.name || '').replace(/"/g, '""');
    const cleanEmail = (l.email || '').replace(/"/g, '""');
    const cleanDomains = (l.topDomains || '').replace(/"/g, '""');
    const reachedStr = l.reachedAt ? new Date(l.reachedAt).toISOString() : '';
    const activeStr = l.lastActivity ? new Date(l.lastActivity).toISOString() : '';

    csv += `"${idx + 1}","${l.id}","${cleanUsername}","${cleanName}","${cleanEmail}","${role}",${l.solved},${l.attempted},"${pct}%","${cleanDomains}","${reachedStr}","${activeStr}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cracksql_learners_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function updateStatus(msg) {
  const el = $('status');
  if (el) el.textContent = msg || '';
}

function formatDate(dt) {
  if (!dt) return '—';
  try {
    return new Date(dt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  } catch {
    return String(dt);
  }
}

// ============================================================
// CONTEST & PAYMENT MANAGEMENT CONTROLLERS
// ============================================================

let currentAdminTab = 'learners';
let contestsData = [];
let selectedContestId = null;
let currentContestParticipants = [];
let allLearnersForAudience = [];
let selectedAudienceIds = new Set();
let activeReviewSubmission = null;

// Payments state
let paymentsData = [];
let paymentFilterStatus = 'ALL';
let paymentSearchQuery = '';

// Tab switcher
export function switchAdminTab(tab) {
  currentAdminTab = tab;
  const isLearners = tab === 'learners';
  const isPayments = tab === 'payments';
  const isContests = tab === 'contests';

  if ($('learnersTabContent')) $('learnersTabContent').hidden = !isLearners;
  if ($('paymentsTabContent')) $('paymentsTabContent').hidden = !isPayments;
  if ($('contestsTabContent')) $('contestsTabContent').hidden = !isContests;

  if ($('tabLearnersBtn')) $('tabLearnersBtn').classList.toggle('active', isLearners);
  if ($('tabPaymentsBtn')) $('tabPaymentsBtn').classList.toggle('active', isPayments);
  if ($('tabContestsBtn')) $('tabContestsBtn').classList.toggle('active', isContests);

  if (tab === 'contests') {
    void loadContests();
  } else if (tab === 'payments') {
    void loadPayments();
  }
}

// ------------------------------------------------------------
// Payment Verification Controller (Course ₹49 Unlock)
// ------------------------------------------------------------
export async function loadPayments() {
  if (!client) return;
  const tbody = $('paymentsTableBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--muted);">Loading payments from database…</td></tr>';

  try {
    const { data, error } = await client
      .from('payments')
      .select('*')
      .order('submitted_at', { ascending: false });

    if (error) {
      if (error.message && error.message.includes('schema cache')) {
        if (tbody) {
          tbody.innerHTML = `
            <tr>
              <td colspan="9" style="padding:24px;text-align:center;background:#fffbeb;color:#92400e;">
                <strong>Payments table not found in Supabase schema cache.</strong><br>
                Please execute <code>migrations/006_complete_system_schema.sql</code> in your Supabase SQL editor.
              </td>
            </tr>
          `;
        }
        return;
      }
      throw error;
    }

    paymentsData = data || [];
    renderPaymentsStats();
    renderPaymentsTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="color:#b91c1c;text-align:center;padding:20px;">Error loading payments: ${escapeHtml(err.message)}</td></tr>`;
  }
}

export function filterPaymentsTable() {
  paymentSearchQuery = ($('paymentSearch')?.value || '').toLowerCase().trim();
  paymentFilterStatus = $('filterPaymentStatusSelect')?.value || 'ALL';
  renderPaymentsTable();
}

function renderPaymentsStats() {
  const total = paymentsData.length;
  const pending = paymentsData.filter(p => p.status === 'pending').length;
  const verified = paymentsData.filter(p => p.status === 'verified').length;
  const rejected = paymentsData.filter(p => p.status === 'rejected').length;

  if ($('statTotalPayments')) $('statTotalPayments').textContent = String(total);
  if ($('statPendingPayments')) $('statPendingPayments').textContent = String(pending);
  if ($('statVerifiedPayments')) $('statVerifiedPayments').textContent = String(verified);
  if ($('statRejectedPayments')) $('statRejectedPayments').textContent = String(rejected);

  const badge = $('pendingPaymentsCountBadge');
  if (badge) {
    badge.textContent = String(pending);
    badge.style.display = pending > 0 ? 'inline-block' : 'none';
  }
}

function renderPaymentsTable() {
  const tbody = $('paymentsTableBody');
  if (!tbody) return;

  let list = paymentsData;
  if (paymentFilterStatus && paymentFilterStatus !== 'ALL') {
    list = list.filter(p => p.status === paymentFilterStatus);
  }
  if (paymentSearchQuery) {
    list = list.filter(p =>
      (p.user_email || '').toLowerCase().includes(paymentSearchQuery) ||
      (p.user_id || '').toLowerCase().includes(paymentSearchQuery) ||
      (p.transaction_reference || '').toLowerCase().includes(paymentSearchQuery)
    );
  }

  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--muted);">No matching payment records found.</td></tr>';
    return;
  }

  tbody.innerHTML = list.map((p, idx) => {
    const isPending = p.status === 'pending';
    const isVerified = p.status === 'verified';
    const statusBadge = isVerified ? 'badge verified' : (isPending ? 'badge pending' : 'badge danger');

    return `
      <tr>
        <td class="num">${idx + 1}</td>
        <td>
          <div style="font-weight:600;">${escapeHtml(p.user_email ? p.user_email.split('@')[0] : 'Learner')}</div>
          <div style="font-size:0.75rem;color:var(--muted);">${escapeHtml(p.user_id)}</div>
        </td>
        <td>${escapeHtml(p.user_email || '—')}</td>
        <td style="font-weight:700;">₹${p.amount || 49}</td>
        <td>
          <code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:0.85rem;">${escapeHtml(p.transaction_reference || '—')}</code>
        </td>
        <td style="font-size:0.82rem;color:var(--muted);">${formatDate(p.submitted_at || p.created_at)}</td>
        <td><span class="${statusBadge}">${(p.status || 'pending').toUpperCase()}</span></td>
        <td style="font-size:0.8rem;color:var(--muted);">
          ${isVerified ? `Verified: ${formatDate(p.verified_at)}` : (p.status === 'rejected' ? 'Rejected' : 'Awaiting verification')}
        </td>
        <td>
          <div style="display:flex;gap:6px;">
            ${isPending ? `
              <button class="action success sm" onclick="window.verifyLearnerPayment(${p.id}, '${p.user_id}')">✓ Verify</button>
              <button class="action danger sm" onclick="window.rejectLearnerPayment(${p.id})">✕ Reject</button>
            ` : (isVerified ? `
              <span style="color:#16a34a;font-size:0.85rem;font-weight:700;">✓ Active Paid</span>
            ` : `
              <button class="action secondary sm" onclick="window.verifyLearnerPayment(${p.id}, '${p.user_id}')">Re-Verify</button>
            `)}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

export async function verifyLearnerPayment(paymentId, userId) {
  if (!client) return;
  const ok = confirm('Verify this ₹49 payment and unlock Questions 6 onward for this learner?');
  if (!ok) return;

  try {
    const { error: payErr } = await client
      .from('payments')
      .update({
        status: 'verified',
        verified_at: new Date().toISOString(),
        verified_by: currentUser?.id || null
      })
      .eq('id', paymentId);

    if (payErr) throw payErr;

    const { error: profErr } = await client
      .from('profiles')
      .update({
        paid_unlocked: true,
        last_active: new Date().toISOString()
      })
      .eq('id', userId);

    if (profErr) console.warn('Profile paid_unlocked update notice:', profErr);

    alert('Payment verified! Question 6 onward is now unlocked for this learner.');
    await loadPayments();
    await loadDashboardData();
  } catch (err) {
    alert('Verification error: ' + err.message);
  }
}

export async function rejectLearnerPayment(paymentId) {
  if (!client) return;
  const reason = prompt('Optional reason for rejecting this payment (or leave blank):');
  if (reason === null) return;

  try {
    const { error } = await client
      .from('payments')
      .update({
        status: 'rejected',
        admin_notes: reason || null,
        verified_at: new Date().toISOString(),
        verified_by: currentUser?.id || null
      })
      .eq('id', paymentId);

    if (error) throw error;
    alert('Payment marked as rejected.');
    await loadPayments();
  } catch (err) {
    alert('Rejection error: ' + err.message);
  }
}

export function copyContestMigrationSql() {
  const sql = `-- Run this in Supabase SQL Editor:
-- File: migrations/006_complete_system_schema.sql
CREATE TABLE IF NOT EXISTS public.contests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  instructions text,
  rules text,
  scenario_text text NOT NULL,
  scenario_id text,
  entry_fee numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'INR',
  first_prize text NOT NULL DEFAULT '₹1,000',
  second_prize text NOT NULL DEFAULT '₹500',
  third_prize text NOT NULL DEFAULT '₹250',
  audience_type text NOT NULL DEFAULT 'ALL' CHECK (audience_type in ('ALL', 'SELECTED', 'INVITED')),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status in ('DRAFT', 'PUBLISHED', 'PAUSED', 'REGISTRATION_CLOSED', 'CONTEST_CLOSED', 'EVALUATION', 'RESULTS_PUBLISHED', 'ARCHIVED')),
  start_date timestamptz,
  end_date timestamptz,
  results_published_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.contests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins have full access to contests" ON public.contests FOR ALL USING (public.is_admin());
NOTIFY pgrst, 'reload schema';`;

  if (navigator?.clipboard?.writeText) {
    navigator.clipboard.writeText(sql).then(() => {
      alert('Migration SQL copied! Run it in the Supabase SQL editor.');
    }).catch(() => {
      prompt('Copy this SQL to run in Supabase SQL editor:', sql);
    });
  } else {
    prompt('Copy this SQL to run in Supabase SQL editor:', sql);
  }
}

// ------------------------------------------------------------
// Contest Management Controller
// ------------------------------------------------------------

// 1. Load all contests
export async function loadContests() {
  if (!client) return;
  const container = $('contestsContainer');
  if (container) container.innerHTML = '<p style="color:var(--muted);padding:14px;">Loading contests from database…</p>';

  try {
    const { data, error } = await client
      .from('contests')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    contestsData = data || [];
    renderContestsList();
  } catch (err) {
    if (container) {
      if (err.message && err.message.includes('schema cache')) {
        container.innerHTML = `
          <div class="panel" style="border: 2px solid #f59e0b; background: #fffbeb; padding: 22px; border-radius: 12px;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
              <span style="font-size:1.5rem;">⚙️</span>
              <h3 style="margin:0;color:#92400e;">Contest Database Schema Setup Required</h3>
            </div>
            <p style="color:#78350f;margin:0 0 14px;font-size:0.92rem;line-height:1.6;">
              The table <code>public.contests</code> was not found in the Supabase schema cache.<br>
              To enable Contest Management, execute <code>migrations/006_complete_system_schema.sql</code> in your Supabase SQL Editor.
            </p>
            <div style="display:flex;gap:10px;flex-wrap:wrap;">
              <button class="action primary sm" onclick="window.copyContestMigrationSql()">📋 Copy Quick Setup SQL</button>
              <button class="action secondary sm" onclick="window.loadContests()">🔄 Retry Loading</button>
            </div>
          </div>
        `;
      } else {
        container.innerHTML = `<div class="empty" style="color:#b91c1c;">Error loading contests: ${escapeHtml(err.message)}</div>`;
      }
    }
  }
}

function renderContestsList() {
  const container = $('contestsContainer');
  if (!container) return;

  if (!contestsData.length) {
    container.innerHTML = `
      <div class="empty panel">
        <p style="font-size:1.1rem;font-weight:600;margin:0 0 6px;">No contests created yet</p>
        <p style="color:var(--muted);margin:0 0 14px;">Create your first Crack SQL Thinking Contest to challenge learners.</p>
        <button class="action primary" onclick="window.openContestEditor()">+ Create New Contest</button>
      </div>
    `;
    return;
  }

  container.innerHTML = contestsData.map(c => {
    const statusClass = (c.status || 'draft').toLowerCase().replace('_', '-');
    const feeDisplay = Number(c.entry_fee) > 0 ? `₹${c.entry_fee}` : 'FREE';

    return `
      <div class="contest-item-card">
        <div class="contest-item-header">
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <span class="badge ${statusClass}">${c.status}</span>
              <span style="font-size:0.8rem;color:var(--muted);">Audience: <strong>${c.audience_type}</strong></span>
            </div>
            <h3 class="contest-item-title">${escapeHtml(c.title)}</h3>
          </div>
          <div style="font-weight:700;font-size:1rem;color:var(--primary);">
            Entry: ${feeDisplay}
          </div>
        </div>

        <div class="contest-meta-row">
          <span>🥇 ${escapeHtml(c.first_prize || '₹1,000')}</span>
          <span>🥈 ${escapeHtml(c.second_prize || '₹500')}</span>
          <span>🥉 ${escapeHtml(c.third_prize || '₹250')}</span>
          <span>Created: ${formatDate(c.created_at)}</span>
          ${c.results_published_at ? `<span>Results: ${formatDate(c.results_published_at)}</span>` : ''}
        </div>

        <p style="font-size:0.88rem;color:var(--muted);margin:0 0 12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
          ${escapeHtml(c.scenario_text || 'No scenario text set.')}
        </p>

        <div class="contest-actions-row">
          <button class="action primary sm" onclick="window.openContestSubmissions('${c.id}')">👥 Submissions &amp; Review</button>
          <button class="action secondary sm" onclick="window.openContestEditor('${c.id}')">✏️ Edit</button>
          <button class="action secondary sm" onclick="window.duplicateContest('${c.id}')">📋 Duplicate</button>
          <button class="action secondary sm" onclick="window.openAudienceSelector('${c.id}')">🎯 Audience (${c.audience_type})</button>

          <!-- Status transition dropdown / actions -->
          ${c.status === 'DRAFT' ? `
            <button class="action success sm" onclick="window.updateContestStatus('${c.id}', 'PUBLISHED')">🚀 Publish Contest</button>
          ` : ''}

          ${c.status === 'PUBLISHED' ? `
            <button class="action warn sm" onclick="window.updateContestStatus('${c.id}', 'PAUSED')">⏸️ Pause Contest</button>
            <button class="action secondary sm" onclick="window.updateContestStatus('${c.id}', 'REGISTRATION_CLOSED')">🔒 Close Reg</button>
            <button class="action secondary sm" onclick="window.updateContestStatus('${c.id}', 'CONTEST_CLOSED')">⏹️ Close Contest</button>
          ` : ''}

          ${c.status === 'PAUSED' ? `
            <button class="action success sm" onclick="window.updateContestStatus('${c.id}', 'PUBLISHED')">▶️ Resume (Publish)</button>
          ` : ''}

          ${c.status === 'REGISTRATION_CLOSED' ? `
            <button class="action secondary sm" onclick="window.updateContestStatus('${c.id}', 'CONTEST_CLOSED')">⏹️ Close Contest</button>
          ` : ''}

          ${c.status === 'CONTEST_CLOSED' ? `
            <button class="action primary sm" onclick="window.updateContestStatus('${c.id}', 'EVALUATION')">📝 Move to Evaluation</button>
          ` : ''}

          ${c.status === 'EVALUATION' ? `
            <button class="action success sm" onclick="window.updateContestStatus('${c.id}', 'RESULTS_PUBLISHED')">📢 Publish Results</button>
          ` : ''}

          ${c.status !== 'ARCHIVED' ? `
            <button class="action danger sm" style="margin-left:auto;" onclick="window.updateContestStatus('${c.id}', 'ARCHIVED')">Archive</button>
          ` : ''}

          <button class="action danger sm" style="${c.status === 'ARCHIVED' ? 'margin-left:auto;' : ''}" onclick="window.deleteContest('${c.id}')" title="Permanently delete this contest">🗑️ Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

// 2. Create / Edit Contest
export function openContestEditor(contestId = null) {
  const modal = $('contestEditorModal');
  if (!modal) return;

  const titleEl = $('editorModalTitle');
  const idEl = $('editContestId');
  const titleInput = $('contestTitleInput');
  const feeInput = $('contestFeeInput');
  const audienceInput = $('contestAudienceInput');
  const p1 = $('contestPrize1Input');
  const p2 = $('contestPrize2Input');
  const p3 = $('contestPrize3Input');
  const scen = $('contestScenarioInput');
  const inst = $('contestInstructionsInput');
  const rules = $('contestRulesInput');

  if (contestId) {
    const c = contestsData.find(x => x.id === contestId);
    if (!c) return;
    titleEl.textContent = 'Edit Contest: ' + c.title;
    idEl.value = c.id;
    titleInput.value = c.title || '';
    feeInput.value = c.entry_fee ?? 49;
    audienceInput.value = c.audience_type || 'ALL';
    p1.value = c.first_prize || '₹1,000';
    p2.value = c.second_prize || '₹500';
    p3.value = c.third_prize || '₹250';
    scen.value = c.scenario_text || '';
    inst.value = c.instructions || '';
    rules.value = c.rules || '';
    const btnDel = $('btnDeleteContestFromEditor');
    if (btnDel) btnDel.style.display = 'inline-block';
  } else {
    titleEl.textContent = 'Create New Contest (Starts as DRAFT)';
    idEl.value = '';
    titleInput.value = 'Crack SQL Thinking Challenge #' + (contestsData.length + 1);
    feeInput.value = 49;
    audienceInput.value = 'ALL';
    p1.value = '₹1,000';
    p2.value = '₹500';
    p3.value = '₹250';
    scen.value = 'You are the lead data architect for a high-volume financial institution. Fraud detection algorithms have flagged an abnormal cluster of international transactions occurring within minutes of local account ATM withdrawals. Explain step by step how you would identify all compromised accounts, the corresponding transaction details, and calculate the total financial exposure across all impacted customers.';
    inst.value = 'Explain step by step how you would solve this problem. Do not write SQL. Consider the required data, tables, filters, relationships, calculations and expected result.';
    rules.value = '1. Each participant receives exactly ONE official attempt.\n2. Official timer begins immediately upon start and cannot be reset.\n3. Procedural answers are auto-saved in draft mode.\n4. Admin evaluation score out of 100 determines official rankings.';
    const btnDel = $('btnDeleteContestFromEditor');
    if (btnDel) btnDel.style.display = 'none';
  }

  modal.style.display = 'flex';
}

export function closeEditorModal() {
  const modal = $('contestEditorModal');
  if (modal) modal.style.display = 'none';
}

export async function saveContestForm() {
  if (!client) return;

  const id = $('editContestId')?.value;
  const title = $('contestTitleInput')?.value.trim();
  const fee = Number($('contestFeeInput')?.value) || 0;
  const audience = $('contestAudienceInput')?.value || 'ALL';
  const p1 = $('contestPrize1Input')?.value.trim() || '₹1,000';
  const p2 = $('contestPrize2Input')?.value.trim() || '₹500';
  const p3 = $('contestPrize3Input')?.value.trim() || '₹250';
  const scen = $('contestScenarioInput')?.value.trim();
  const inst = $('contestInstructionsInput')?.value.trim();
  const rules = $('contestRulesInput')?.value.trim();

  if (!title || !scen) {
    alert('Please enter both Contest Title and Problem Statement.');
    return;
  }

  const payload = {
    title,
    entry_fee: fee,
    currency: 'INR',
    audience_type: audience,
    first_prize: p1,
    second_prize: p2,
    third_prize: p3,
    scenario_text: scen,
    instructions: inst,
    rules: rules,
    updated_at: new Date().toISOString()
  };

  try {
    if (id) {
      const { error } = await client.from('contests').update(payload).eq('id', id);
      if (error) throw error;
    } else {
      payload.status = 'DRAFT'; // Always starts as DRAFT
      payload.created_by = currentUser?.id || null;
      payload.created_at = new Date().toISOString();
      const { error } = await client.from('contests').insert(payload);
      if (error) throw error;
    }

    closeEditorModal();
    await loadContests();
  } catch (err) {
    if (err.message && err.message.includes('schema cache')) {
      alert('The table "public.contests" was not found in the Supabase schema cache.\n\nPlease execute migrations/006_complete_system_schema.sql in your Supabase SQL Editor.');
    } else {
      alert('Error saving contest: ' + err.message);
    }
  }
}

// 3. Duplicate Contest
export async function duplicateContest(contestId) {
  if (!client) return;
  const original = contestsData.find(c => c.id === contestId);
  if (!original) return;

  const confirmed = confirm(`Duplicate contest "${original.title}" as a new DRAFT? Settings will be copied but participant records, payments, and submissions will NOT be copied.`);
  if (!confirmed) return;

  try {
    const payload = {
      title: `${original.title} (Copy)`,
      description: original.description,
      instructions: original.instructions,
      rules: original.rules,
      scenario_text: original.scenario_text,
      entry_fee: original.entry_fee,
      currency: original.currency || 'INR',
      first_prize: original.first_prize,
      second_prize: original.second_prize,
      third_prize: original.third_prize,
      audience_type: original.audience_type,
      status: 'DRAFT', // Clean new DRAFT
      created_by: currentUser?.id || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const { error } = await client.from('contests').insert(payload);
    if (error) throw error;

    await loadContests();
    alert('Contest duplicated as DRAFT successfully.');
  } catch (err) {
    alert('Duplicate error: ' + err.message);
  }
}

// 4. Update Contest Status (Publish, Pause, etc.)
export async function updateContestStatus(contestId, newStatus) {
  if (!client) return;

  if (newStatus === 'PUBLISHED') {
    const ok = confirm('Publish this contest? Eligible participants will immediately see the contest card.');
    if (!ok) return;
  } else if (newStatus === 'PAUSED') {
    const ok = confirm('Pause this contest? New entries will be blocked, but existing submissions and payments are preserved safely.');
    if (!ok) return;
  } else if (newStatus === 'ARCHIVED') {
    const ok = confirm('Archive this contest?');
    if (!ok) return;
  }

  try {
    const patch = { status: newStatus, updated_at: new Date().toISOString() };
    if (newStatus === 'RESULTS_PUBLISHED') {
      patch.results_published_at = new Date().toISOString();
    }

    const { error } = await client.from('contests').update(patch).eq('id', contestId);
    if (error) throw error;

    await loadContests();
  } catch (err) {
    alert('Status update error: ' + err.message);
  }
}

// 4b. Delete Contest
export async function deleteContest(contestId) {
  if (!client || !contestId) return;

  const contest = contestsData.find(c => c.id === contestId);
  const title = contest ? contest.title : 'this contest';

  const confirmed = confirm(
    `Are you sure you want to permanently delete "${title}"?\n\n` +
    `• Only this selected contest and its related contest data (eligibility, registrations, attempts, evaluations) will be permanently deleted.\n` +
    `• Users, authentication accounts, normal Practice progress, and learning progress will NOT be touched.\n` +
    `• Other contests will not be affected.\n\n` +
    `Click OK to proceed with deletion.`
  );
  if (!confirmed) return;

  try {
    // 1. Delete dependent contest data explicitly to guarantee clean deletion
    await client.from('contest_evaluations').delete().eq('contest_id', contestId);
    await client.from('contest_attempts').delete().eq('contest_id', contestId);
    await client.from('contest_registrations').delete().eq('contest_id', contestId);
    await client.from('contest_eligibility').delete().eq('contest_id', contestId);

    // 2. Delete the contest record itself
    const { error } = await client.from('contests').delete().eq('id', contestId);
    if (error) throw error;

    // 3. If currently viewing details for this contest, switch back to list view
    if (selectedContestId === contestId) {
      backToContestsList();
    }

    // 4. Refresh contest list so the deleted contest disappears
    await loadContests();
  } catch (err) {
    console.error('Error deleting contest:', err);
    alert('Failed to delete contest: ' + (err.message || err));
  }
}

export async function deleteContestFromEditor() {
  const id = $('editContestId')?.value;
  if (!id) return;
  closeEditorModal();
  await deleteContest(id);
}

// 5. Audience Selector Modal
export async function openAudienceSelector(contestId) {
  selectedContestId = contestId;
  const modal = $('audienceModal');
  if (!modal || !client) return;

  modal.style.display = 'flex';
  const container = $('audienceListContainer');
  if (container) container.innerHTML = '<p style="color:var(--muted);padding:10px;">Loading learners…</p>';

  try {
    // 1. Fetch all learners
    const { data: profiles, error: profErr } = await client.from('profiles').select('id, name, email');
    if (profErr) throw profErr;
    allLearnersForAudience = profiles || [];

    // 2. Fetch existing eligibility for this contest
    const { data: elig, error: eligErr } = await client
      .from('contest_eligibility')
      .select('user_id')
      .eq('contest_id', contestId);

    if (eligErr) throw eligErr;
    selectedAudienceIds = new Set((elig || []).map(e => e.user_id));

    renderAudienceList();
  } catch (err) {
    if (container) container.innerHTML = `<p style="color:#b91c1c;">Error: ${escapeHtml(err.message)}</p>`;
  }
}

export function closeAudienceModal() {
  const modal = $('audienceModal');
  if (modal) modal.style.display = 'none';
}

function renderAudienceList(filterQuery = '') {
  const container = $('audienceListContainer');
  if (!container) return;

  const q = (filterQuery || '').toLowerCase().trim();
  const filtered = allLearnersForAudience.filter(l =>
    (l.email || '').toLowerCase().includes(q) || (l.name || '').toLowerCase().includes(q)
  );

  if (!filtered.length) {
    container.innerHTML = '<p style="color:var(--muted);padding:8px;">No matching learners found.</p>';
    return;
  }

  container.innerHTML = filtered.map(l => {
    const isChecked = selectedAudienceIds.has(l.id);
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 8px;border-bottom:1px solid var(--line);">
        <input type="checkbox" id="aud_chk_${l.id}" ${isChecked ? 'checked' : ''} onchange="window.toggleAudienceSelection('${l.id}', this.checked)" />
        <label for="aud_chk_${l.id}" style="cursor:pointer;flex:1;font-size:0.88rem;">
          <strong>${escapeHtml(l.name || 'Learner')}</strong>
          <span style="color:var(--muted);margin-left:6px;font-size:0.8rem;">(${escapeHtml(l.email || l.id)})</span>
        </label>
      </div>
    `;
  }).join('');
}

export function filterAudienceList() {
  const q = $('audienceSearch')?.value || '';
  renderAudienceList(q);
}

export function toggleAudienceSelection(userId, checked) {
  if (checked) selectedAudienceIds.add(userId);
  else selectedAudienceIds.delete(userId);
}

export function selectAllAudience(selectAll = true) {
  allLearnersForAudience.forEach(l => {
    if (selectAll) selectedAudienceIds.add(l.id);
    else selectedAudienceIds.delete(l.id);
  });
  filterAudienceList();
}

export async function saveAudienceSelection() {
  if (!client || !selectedContestId) return;

  try {
    // Delete existing eligibility rows
    await client.from('contest_eligibility').delete().eq('contest_id', selectedContestId);

    // Insert new selected rows
    const rows = Array.from(selectedAudienceIds).map(uid => {
      const learner = allLearnersForAudience.find(l => l.id === uid);
      return {
        contest_id: selectedContestId,
        user_id: uid,
        user_email: learner?.email || null,
        is_invited: true
      };
    });

    if (rows.length > 0) {
      const { error } = await client.from('contest_eligibility').insert(rows);
      if (error) throw error;
    }

    closeAudienceModal();
    alert(`Audience updated: ${rows.length} participants selected.`);
  } catch (err) {
    alert('Error saving audience: ' + err.message);
  }
}

// 6. Submissions & Participants Drill-down
export async function openContestSubmissions(contestId) {
  selectedContestId = contestId;
  const contest = contestsData.find(c => c.id === contestId);
  if (!contest || !client) return;

  if ($('contestsListView')) $('contestsListView').style.display = 'none';
  if ($('contestDetailView')) $('contestDetailView').style.display = 'block';

  const tbody = $('participantsTableBody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--muted);">Loading participants &amp; submissions…</td></tr>';

  try {
    // Fetch eligibility, registrations, payments, attempts, evaluations for this contest
    const [eligRes, regRes, payRes, attRes, evalRes] = await Promise.all([
      client.from('contest_eligibility').select('*').eq('contest_id', contestId),
      client.from('contest_registrations').select('*').eq('contest_id', contestId),
      client.from('contest_payments').select('*').eq('contest_id', contestId),
      client.from('contest_attempts').select('*').eq('contest_id', contestId),
      client.from('contest_evaluations').select('*').eq('contest_id', contestId)
    ]);

    const eligMap = new Map((eligRes.data || []).map(x => [x.user_id, x]));
    const regMap = new Map((regRes.data || []).map(x => [x.user_id, x]));
    const payMap = new Map((payRes.data || []).map(x => [x.user_id, x]));
    const attMap = new Map((attRes.data || []).map(x => [x.user_id, x]));
    const evalMap = new Map((evalRes.data || []).map(x => [x.user_id, x]));

    // Aggregate user IDs across all records
    const allUserIds = new Set([
      ...eligMap.keys(),
      ...regMap.keys(),
      ...payMap.keys(),
      ...attMap.keys(),
      ...evalMap.keys()
    ]);

    // Build unified participant objects
    currentContestParticipants = Array.from(allUserIds).map(uid => {
      const learner = learnersData.find(l => l.id === uid);
      const reg = regMap.get(uid);
      const pay = payMap.get(uid);
      const att = attMap.get(uid);
      const ev = evalMap.get(uid);
      const elig = eligMap.get(uid);

      return {
        userId: uid,
        name: learner?.name || reg?.user_email?.split('@')[0] || 'Learner',
        email: learner?.email || reg?.user_email || '—',
        isEligible: contest.audience_type === 'ALL' || Boolean(elig),
        paymentStatus: pay?.status || (Number(contest.entry_fee) === 0 ? 'VERIFIED' : 'UNPAID'),
        paymentMethod: pay?.payment_method || '—',
        txnRef: pay?.transaction_ref || null,
        attemptStatus: att?.status || 'NOT_STARTED',
        startedAt: att?.started_at || null,
        submittedAt: att?.submitted_at || null,
        elapsedSeconds: att?.elapsed_seconds || 0,
        draftResponse: att?.draft_response || '',
        finalResponse: att?.final_response || '',
        evalStatus: ev?.evaluation_status || 'PENDING',
        adminScore: ev?.admin_final_score ?? null,
        aiScore: ev?.ai_suggested_score ?? null,
        evalObj: ev || null
      };
    });

    renderContestStats();
    renderParticipantsTable();
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="color:#b91c1c;padding:20px;">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

export function backToContestsList() {
  if ($('contestsListView')) $('contestsListView').style.display = 'block';
  if ($('contestDetailView')) $('contestDetailView').style.display = 'none';
  selectedContestId = null;
}

function renderContestStats() {
  const statsEl = $('contestDetailStats');
  if (!statsEl) return;

  const totalEligible = currentContestParticipants.filter(p => p.isEligible).length;
  const totalReg = currentContestParticipants.filter(p => p.attemptStatus !== 'NOT_STARTED' || p.paymentStatus !== 'UNPAID').length;
  const payPending = currentContestParticipants.filter(p => p.paymentStatus === 'PENDING').length;
  const payVerified = currentContestParticipants.filter(p => p.paymentStatus === 'VERIFIED').length;
  const contestStarted = currentContestParticipants.filter(p => p.attemptStatus === 'IN_PROGRESS' || p.attemptStatus === 'SUBMITTED').length;
  const submitted = currentContestParticipants.filter(p => p.attemptStatus === 'SUBMITTED').length;
  const notSubmitted = currentContestParticipants.filter(p => p.attemptStatus === 'IN_PROGRESS').length;
  const evalPending = currentContestParticipants.filter(p => p.attemptStatus === 'SUBMITTED' && p.evalStatus !== 'FINALIZED').length;
  const evalCompleted = currentContestParticipants.filter(p => p.evalStatus === 'FINALIZED').length;

  statsEl.innerHTML = `
    <div class="stat"><div class="num">${totalEligible}</div><div class="label">Total Eligible</div></div>
    <div class="stat"><div class="num">${totalReg}</div><div class="label">Registrations</div></div>
    <div class="stat"><div class="num">${payPending}</div><div class="label">Payment Pending</div></div>
    <div class="stat"><div class="num">${payVerified}</div><div class="label">Payment Verified</div></div>
    <div class="stat"><div class="num">${contestStarted}</div><div class="label">Contest Started</div></div>
    <div class="stat"><div class="num">${submitted}</div><div class="label">Submitted</div></div>
    <div class="stat"><div class="num">${notSubmitted}</div><div class="label">In Progress</div></div>
    <div class="stat"><div class="num">${evalPending}</div><div class="label">Eval Pending</div></div>
    <div class="stat"><div class="num">${evalCompleted}</div><div class="label">Eval Completed</div></div>
  `;
}

export function filterParticipantsTable() {
  renderParticipantsTable();
}

function renderParticipantsTable() {
  const tbody = $('participantsTableBody');
  if (!tbody) return;

  const q = ($('participantSearch')?.value || '').toLowerCase().trim();
  const payFilter = $('filterPaymentStatus')?.value || 'ALL';
  const attFilter = $('filterAttemptStatus')?.value || 'ALL';
  const evalFilter = $('filterEvaluationStatus')?.value || 'ALL';

  const filtered = currentContestParticipants.filter(p => {
    if (q && !p.email.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) return false;
    if (payFilter !== 'ALL' && p.paymentStatus !== payFilter) return false;
    if (attFilter !== 'ALL' && p.attemptStatus !== attFilter) return false;
    if (evalFilter !== 'ALL' && p.evalStatus !== evalFilter) return false;
    return true;
  });

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:24px;color:var(--muted);">No matching participants found.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map(p => {
    const payBadge = p.paymentStatus === 'VERIFIED' ? 'badge verified' : (p.paymentStatus === 'PENDING' ? 'badge pending' : 'badge draft');
    const attBadge = p.attemptStatus === 'SUBMITTED' ? 'badge submitted' : (p.attemptStatus === 'IN_PROGRESS' ? 'badge progress' : 'badge draft');
    const timeFormatted = p.elapsedSeconds > 0 ? formatSec(p.elapsedSeconds) : '—';
    const scoreDisplay = p.adminScore !== null ? `<strong>${p.adminScore}</strong> / 100` : '—';

    return `
      <tr>
        <td>
          <div style="font-weight:600;">${escapeHtml(p.name)}</div>
          <div style="font-size:0.78rem;color:var(--muted);">${escapeHtml(p.email)}</div>
        </td>
        <td>${p.isEligible ? '<span class="badge verified">Eligible</span>' : '<span class="badge draft">Not Eligible</span>'}</td>
        <td>
          <span class="${payBadge}">${p.paymentStatus}</span>
          ${p.txnRef ? `<div style="font-size:0.75rem;color:var(--muted);margin-top:2px;">Ref: ${escapeHtml(p.txnRef)}</div>` : ''}
        </td>
        <td><span class="${attBadge}">${p.attemptStatus}</span></td>
        <td style="font-size:0.8rem;">${p.startedAt ? formatDate(p.startedAt) : '—'}</td>
        <td style="font-size:0.8rem;">${p.submittedAt ? formatDate(p.submittedAt) : '—'}</td>
        <td style="font-size:0.85rem;font-weight:600;">${timeFormatted}</td>
        <td>${scoreDisplay}</td>
        <td><span class="badge ${p.evalStatus === 'FINALIZED' ? 'verified' : 'pending'}">${p.evalStatus}</span></td>
        <td>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${p.paymentStatus === 'PENDING' ? `
              <button class="action success sm" onclick="window.verifyPayment('${selectedContestId}', '${p.userId}', 'VERIFIED')">Verify Pay ✓</button>
            ` : ''}
            ${p.attemptStatus === 'SUBMITTED' ? `
              <button class="action primary sm" onclick="window.openEvaluationModal('${selectedContestId}', '${p.userId}')">Evaluate</button>
            ` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// 7. Payment Verification
export async function verifyPayment(contestId, userId, newStatus = 'VERIFIED') {
  if (!client) return;
  const ok = confirm(`Mark payment for participant as ${newStatus}?`);
  if (!ok) return;

  try {
    const { error } = await client
      .from('contest_payments')
      .update({
        status: newStatus,
        verified_at: new Date().toISOString(),
        verified_by: currentUser?.id || null,
        updated_at: new Date().toISOString()
      })
      .eq('contest_id', contestId)
      .eq('user_id', userId);

    if (error) throw error;
    await openContestSubmissions(contestId);
  } catch (err) {
    alert('Payment verification error: ' + err.message);
  }
}

// 8. Evaluation & AI Review Modal
export function openEvaluationModal(contestId, userId) {
  const p = currentContestParticipants.find(x => x.userId === userId);
  const c = contestsData.find(x => x.id === contestId);
  if (!p || !c) return;

  activeReviewSubmission = { contest: c, participant: p };
  const modal = $('evaluationModal');
  if (!modal) return;

  $('evalModalTitle').textContent = `Review: ${p.name}`;
  $('evalParticipantMeta').textContent = `Email: ${p.email} | User ID: ${p.userId}`;
  $('evalScenarioText').textContent = c.scenario_text || '';
  $('evalAnswerText').textContent = p.finalResponse || p.draftResponse || 'No response submitted.';
  $('evalTimeTakenBadge').textContent = `Time Taken: ${formatSec(p.elapsedSeconds)}`;

  // Populate existing scores if already evaluated
  const ev = p.evalObj;
  $('scoreReq').value = ev?.score_req_understanding ?? 0;
  $('scoreData').value = ev?.score_data_identification ?? 0;
  $('scoreSeq').value = ev?.score_logical_sequence ?? 0;
  $('scoreOp').value = ev?.score_operation_reasoning ?? 0;
  $('scoreClar').value = ev?.score_completeness_clarity ?? 0;
  $('adminFeedbackInput').value = ev?.admin_feedback || '';

  calcTotalScore();

  // Reset AI suggestion boxes
  ['aiReqBox', 'aiDataBox', 'aiSeqBox', 'aiOpBox', 'aiClarBox'].forEach(id => {
    const el = $(id);
    if (el) el.style.display = 'none';
  });

  modal.style.display = 'flex';
}

export function closeEvaluationModal() {
  const modal = $('evaluationModal');
  if (modal) modal.style.display = 'none';
  activeReviewSubmission = null;
}

export function calcTotalScore() {
  const s1 = Number($('scoreReq')?.value) || 0;
  const s2 = Number($('scoreData')?.value) || 0;
  const s3 = Number($('scoreSeq')?.value) || 0;
  const s4 = Number($('scoreOp')?.value) || 0;
  const s5 = Number($('scoreClar')?.value) || 0;

  const total = Math.min(100, Math.max(0, s1 + s2 + s3 + s4 + s5));
  const badge = $('totalScoreLive');
  if (badge) badge.textContent = `${total} / 100`;
  return total;
}

export function runAiEvaluation() {
  if (!activeReviewSubmission) return;
  const btn = $('btnRunAiEval');
  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing thinking…'; }

  const scenario = activeReviewSubmission.contest.scenario_text;
  const response = activeReviewSubmission.participant.finalResponse || activeReviewSubmission.participant.draftResponse;

  const result = evaluateContestSubmission({ scenario, response });
  const b = result.breakdown;

  // Fill in suggested scores
  $('scoreReq').value = b.req_understanding.score;
  $('scoreData').value = b.data_identification.score;
  $('scoreSeq').value = b.logical_sequence.score;
  $('scoreOp').value = b.operation_reasoning.score;
  $('scoreClar').value = b.completeness_clarity.score;

  // Show reasoning boxes
  showAiBox('aiReqBox', `🤖 Suggested: ${b.req_understanding.score}/20 — ${b.req_understanding.reason} | Strengths: ${b.req_understanding.strengths}`);
  showAiBox('aiDataBox', `🤖 Suggested: ${b.data_identification.score}/15 — ${b.data_identification.reason} | Strengths: ${b.data_identification.strengths}`);
  showAiBox('aiSeqBox', `🤖 Suggested: ${b.logical_sequence.score}/25 — ${b.logical_sequence.reason} | Strengths: ${b.logical_sequence.strengths}`);
  showAiBox('aiOpBox', `🤖 Suggested: ${b.operation_reasoning.score}/25 — ${b.operation_reasoning.reason} | Strengths: ${b.operation_reasoning.strengths}`);
  showAiBox('aiClarBox', `🤖 Suggested: ${b.completeness_clarity.score}/15 — ${b.completeness_clarity.reason} | Strengths: ${b.completeness_clarity.strengths}`);

  calcTotalScore();

  if (btn) { btn.disabled = false; btn.textContent = 'Re-run AI Evaluation'; }
}

function showAiBox(id, text) {
  const el = $(id);
  if (el) {
    el.style.display = 'block';
    el.textContent = text;
  }
}

export async function saveEvaluation(evaluationStatus = 'DRAFT') {
  if (!client || !activeReviewSubmission) return;

  const contestId = activeReviewSubmission.contest.id;
  const userId = activeReviewSubmission.participant.userId;
  const totalScore = calcTotalScore();

  const payload = {
    contest_id: contestId,
    user_id: userId,
    score_req_understanding: Number($('scoreReq')?.value) || 0,
    score_data_identification: Number($('scoreData')?.value) || 0,
    score_logical_sequence: Number($('scoreSeq')?.value) || 0,
    score_operation_reasoning: Number($('scoreOp')?.value) || 0,
    score_completeness_clarity: Number($('scoreClar')?.value) || 0,
    admin_final_score: totalScore,
    admin_feedback: $('adminFeedbackInput')?.value.trim() || '',
    evaluation_status: evaluationStatus,
    evaluated_by: currentUser?.id || null,
    evaluated_at: new Date().toISOString()
  };

  if (evaluationStatus === 'FINALIZED') {
    payload.finalized_at = new Date().toISOString();
  }

  try {
    const { error } = await client
      .from('contest_evaluations')
      .upsert(payload, { onConflict: 'contest_id,user_id' });

    if (error) throw error;

    closeEvaluationModal();
    await openContestSubmissions(contestId);
    alert(`Evaluation saved as ${evaluationStatus}!`);
  } catch (err) {
    alert('Error saving evaluation: ' + err.message);
  }
}

// 9. Results Leaderboard Modal & Publication
export async function openResultsModal() {
  if (!client || !selectedContestId) return;
  const modal = $('resultsModal');
  if (!modal) return;

  const container = $('resultsLeaderboardContainer');
  if (container) container.innerHTML = '<p style="color:var(--muted);padding:14px;">Calculating rankings…</p>';
  modal.style.display = 'flex';

  try {
    const { data: evals, error } = await client
      .from('contest_evaluations')
      .select('*')
      .eq('contest_id', selectedContestId);

    if (error) throw error;

    // Join with participants
    const scoredList = (evals || []).map(ev => {
      const p = currentContestParticipants.find(x => x.userId === ev.user_id);
      return {
        ...ev,
        name: p?.name || 'Participant',
        email: p?.email || ev.user_id,
        elapsedSeconds: p?.elapsedSeconds || 0
      };
    });

    // Primary sort: admin_final_score DESC, Secondary sort: elapsedSeconds ASC
    scoredList.sort((a, b) => {
      if (b.admin_final_score !== a.admin_final_score) {
        return b.admin_final_score - a.admin_final_score;
      }
      return a.elapsedSeconds - b.elapsedSeconds;
    });

    if (!scoredList.length) {
      if (container) container.innerHTML = '<p style="color:var(--muted);padding:14px;">No evaluated submissions found for this contest yet.</p>';
      return;
    }

    container.innerHTML = `
      <table>
        <thead>
          <tr>
            <th class="num">Rank</th>
            <th>Participant</th>
            <th class="num">Score</th>
            <th class="num">Time Taken</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${scoredList.map((s, idx) => `
            <tr>
              <td class="num" style="font-weight:700;">#${idx + 1}</td>
              <td>
                <div style="font-weight:600;">${escapeHtml(s.name)}</div>
                <div style="font-size:0.75rem;color:var(--muted);">${escapeHtml(s.email)}</div>
              </td>
              <td class="num" style="font-weight:700;color:var(--primary);">${s.admin_final_score} / 100</td>
              <td class="num">${formatSec(s.elapsedSeconds)}</td>
              <td><span class="badge ${s.evaluation_status === 'FINALIZED' ? 'verified' : 'pending'}">${s.evaluation_status}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    if (container) container.innerHTML = `<p style="color:#b91c1c;">Error: ${escapeHtml(err.message)}</p>`;
  }
}

export function closeResultsModal() {
  const modal = $('resultsModal');
  if (modal) modal.style.display = 'none';
}

export async function publishContestResults() {
  if (!client || !selectedContestId) return;
  const ok = confirm('Publish results to participants? All evaluated participants will be able to see their scores, ranks, and feedback.');
  if (!ok) return;

  try {
    const { error } = await client
      .from('contests')
      .update({
        status: 'RESULTS_PUBLISHED',
        results_published_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', selectedContestId);

    if (error) throw error;

    closeResultsModal();
    await loadContests();
    alert('Results officially published to participants!');
  } catch (err) {
    alert('Publishing error: ' + err.message);
  }
}

function formatSec(s) {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

// Expose on window for inline handlers
Object.assign(window, {
  switchAdminTab,
  loadPayments,
  filterPaymentsTable,
  verifyLearnerPayment,
  rejectLearnerPayment,
  copyContestMigrationSql,
  loadContests,
  openContestEditor,
  closeEditorModal,
  saveContestForm,
  duplicateContest,
  updateContestStatus,
  deleteContest,
  deleteContestFromEditor,
  openAudienceSelector,
  closeAudienceModal,
  filterAudienceList,
  toggleAudienceSelection,
  selectAllAudience,
  saveAudienceSelection,
  openContestSubmissions,
  backToContestsList,
  filterParticipantsTable,
  verifyPayment,
  openEvaluationModal,
  closeEvaluationModal,
  calcTotalScore,
  runAiEvaluation,
  saveEvaluation,
  openResultsModal,
  closeResultsModal,
  publishContestResults
});

