// Crack SQL — Admin Dashboard Controller
import { loadBrowserPGlite } from './sql-evaluator.js?v=4';
import { escapeHtml } from './util.js';

const SUPABASE_URL = 'https://qklnaqfspvmnlequqagf.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_dthVX8zmvd1HvWaYWBaojA_2YbvHWe1';

let client = null;
let currentUser = null;
let isAdminUser = false;
let scenariosData = { scenarios: [], domains: [] };
let cachedProfiles = [];
let cachedAttempts = [];
let cachedProgress = [];
let playgroundEngine = null;

const $ = id => document.getElementById(id);

// Initialize Admin Dashboard on load
window.addEventListener('DOMContentLoaded', async () => {
  setupNavigation();
  setupPlaygroundEvents();
  await loadScenarioBank();
  initSupabase();
});

function initSupabase() {
  try {
    if (window.supabase) {
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      client.auth.onAuthStateChange(async (event, session) => {
        currentUser = session?.user || null;
        await checkAdminAuth();
      });
      // Initial session check
      client.auth.getSession().then(async ({ data: { session } }) => {
        currentUser = session?.user || null;
        await checkAdminAuth();
      }).catch(err => {
        console.warn('Session check failed:', err);
        showAuthRequired();
      });
    } else {
      console.warn('Supabase SDK not loaded');
      showAuthRequired();
    }
  } catch (err) {
    console.error('Supabase init error:', err);
    showAuthRequired();
  }
}

async function checkAdminAuth() {
  if (!currentUser) {
    showAuthRequired();
    return;
  }

  $('adminUserEmail').textContent = currentUser.email || 'Admin';
  $('adminUserAvatar').textContent = (currentUser.email || 'A')[0].toUpperCase();

  // Check admin privileges
  try {
    // 1. Try calling the is_admin RPC
    const { data: rpcIsAdmin, error: rpcErr } = await client.rpc('is_admin');
    
    if (!rpcErr && rpcIsAdmin === true) {
      isAdminUser = true;
      showAdminDashboard();
      await loadDashboardData();
      return;
    }

    // 2. Check admin_users table directly
    const { data: adminRow, error: adminErr } = await client
      .from('admin_users')
      .select('role')
      .eq('user_id', currentUser.id)
      .maybeSingle();

    if (!adminErr && adminRow) {
      isAdminUser = true;
      showAdminDashboard();
      await loadDashboardData();
      return;
    }

    // 3. Check profiles table for is_admin flag
    const { data: profileRow, error: profErr } = await client
      .from('profiles')
      .select('is_admin')
      .eq('id', currentUser.id)
      .maybeSingle();

    if (!profErr && profileRow?.is_admin === true) {
      isAdminUser = true;
      showAdminDashboard();
      await loadDashboardData();
      return;
    }

    // 4. Check app_metadata
    if (currentUser.app_metadata?.is_admin === true || currentUser.user_metadata?.is_admin === true) {
      isAdminUser = true;
      showAdminDashboard();
      await loadDashboardData();
      return;
    }

    // If none matched, user is logged in but is NOT an authorized admin
    showAccessDenied();
  } catch (err) {
    console.error('Error verifying admin authorization:', err);
    showAccessDenied();
  }
}

function showAuthRequired() {
  $('authScreen').classList.remove('hidden');
  $('deniedScreen').classList.add('hidden');
  $('dashboardScreen').classList.add('hidden');
  $('adminHeaderNav').classList.add('hidden');
}

function showAccessDenied() {
  $('authScreen').classList.add('hidden');
  $('deniedScreen').classList.remove('hidden');
  $('dashboardScreen').classList.add('hidden');
  $('adminHeaderNav').classList.remove('hidden');
  $('deniedUserEmail').textContent = currentUser?.email || 'Unknown';
}

function showAdminDashboard() {
  $('authScreen').classList.add('hidden');
  $('deniedScreen').classList.add('hidden');
  $('dashboardScreen').classList.remove('hidden');
  $('adminHeaderNav').classList.remove('hidden');
}

