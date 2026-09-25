// Think and Crack SQL — Admin Dashboard Controller
import { escapeHtml } from './util.js';

const SUPABASE_URL = 'https://qklnaqfspvmnlequqagf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_dthVX8zmvd1HvWaYWBaojA_2YbvHWe1';

let client = null;
let currentUser = null;
let isAdminUser = false;
let totalScenariosCount = 420;

let learnersData = [];
let sortField = 'solved';
let sortAsc = false;
let currentThreshold = 0;

const $ = id => document.getElementById(id);

window.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  loadScenarioBankCount().catch(err => console.warn('Scenario count load:', err));
  await initSupabase();
});

// Load scenario count using deployment-safe URL for GitHub Pages
async function loadScenarioBankCount() {
  try {
    const url = new URL('../data/scenarios.json', import.meta.url).href;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.scenarios)) {
        totalScenariosCount = data.scenarios.length;
        const note = $('scenarioBankNote');
        if (note) note.textContent = `(of ${totalScenariosCount})`;
      }
    }
  } catch (err) {
    console.warn('Relative scenario fetch failed, using fallback count:', err);
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

    // 4. Check user app metadata
    if (!isAuthorized) {
      if (currentUser.app_metadata?.is_admin === true || currentUser.user_metadata?.is_admin === true) {
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

// Load and Render Admin Data
async function loadDashboardData() {
  updateStatus('Fetching latest learner records…');

  try {
    // 1. Fetch RPC stats if present
    let rpcStats = null;
    try {
      const { data, error } = await client.rpc('get_admin_dashboard_stats');
      if (!error && data) rpcStats = data;
    } catch (e) {
      console.warn('RPC dashboard stats not available:', e);
    }

    // 2. Fetch Profiles, Progress, and Challenge Attempts
    const [profilesRes, progressRes, attemptsRes] = await Promise.all([
      client.from('profiles').select('*').order('created_at', { ascending: false }).limit(500),
      client.from('progress').select('user_id, scenario_id, completed_at').limit(3000),
      client.from('sql_challenge_attempts').select('user_id, scenario_id, domain, created_at, is_verified').limit(3000)
    ]);

    const profiles = profilesRes.data || [];
    const progress = progressRes.data || [];
    const attempts = attemptsRes.data || [];

    // Group progress by user
    const userProgressMap = {};
    progress.forEach(p => {
      if (!userProgressMap[p.user_id]) userProgressMap[p.user_id] = [];
      userProgressMap[p.user_id].push(p);
    });

    // Group attempts by user
    const userAttemptsMap = {};
    attempts.forEach(a => {
      if (!a.user_id) return;
      if (!userAttemptsMap[a.user_id]) userAttemptsMap[a.user_id] = [];
      userAttemptsMap[a.user_id].push(a);
    });

    // Compute stats
    const totalLearners = profiles.length;
    const totalSolved = progress.length;
    const avgSolved = totalLearners > 0 ? (totalSolved / totalLearners).toFixed(1) : '0';

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const activeLearners = profiles.filter(p => p.last_active && new Date(p.last_active) > weekAgo).length;

    // Update stat cards
    $('statLearners').textContent = rpcStats?.total_users ?? totalLearners;
    $('statSolved').textContent = rpcStats?.total_completions ?? totalSolved;
    $('statAvg').textContent = avgSolved;
    $('statActive').textContent = rpcStats?.active_users_7d ?? activeLearners;

    // Process learner list
    learnersData = profiles.map(p => {
      const uProgress = userProgressMap[p.id] || [];
      const uAttempts = userAttemptsMap[p.id] || [];
      const solvedCount = uProgress.length;
      const attemptedCount = Math.max(solvedCount, uAttempts.length);

      // Find top domains from attempts or scenarios
      const domainCounts = {};
      uAttempts.forEach(a => {
        if (a.domain) domainCounts[a.domain] = (domainCounts[a.domain] || 0) + 1;
      });
      const topDomains = Object.keys(domainCounts)
        .sort((a, b) => domainCounts[b] - domainCounts[a])
        .slice(0, 3)
        .join(', ') || 'General SQL';

      // Find reached threshold timestamp if any
      const sortedCompleted = [...uProgress].sort((a, b) => new Date(a.completed_at) - new Date(b.completed_at));
      const reachedAt = sortedCompleted.length > 0 ? sortedCompleted[sortedCompleted.length - 1].completed_at : null;

      return {
        id: p.id,
        email: p.email || 'Anonymous Learner',
        isAdmin: p.is_admin === true,
        solved: solvedCount,
        attempted: attemptedCount,
        topDomains,
        reachedAt,
        lastActivity: p.last_active || p.created_at || null,
        progressList: uProgress
      };
    });

    renderLearnersTable();
    updateStatus(`Synchronized ${learnersData.length} learner records • ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error('Error loading dashboard data:', err);
    updateStatus('Loaded with offline fallback: ' + err.message);
  }
}

function renderLearnersTable() {
  const tbody = $('tbody');
  if (!tbody) return;

  const searchQuery = ($('search')?.value || '').trim().toLowerCase();

  // Filter
  const filtered = learnersData.filter(l => {
    if (!searchQuery) return true;
    return l.email.toLowerCase().includes(searchQuery) || l.id.toLowerCase().includes(searchQuery);
  });

  // Sort
  filtered.sort((a, b) => {
    let valA = a[sortField];
    let valB = b[sortField];

    if (sortField === 'solved' || sortField === 'attempted') {
      valA = Number(valA || 0);
      valB = Number(valB || 0);
    } else if (sortField === 'lastActivity' || sortField === 'reachedAt') {
      valA = valA ? new Date(valA).getTime() : 0;
      valB = valB ? new Date(valB).getTime() : 0;
    } else {
      valA = String(valA || '').toLowerCase();
      valB = String(valB || '').toLowerCase();
    }

    if (valA < valB) return sortAsc ? -1 : 1;
    if (valA > valB) return sortAsc ? 1 : -1;
    return 0;
  });

  // Threshold calculation
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

    html += `
      <tr class="${isEligible ? 'elig' : ''}">
        <td class="num" style="color:var(--muted); font-size:0.8rem;">${idx + 1}</td>
        <td>
          <div class="learner-name">
            ${escapeHtml(l.email)}
            ${l.isAdmin ? '<span class="badge admin">Admin</span>' : ''}
            ${isEligible ? '<span class="badge">Eligible ★</span>' : ''}
          </div>
          <div class="learner-email">${escapeHtml(l.id)}</div>
        </td>
        <td class="num">
          <div style="font-weight:700;">${l.solved} <span class="of-total">/ ${totalScenariosCount}</span></div>
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
    $('refreshBtn').disabled = true;
    await loadDashboardData();
    $('refreshBtn').disabled = false;
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

  let csv = 'Index,User ID,Email,Role,Solved,Attempted,Completion %,Top Domains,Reached Threshold,Last Active\n';
  learnersData.forEach((l, idx) => {
    const pct = Math.min(100, Math.round((l.solved / totalScenariosCount) * 100));
    csv += `"${idx + 1}","${l.id}","${l.email}","${l.isAdmin ? 'Admin' : 'Learner'}","${l.solved}","${l.attempted}","${pct}%","${l.topDomains}","${l.reachedAt || ''}","${l.lastActivity || ''}"\n`;
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
