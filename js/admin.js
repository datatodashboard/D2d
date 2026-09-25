// Think and Crack SQL — Admin Dashboard Controller
// Reads existing Supabase learner data from public.profiles and public.learning_progress
import { stage } from './progress.js';
import { escapeHtml } from './util.js';

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

    // 1. Check RPC function is_admin()
    try {
      const { data: rpcAdmin, error: rpcErr } = await client.rpc('is_admin');
      if (!rpcErr && rpcAdmin === true) {
        isAuthorized = true;
      }
    } catch (e) {
      console.warn('RPC is_admin check warning:', e);
    }

    // 2. Check admin_users table
    if (!isAuthorized) {
      try {
        const { data: adminRow, error: adminErr } = await client
          .from('admin_users')
          .select('role')
          .eq('user_id', currentUser.id)
          .maybeSingle();

        if (!adminErr && adminRow) {
          isAuthorized = true;
        }
      } catch (e) {
        console.warn('admin_users check warning:', e);
      }
    }

    // 3. Check profiles.is_admin
    if (!isAuthorized) {
      try {
        const { data: profileRow, error: profErr } = await client
          .from('profiles')
          .select('is_admin')
          .eq('id', currentUser.id)
          .maybeSingle();

        if (!profErr && profileRow?.is_admin === true) {
          isAuthorized = true;
        }
      } catch (e) {
        console.warn('profiles is_admin check warning:', e);
      }
    }

    // 4. Check user app metadata or known admin email
    if (!isAuthorized) {
      if (
        currentUser.app_metadata?.is_admin === true ||
        currentUser.user_metadata?.is_admin === true ||
        currentUser.email === 'datatodashboard2@gmail.com'
      ) {
        isAuthorized = true;
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
    showAccessDenied();
  }
}

// UI State Management
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

        const isSolved = (stg === 'verified');
        const isAttempted = isSolved ||
          ['thinking', 'thinking_ready', 'sql_written', 'fiddle_opened', 'answer_viewed'].includes(stg) ||
          (Number.isFinite(entry.attempts) && entry.attempts > 0) ||
          Boolean(entry.sql && String(entry.sql).trim()) ||
          Boolean(entry.thinking && (entry.thinking.response || entry.thinking.steps));

        if (isAttempted) {
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

      // Name & email formatting
      const name = p.full_name || p.display_name || p.name || null;
      const email = p.email || null;
      const displayName = name || email || 'Anonymous Learner';

      // Last active date from profiles.last_active, progressRow.updated_at, or profiles.created_at
      const lastActivity = p.last_active || (progressRow?.updated_at ? new Date(progressRow.updated_at).getTime() : null) || p.created_at || null;

      return {
        id: userId,
        name,
        email: email || '—',
        displayName,
        isAdmin: p.is_admin === true || email === 'datatodashboard2@gmail.com',
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

    valA = String(a.displayName || a.email || '').toLowerCase();
    valB = String(b.displayName || b.email || '').toLowerCase();

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
    tbody.innerHTML = '<tr><td colspan="7" class="empty">No matching learners found.</td></tr>';
    return;
  }

  let html = '';
  filtered.forEach((l, idx) => {
    const isEligible = currentThreshold > 0 && l.solved >= currentThreshold;
    const pct = Math.min(100, Math.round((l.solved / totalScenariosCount) * 100));

    const subText = (l.name && l.email && l.email !== '—') ? l.email : l.id;

    html += `
      <tr class="${isEligible ? 'elig' : ''}">
        <td class="num" style="color:var(--muted); font-size:0.8rem;">${idx + 1}</td>
        <td>
          <div class="learner-name">
            ${escapeHtml(l.displayName)}
            ${l.isAdmin ? '<span class="badge admin">Admin</span>' : ''}
            ${isEligible ? '<span class="badge">Eligible ★</span>' : ''}
          </div>
          <div class="learner-email">${escapeHtml(subText)}</div>
        </td>
        <td class="num">
          <div style="font-weight:700;">${l.solved} <span class="of-total">/ ${totalScenariosCount}</span> (${pct}%)</div>
          <div class="bar"><div class="bar-fill" style="width:${pct}%;"></div></div>
        </td>
        <td class="num">${l.attempted}</td>
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

  let csv = 'Index,User ID,Name,Email,Role,Solved,Attempted,Completion %,Top Domains,Reached Threshold,Last Active\n';
  learnersData.forEach((l, idx) => {
    const pct = Math.min(100, Math.round((l.solved / totalScenariosCount) * 100));
    const role = l.isAdmin ? 'Admin' : 'Learner';
    const cleanName = (l.name || '').replace(/"/g, '""');
    const cleanEmail = (l.email || '').replace(/"/g, '""');
    const cleanDomains = (l.topDomains || '').replace(/"/g, '""');
    const reachedStr = l.reachedAt ? new Date(l.reachedAt).toISOString() : '';
    const activeStr = l.lastActivity ? new Date(l.lastActivity).toISOString() : '';

    csv += `"${idx + 1}","${l.id}","${cleanName}","${cleanEmail}","${role}",${l.solved},${l.attempted},"${pct}%","${cleanDomains}","${reachedStr}","${activeStr}"\n`;
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