// Navigation & Tab Switching
function setupNavigation() {
  const navTabs = document.querySelectorAll('.admin-nav-tab');
  navTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      navTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const targetTabId = tab.dataset.tab;
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('hidden', content.id !== targetTabId);
      });
    });
  });

  // Attach search & filter listeners
  $('userSearchInput')?.addEventListener('input', filterUsersTable);
  $('submissionFilterDomain')?.addEventListener('change', filterSubmissionsTable);
  $('submissionFilterStatus')?.addEventListener('change', filterSubmissionsTable);
  $('submissionSearchInput')?.addEventListener('input', filterSubmissionsTable);
  $('scenarioDomainFilter')?.addEventListener('change', filterScenarios);
  $('scenarioLevelFilter')?.addEventListener('change', filterScenarios);
  $('scenarioSearchInput')?.addEventListener('input', filterScenarios);
}

// Auth Actions
window.adminSignInWithGoogle = async function() {
  if (!client) return alert('Supabase client not initialized');
  try {
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href }
    });
    if (error) throw error;
  } catch (err) {
    alert('Sign in error: ' + err.message);
  }
};

window.adminSignInWithEmail = async function(e) {
  e.preventDefault();
  if (!client) return alert('Supabase client not initialized');
  const email = $('emailInput').value.trim();
  const password = $('passwordInput').value;
  const statusMsg = $('authStatusMsg');

  try {
    statusMsg.textContent = 'Authenticating...';
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    currentUser = data.user;
    await checkAdminAuth();
  } catch (err) {
    statusMsg.textContent = 'Login failed: ' + err.message;
  }
};

window.adminSignOut = async function() {
  if (!client) return;
  try {
    await client.auth.signOut();
    currentUser = null;
    isAdminUser = false;
    showAuthRequired();
  } catch (err) {
    alert('Sign out error: ' + err.message);
  }
};

// Data Loading
async function loadScenarioBank() {
  try {
    const res = await fetch('/data/scenarios.json');
    if (res.ok) {
      scenariosData = await res.json();
      populateScenarioFilterDropdowns();
      renderScenarioBank(scenariosData.scenarios);
      $('statTotalScenarios').textContent = scenariosData.scenarios.length || '420';
    }
  } catch (err) {
    console.error('Failed to load scenarios bank:', err);
  }
}

async function loadDashboardData() {
  updateSyncStatus('Fetching administrative data...');

  try {
    // 1. Fetch aggregate stats from RPC if available
    const { data: statsData, error: rpcErr } = await client.rpc('get_admin_dashboard_stats');

    if (!rpcErr && statsData) {
      renderOverviewStats(statsData);
    }

    // 2. Fetch Profiles & Progress
    const [profilesRes, attemptsRes, progressRes] = await Promise.all([
      client.from('profiles').select('*').order('created_at', { ascending: false }).limit(100),
      client.from('sql_challenge_attempts').select('*').order('created_at', { ascending: false }).limit(200),
      client.from('progress').select('user_id, scenario_id, completed_at').limit(500)
    ]);

    cachedProfiles = profilesRes.data || [];
    cachedAttempts = attemptsRes.data || [];
    cachedProgress = progressRes.data || [];

    // If RPC failed or wasn't installed yet, compute fallback stats
    if (rpcErr || !statsData) {
      computeFallbackOverviewStats();
    }

    renderUsersTable(cachedProfiles, cachedProgress);
    renderSubmissionsTable(cachedAttempts);
    renderRecentActivity(cachedAttempts, cachedProgress);

    updateSyncStatus('Live Supabase Data Loaded');
  } catch (err) {
    console.error('Error fetching admin data:', err);
    updateSyncStatus('Data loaded with local fallback: ' + err.message);
    computeFallbackOverviewStats();
  }
}

function updateSyncStatus(msg) {
  const el = $('adminSyncStatus');
  if (el) el.textContent = msg;
}

function renderOverviewStats(stats) {
  if (!stats) return;
  $('statTotalUsers').textContent = stats.total_users || '0';
  $('statActive7d').textContent = stats.active_users_7d || '0';
  $('statTotalCompletions').textContent = stats.total_completions || '0';
  $('statTotalAttempts').textContent = stats.total_attempts || '0';
  $('statAvgThinkingScore').textContent = stats.avg_thinking_score ? stats.avg_thinking_score + '%' : '—';
  
  if (stats.total_attempts > 0) {
    const rate = Math.round(((stats.verified_attempts || 0) / stats.total_attempts) * 100);
    $('statPassRate').textContent = rate + '%';
  } else {
    $('statPassRate').textContent = '—';
  }

  // Render Domain Summary Breakdown
  renderDomainSummary(stats.domain_summary || {});
}

function computeFallbackOverviewStats() {
  const totalUsers = cachedProfiles.length;
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const activeUsers = cachedProfiles.filter(p => p.last_active && new Date(p.last_active) > weekAgo).length;
  const totalCompletions = cachedProgress.length;
  const totalAttempts = cachedAttempts.length;
  const verifiedAttempts = cachedAttempts.filter(a => a.is_verified).length;

  const validScores = cachedAttempts.filter(a => typeof a.thinking_score === 'number' && !isNaN(a.thinking_score));
  const avgScore = validScores.length ? Math.round(validScores.reduce((sum, a) => sum + a.thinking_score, 0) / validScores.length) : null;

  $('statTotalUsers').textContent = totalUsers;
  $('statActive7d').textContent = activeUsers;
  $('statTotalCompletions').textContent = totalCompletions;
  $('statTotalAttempts').textContent = totalAttempts;
  $('statAvgThinkingScore').textContent = avgScore !== null ? avgScore + '%' : '—';
  $('statPassRate').textContent = totalAttempts ? Math.round((verifiedAttempts / totalAttempts) * 100) + '%' : '—';

  // Domain breakdown
  const domainCounts = {};
  cachedAttempts.forEach(a => {
    if (a.domain) domainCounts[a.domain] = (domainCounts[a.domain] || 0) + 1;
  });
  renderDomainSummary(domainCounts);
}

function renderDomainSummary(domainCounts) {
  const container = $('domainSummaryGrid');
  if (!container) return;

  const domains = ['Banking', 'Healthcare', 'Insurance', 'Retail', 'E-Commerce', 'Logistics', 'SaaS'];
  let html = '';

  domains.forEach(dom => {
    const attempts = domainCounts[dom] || 0;
    html += `
      <div class="domain-card">
        <div class="domain-card-header">
          <span class="domain-name">${dom}</span>
          <span class="domain-badge">${dom.slice(0, 3).toUpperCase()}</span>
        </div>
        <div class="domain-card-body">
          <div class="metric-val">${attempts}</div>
          <div class="metric-sub">Logged Attempts</div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function renderRecentActivity(attempts, progress) {
  const container = $('recentActivityList');
  if (!container) return;

  const events = [];

  attempts.slice(0, 10).forEach(a => {
    events.push({
      type: 'attempt',
      time: new Date(a.created_at || Date.now()),
      title: `Attempt on ${a.scenario_id || 'Scenario'} (${a.domain || 'Domain'})`,
      detail: `Score: ${a.thinking_score ?? 'N/A'}% • Status: ${a.is_verified ? 'Verified ✓' : 'Failed ✗'}`,
      isSuccess: a.is_verified
    });
  });

  progress.slice(0, 10).forEach(p => {
    events.push({
      type: 'completion',
      time: new Date(p.completed_at || Date.now()),
      title: `Scenario Completed: ${p.scenario_id}`,
      detail: `User ID: ${p.user_id ? p.user_id.slice(0, 8) + '...' : 'Unknown'}`,
      isSuccess: true
    });
  });

  events.sort((a, b) => b.time - a.time);

  if (!events.length) {
    container.innerHTML = '<div class="empty-state">No recent activity logged yet. Attempt scenarios in the main app to see live stream.</div>';
    return;
  }

  let html = '';
  events.slice(0, 8).forEach(e => {
    html += `
      <div class="activity-row">
        <div class="activity-icon ${e.isSuccess ? 'success' : 'failed'}">
          ${e.isSuccess ? '✓' : '✗'}
        </div>
        <div class="activity-details">
          <div class="activity-title">${escapeHtml(e.title)}</div>
          <div class="activity-subtitle">${escapeHtml(e.detail)}</div>
        </div>
        <div class="activity-time">${formatTimeAgo(e.time)}</div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Users Table
function renderUsersTable(profiles, progress) {
  const tbody = $('usersTableBody');
  if (!tbody) return;

  if (!profiles.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center py-6 text-muted">No user profiles found in database.</td></tr>';
    return;
  }

  // Count completions per user
  const completionsByUser = {};
  progress.forEach(p => {
    completionsByUser[p.user_id] = (completionsByUser[p.user_id] || 0) + 1;
  });

  let html = '';
  profiles.forEach(p => {
    const completedCount = completionsByUser[p.id] || 0;
    const isUserAdmin = p.is_admin === true;
    html += `
      <tr>
        <td class="font-medium">${escapeHtml(p.email || 'Anonymous Learner')}</td>
        <td class="text-muted font-mono text-xs">${escapeHtml(p.id)}</td>
        <td>
          <span class="badge ${isUserAdmin ? 'badge-primary' : 'badge-neutral'}">
            ${isUserAdmin ? 'Admin' : 'Learner'}
          </span>
        </td>
        <td>${completedCount} / 420</td>
        <td class="text-muted text-xs">${formatDate(p.last_active || p.created_at)}</td>
        <td>
          <button class="btn btn-sm btn-ghost" onclick="inspectUser('${p.id}', '${escapeHtml(p.email || '')}')">Inspect</button>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

function filterUsersTable() {
  const query = $('userSearchInput').value.toLowerCase();
  const rows = document.querySelectorAll('#usersTableBody tr');
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(query) ? '' : 'none';
  });
}

// SQL Submissions Table
function renderSubmissionsTable(attempts) {
  const tbody = $('submissionsTableBody');
  if (!tbody) return;

  if (!attempts.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-6 text-muted">No challenge attempts recorded yet.</td></tr>';
    return;
  }

  let html = '';
  attempts.forEach(a => {
    const isPassed = a.is_verified === true;
    const score = a.thinking_score !== null && a.thinking_score !== undefined ? `${a.thinking_score}%` : '—';
    html += `
      <tr data-domain="${escapeHtml(a.domain || '')}" data-status="${isPassed ? 'passed' : 'failed'}">
        <td class="text-xs text-muted font-mono">${formatDate(a.created_at)}</td>
        <td class="font-semibold text-primary">${escapeHtml(a.scenario_id || '—')}</td>
        <td><span class="badge badge-neutral">${escapeHtml(a.domain || '—')}</span></td>
        <td>${escapeHtml(a.level || '—')}</td>
        <td><span class="badge ${a.thinking_score >= 80 ? 'badge-good' : 'badge-warn'}">${score}</span></td>
        <td>
          <span class="badge ${isPassed ? 'badge-good' : 'badge-error'}">
            ${isPassed ? 'Verified ✓' : 'Failed ✗'}
          </span>
        </td>
        <td>
          <button class="btn btn-sm btn-ghost" onclick="inspectSubmission(${a.id})">Details</button>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

function filterSubmissionsTable() {
  const domain = $('submissionFilterDomain')?.value;
  const status = $('submissionFilterStatus')?.value;
  const query = $('submissionSearchInput')?.value.toLowerCase();

  const rows = document.querySelectorAll('#submissionsTableBody tr');
  rows.forEach(row => {
    const rowDomain = row.dataset.domain;
    const rowStatus = row.dataset.status;
    const text = row.textContent.toLowerCase();

    let matches = true;
    if (domain && domain !== 'all' && rowDomain !== domain) matches = false;
    if (status && status !== 'all' && rowStatus !== status) matches = false;
    if (query && !text.includes(query)) matches = false;

    row.style.display = matches ? '' : 'none';
  });
}

// Scenario Bank Explorer
function populateScenarioFilterDropdowns() {
  const domainSelect = $('scenarioDomainFilter');
  if (!domainSelect || !scenariosData.scenarios) return;

  const domains = [...new Set(scenariosData.scenarios.map(s => s.domain))];
  domainSelect.innerHTML = '<option value="all">All Domains (' + scenariosData.scenarios.length + ')</option>';
  domains.forEach(d => {
    const count = scenariosData.scenarios.filter(s => s.domain === d).length;
    domainSelect.innerHTML += `<option value="${escapeHtml(d)}">${escapeHtml(d)} (${count})</option>`;
  });
}

function renderScenarioBank(scenarios) {
  const container = $('scenarioCardsContainer');
  if (!container) return;

  if (!scenarios?.length) {
    container.innerHTML = '<div class="empty-state">No scenarios found.</div>';
    return;
  }

  let html = '';
  scenarios.slice(0, 60).forEach(sc => {
    html += `
      <div class="scenario-admin-card" data-domain="${escapeHtml(sc.domain)}" data-level="${escapeHtml(sc.level)}" onclick="inspectScenario('${sc.id}')">
        <div class="scenario-card-top">
          <span class="scenario-id">${escapeHtml(sc.id)}</span>
          <span class="badge badge-neutral">${escapeHtml(sc.level)}</span>
        </div>
        <div class="scenario-title">${escapeHtml(sc.title || sc.prompt || 'SQL Exercise')}</div>
        <div class="scenario-domain-tag">${escapeHtml(sc.domain)}</div>
        <div class="scenario-preview-snippet">${escapeHtml((sc.prompt || '').slice(0, 100))}...</div>
      </div>
    `;
  });

  container.innerHTML = html;
  $('scenarioCountLabel').textContent = `Showing ${Math.min(scenarios.length, 60)} of ${scenarios.length} scenarios`;
}

function filterScenarios() {
  const domain = $('scenarioDomainFilter').value;
  const level = $('scenarioLevelFilter').value;
  const query = $('scenarioSearchInput').value.toLowerCase();

  let filtered = scenariosData.scenarios || [];

  if (domain !== 'all') {
    filtered = filtered.filter(s => s.domain === domain);
  }
  if (level !== 'all') {
    filtered = filtered.filter(s => s.level === level);
  }
  if (query) {
    filtered = filtered.filter(s =>
      s.id.toLowerCase().includes(query) ||
      (s.title && s.title.toLowerCase().includes(query)) ||
      (s.prompt && s.prompt.toLowerCase().includes(query))
    );
  }

  renderScenarioBank(filtered);
}

// Modals and Inspectors
window.inspectScenario = function(scenarioId) {
  const sc = scenariosData.scenarios.find(s => s.id === scenarioId);
  if (!sc) return;

  $('modalScenarioId').textContent = sc.id;
  $('modalScenarioTitle').textContent = sc.title || sc.prompt;
  $('modalScenarioDomain').textContent = sc.domain;
  $('modalScenarioLevel').textContent = sc.level;
  $('modalScenarioPrompt').textContent = sc.prompt;
  $('modalScenarioSchema').textContent = sc.schemaText || 'Standard schema tables';
  $('modalScenarioRefSql').textContent = sc.referenceSql || sc.solutionSql || 'SELECT * ...';

  openModal('scenarioModal');
};

window.inspectSubmission = function(submissionId) {
  const sub = cachedAttempts.find(a => a.id === submissionId);
  if (!sub) return;

  $('modalSubId').textContent = sub.id;
  $('modalSubScenario').textContent = sub.scenario_id;
  $('modalSubUser').textContent = sub.user_id || 'Anonymous';
  $('modalSubScore').textContent = sub.thinking_score !== null ? sub.thinking_score + '%' : 'N/A';
  $('modalSubThinking').textContent = sub.thinking_text || '(No thinking rationale provided)';
  $('modalSubSql').textContent = sub.submitted_sql || '(No SQL query submitted)';
  $('modalSubStatus').textContent = sub.is_verified ? 'Verified Solution' : 'Execution Error / Result Mismatch';

  openModal('submissionModal');
};

window.inspectUser = function(userId, email) {
  const userAttempts = cachedAttempts.filter(a => a.user_id === userId);
  const userProgress = cachedProgress.filter(p => p.user_id === userId);

  $('modalUserEmail').textContent = email || 'Learner';
  $('modalUserId').textContent = userId;
  $('modalUserCompletionsCount').textContent = userProgress.length;
  $('modalUserAttemptsCount').textContent = userAttempts.length;

  let listHtml = '';
  userProgress.forEach(p => {
    listHtml += `<li><strong>${escapeHtml(p.scenario_id)}</strong> <span class="text-muted text-xs">(${formatDate(p.completed_at)})</span></li>`;
  });
  $('modalUserCompletionsList').innerHTML = listHtml || '<li class="text-muted">No completed scenarios yet.</li>';

  openModal('userModal');
};

window.openModal = function(id) {
  $(id)?.classList.remove('hidden');
};

window.closeModal = function(id) {
  $(id)?.classList.add('hidden');
};

// Admin SQL Playground (PGlite integration)
function setupPlaygroundEvents() {
  $('playgroundRunBtn')?.addEventListener('click', runPlaygroundQuery);
}

async function runPlaygroundQuery() {
  const sql = $('playgroundSqlInput').value.trim();
  const outputEl = $('playgroundOutput');
  if (!sql) return;

  outputEl.textContent = 'Executing query in PostgreSQL (PGlite)...';

  try {
    if (!playgroundEngine) {
      const PGliteClass = await loadBrowserPGlite();
      playgroundEngine = new PGliteClass();
      await playgroundEngine.waitReady;
    }

    const res = await playgroundEngine.query(sql);
    if (res && res.rows) {
      if (res.rows.length === 0) {
        outputEl.textContent = 'Query executed successfully. (0 rows returned)';
      } else {
        outputEl.textContent = JSON.stringify(res.rows, null, 2);
      }
    } else {
      outputEl.textContent = 'Query executed successfully.';
    }
  } catch (err) {
    outputEl.textContent = 'Execution Error: ' + err.message;
  }
}

// Export Features
window.exportAdminData = function(format) {
  const exportPayload = {
    generated_at: new Date().toISOString(),
    profiles: cachedProfiles,
    attempts: cachedAttempts,
    progress: cachedProgress
  };

  if (format === 'json') {
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    downloadBlob(blob, `cracksql_admin_export_${Date.now()}.json`);
  } else if (format === 'csv') {
    let csv = 'submission_id,user_id,scenario_id,domain,level,thinking_score,is_verified,created_at\n';
    cachedAttempts.forEach(a => {
      csv += `"${a.id}","${a.user_id || ''}","${a.scenario_id || ''}","${a.domain || ''}","${a.level || ''}","${a.thinking_score || ''}","${a.is_verified}","${a.created_at || ''}"\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    downloadBlob(blob, `cracksql_submissions_${Date.now()}.csv`);
  }
};

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Formatting Utilities
function formatDate(dt) {
  if (!dt) return '—';
  try {
    return new Date(dt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return String(dt);
  }
}

function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - new Date(date)) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
