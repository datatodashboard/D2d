/**
 * Crack SQL - Centralized In-Browser SQL Engine Architecture
 * - ResultComparator: Normalizes and verifies SQL results
 * - ScenarioDatabaseLoader: Validates and bootstraps scenario DDL & DML
 * - QueryExecutor: Safe, read-only PostgreSQL execution with timeout
 * - SqlEngineManager: Manages isolated per-exercise database sessions and state
 */

const WRITE_OR_ADMIN = /\b(?:insert|update|delete|merge|upsert|create|alter|drop|truncate|grant|revoke|copy|call|do|vacuum|analyze|refresh|reindex|cluster|comment|security|set|reset|listen|notify|prepare|execute|deallocate|lock)\b/i;

export function codeOnly(sql) {
  let out = '', i = 0, quote = null, dollar = null;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (quote) {
      if (c === quote && sql[i + 1] === quote) { out += '  '; i += 2; continue; }
      if (c === quote) quote = null;
      out += ' '; i++; continue;
    }
    if (dollar) {
      if (sql.startsWith(dollar, i)) { out += ' '.repeat(dollar.length); i += dollar.length; dollar = null; continue; }
      out += ' '; i++; continue;
    }
    if (c === '\'' || c === '"') { quote = c; out += ' '; i++; continue; }
    if (c === '$') {
      const m = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (m) { dollar = m[0]; out += ' '.repeat(dollar.length); i += dollar.length; continue; }
    }
    if (c === '-' && n === '-') { while (i < sql.length && sql[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') {
      out += '  '; i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i] === '\n' ? '\n' : ' '; i++; }
      if (i < sql.length) { out += '  '; i += 2; } continue;
    }
    out += c; i++;
  }
  return out;
}

export function validateReadOnlySql(sql) {
  const text = String(sql || '').trim();
  if (!text) return { ok: false, message: 'Write a SQL query first.' };
  if (text.length > 20000) return { ok: false, message: 'The SQL query is too long (limit: 20,000 characters).' };
  const visible = codeOnly(text).trim();
  if (!/^(?:select|with)\b/i.test(visible)) return { ok: false, message: 'Only one SELECT query (optionally using WITH) can be evaluated.' };
  const withoutTrailing = visible.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) return { ok: false, message: 'Run one query at a time.' };
  if (WRITE_OR_ADMIN.test(withoutTrailing)) return { ok: false, message: 'Only read-only SELECT queries are allowed.' };
  return { ok: true, sql: text };
}

// ==========================================
// 1. Result Comparator
// ==========================================
export class ResultComparator {
  static normalizeValue(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Number(value.toPrecision(14)).toString() : String(value);
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value, Object.keys(value).sort());
      } catch {
        return String(value);
      }
    }
    return String(value);
  }

  static normalizeResult(result) {
    if (!result) return { columns: [], columnCount: 0, rows: [], rawRows: [] };
    const columns = (result.fields || []).map(field => field.name);
    const rawRows = Array.isArray(result.rows) ? result.rows : [];
    const rows = rawRows.map(row => {
      if (Array.isArray(row)) {
        return row.map(v => ResultComparator.normalizeValue(v));
      }
      if (columns.length > 0) {
        return columns.map(name => ResultComparator.normalizeValue(row[name]));
      }
      return Object.values(row).map(ResultComparator.normalizeValue);
    });
    return {
      columns,
      columnCount: columns.length,
      rows,
      rawRows
    };
  }

  static compare(actualResult, expectedResult, options = {}) {
    const ordered = options?.ordered === true;
    const actual = ResultComparator.normalizeResult(actualResult);
    const expected = ResultComparator.normalizeResult(expectedResult);

    if (actual.columnCount !== expected.columnCount) {
      return {
        passed: false,
        reason: `Expected ${expected.columnCount} columns but received ${actual.columnCount}.`,
        actual,
        expected
      };
    }

    if (actual.rows.length !== expected.rows.length) {
      return {
        passed: false,
        reason: `Expected ${expected.rows.length} rows but received ${actual.rows.length}.`,
        actual,
        expected
      };
    }

    const rowKey = row => JSON.stringify(row);
    const a = actual.rows.map(rowKey);
    const e = expected.rows.map(rowKey);

    if (!ordered) {
      a.sort();
      e.sort();
    }

    const passed = a.every((value, index) => value === e[index]);
    let reason = 'Your result matches the expected output.';
    if (!passed) {
      reason = ordered
        ? 'The values or required row order do not match yet.'
        : 'The returned values do not match yet.';
    }

    return {
      passed,
      reason,
      actual,
      expected
    };
  }
}

// Backward-compatible helper exports
export const normalizeResult = ResultComparator.normalizeResult;
export function compareResults(actualResult, expectedResult, ordered = false) {
  return ResultComparator.compare(actualResult, expectedResult, { ordered });
}

// ==========================================
// 2. Scenario Database Loader
// ==========================================
export class ScenarioDatabaseLoader {
  static validateAsset(scenario, asset) {
    if (!asset || typeof asset !== 'object') {
      throw new Error(`Scenario asset definitions are missing for domain "${scenario?.domain || 'unknown'}".`);
    }
    const schema = String(asset.schema || '').trim();
    const sample = String(asset.sample || '').trim();
    if (!schema) {
      throw new Error(`Scenario database schema is empty or missing for domain "${scenario?.domain || 'unknown'}".`);
    }
    if (!sample) {
      throw new Error(`Scenario sample data is empty or missing for domain "${scenario?.domain || 'unknown'}".`);
    }
    return { schema, sample };
  }

  static async load(db, scenario, asset) {
    const { schema, sample } = ScenarioDatabaseLoader.validateAsset(scenario, asset);
    const sql = `${schema}\n\n${sample}`;
    try {
      await db.exec(sql);
    } catch (err) {
      const msg = String(err?.message || err).split('\n')[0].replace(/^error:\s*/i, '');
      throw new Error(`Database initialization failed: ${msg}`);
    }
  }
}

// ==========================================
// 3. Query Executor
// ==========================================
export class QueryExecutor {
  static validateReadOnly(sql) {
    return validateReadOnlySql(sql);
  }

  static async execute(db, sql, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 4000;
    const validation = QueryExecutor.validateReadOnly(sql);
    if (!validation.ok) {
      return {
        ok: false,
        kind: 'guard',
        message: validation.message
      };
    }

    if (!db || typeof db.query !== 'function') {
      return {
        ok: false,
        kind: 'engine',
        message: 'PostgreSQL database session is not active or initialized.'
      };
    }

    let timerId = null;
    const timeoutPromise = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        reject(new Error(`Query execution timed out (limit: ${Math.round(timeoutMs / 1000)}s). Accidental expensive queries or infinite loops are halted.`));
      }, timeoutMs + 1000);
    });

    try {
      const execPromise = (async () => {
        await db.exec(`BEGIN TRANSACTION READ ONLY; SET LOCAL statement_timeout = '${timeoutMs}ms';`);
        try {
          const res = await db.query(validation.sql);
          return res;
        } finally {
          try {
            await db.exec('ROLLBACK');
          } catch {
            /* transaction may already have been rolled back on error */
          }
        }
      })();

      const raw = await Promise.race([execPromise, timeoutPromise]);
      return {
        ok: true,
        kind: 'result',
        raw
      };
    } catch (err) {
      const msg = String(err?.message || err).split('\n')[0].replace(/^error:\s*/i, '').slice(0, 400);
      const isTimeout = /timed out|statement_timeout/i.test(msg);
      return {
        ok: false,
        kind: isTimeout ? 'timeout' : 'sql',
        message: msg
      };
    } finally {
      if (timerId) clearTimeout(timerId);
    }
  }
}

// ==========================================
// 4. SQL Engine Manager
// ==========================================
export class SqlEngineManager {
  /**
   * @param {Object} options
   * @param {Function} [options.loadPGlite] Function returning Promise<PGliteConstructor>
   * @param {number} [options.timeoutMs=4000] Statement timeout in ms
   */
  constructor(options = {}) {
    this.loadPGlite = options.loadPGlite || loadBrowserPGlite;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 4000;

    /** @type {'idle'|'initializing'|'ready'|'running'|'completed'|'error'|'resetting'} */
    this.state = 'idle';
    this.stateDetails = null;
    this.listeners = new Set();

    this.currentScenarioId = null;
    this.currentSessionId = 0; // increments per session to prevent race conditions
    this.currentDb = null;
    this.expectedCache = new Map(); // scenarioId -> rawResult
  }

  onStateChange(fn) {
    if (typeof fn === 'function') {
      this.listeners.add(fn);
      // Immediately emit current state
      try { fn(this.state, this.stateDetails); } catch {}
      return () => this.listeners.delete(fn);
    }
    return () => {};
  }

  getState() {
    return { state: this.state, details: this.stateDetails };
  }

  setState(newState, details = null) {
    this.state = newState;
    this.stateDetails = details;
    for (const listener of this.listeners) {
      try { listener(newState, details); } catch (e) { console.error('Error in state listener:', e); }
    }
  }

  isBusy() {
    return this.state === 'initializing' || this.state === 'running' || this.state === 'resetting';
  }

  async closeCurrentSession() {
    if (this.currentDb) {
      const db = this.currentDb;
      this.currentDb = null;
      try {
        if (typeof db.close === 'function') await db.close();
      } catch (e) {
        console.warn('Error closing previous PGlite session:', e);
      }
    }
    this.currentScenarioId = null;
  }

  /**
   * Initializes an isolated session for a scenario.
   * If the session is already active and ready for this scenario, does not recreate.
   */
  async initScenario(scenario, asset) {
    if (!scenario || !scenario.id) {
      throw new Error('Invalid scenario passed to initScenario');
    }

    // If already initialized for this scenario and in a healthy state, keep it
    if (this.currentScenarioId === scenario.id && this.currentDb && (this.state === 'ready' || this.state === 'completed')) {
      return true;
    }

    const sessionId = ++this.currentSessionId;
    this.setState('initializing', { scenarioId: scenario.id, sessionId });

    try {
      // Validate asset first before spinning up WASM
      ScenarioDatabaseLoader.validateAsset(scenario, asset);

      // Cleanly tear down any prior session
      await this.closeCurrentSession();

      // Check race condition
      if (this.currentSessionId !== sessionId) return false;

      // Load PGlite constructor
      const PGliteClass = await this.loadPGlite();
      if (this.currentSessionId !== sessionId) return false;

      // Instantiate fresh database
      const db = new PGliteClass();

      // Check race condition
      if (this.currentSessionId !== sessionId) {
        try { if (typeof db.close === 'function') await db.close(); } catch {}
        return false;
      }

      // Populate scenario schema & sample data
      await ScenarioDatabaseLoader.load(db, scenario, asset);

      // Final race condition check
      if (this.currentSessionId !== sessionId) {
        try { if (typeof db.close === 'function') await db.close(); } catch {}
        return false;
      }

      this.currentDb = db;
      this.currentScenarioId = scenario.id;
      this.setState('ready', { scenarioId: scenario.id, sessionId });
      return true;
    } catch (error) {
      if (this.currentSessionId === sessionId) {
        await this.closeCurrentSession();
        const msg = String(error?.message || error).split('\n')[0].replace(/^error:\s*/i, '');
        this.setState('error', { scenarioId: scenario.id, error: msg });
      }
      throw error;
    }
  }

  /**
   * Resets the current scenario database session to its pristine initial state
   * without requiring a browser refresh.
   */
  async resetScenario(scenario, asset) {
    if (!scenario || !scenario.id) {
      throw new Error('Invalid scenario passed to resetScenario');
    }

    const sessionId = ++this.currentSessionId;
    this.setState('resetting', { scenarioId: scenario.id, sessionId });

    try {
      ScenarioDatabaseLoader.validateAsset(scenario, asset);
      await this.closeCurrentSession();

      if (this.currentSessionId !== sessionId) return false;

      const PGliteClass = await this.loadPGlite();
      if (this.currentSessionId !== sessionId) return false;

      const db = new PGliteClass();
      if (this.currentSessionId !== sessionId) {
        try { if (typeof db.close === 'function') await db.close(); } catch {}
        return false;
      }

      await ScenarioDatabaseLoader.load(db, scenario, asset);

      if (this.currentSessionId !== sessionId) {
        try { if (typeof db.close === 'function') await db.close(); } catch {}
        return false;
      }

      this.currentDb = db;
      this.currentScenarioId = scenario.id;
      this.expectedCache.delete(scenario.id); // clear expected cache on reset
      this.setState('ready', { scenarioId: scenario.id, sessionId });
      return true;
    } catch (error) {
      if (this.currentSessionId === sessionId) {
        await this.closeCurrentSession();
        const msg = String(error?.message || error).split('\n')[0].replace(/^error:\s*/i, '');
        this.setState('error', { scenarioId: scenario.id, error: msg });
      }
      throw error;
    }
  }

  /**
   * Executes learner SQL and compares against reference result.
   */
  async evaluate(scenario, asset, learnerSql) {
    if (this.isBusy()) {
      return {
        passed: false,
        kind: 'busy',
        message: `Database engine is currently busy (${this.state}). Please wait for it to complete.`,
        columns: [],
        rows: [],
        actualRows: 0,
        expectedRows: 0,
        preview: []
      };
    }

    const sessionId = this.currentSessionId;

    // 1. Guard check on SQL input syntax/read-only rules first
    const validation = QueryExecutor.validateReadOnly(learnerSql);
    if (!validation.ok) {
      return {
        passed: false,
        kind: 'guard',
        message: validation.message,
        columns: [],
        rows: [],
        actualRows: 0,
        expectedRows: 0,
        preview: []
      };
    }

    // 2. Ensure engine session is prepared for this scenario
    if (this.currentScenarioId !== scenario.id || !this.currentDb) {
      try {
        await this.initScenario(scenario, asset);
      } catch (err) {
        return {
          passed: false,
          kind: 'engine',
          message: `Failed to initialize scenario session: ${err.message}`,
          columns: [],
          rows: [],
          actualRows: 0,
          expectedRows: 0,
          preview: []
        };
      }
    }

    this.setState('running', { scenarioId: scenario.id, sessionId: this.currentSessionId });

    try {
      // 3. Execute learner query
      const learnerExec = await QueryExecutor.execute(this.currentDb, validation.sql, {
        timeoutMs: this.timeoutMs
      });

      // Check if user navigated away during query execution
      if (this.currentScenarioId !== scenario.id || this.currentSessionId !== sessionId) {
        return {
          passed: false,
          kind: 'aborted',
          message: 'Scenario changed during execution.',
          columns: [],
          rows: [],
          actualRows: 0,
          expectedRows: 0,
          preview: []
        };
      }

      if (!learnerExec.ok) {
        this.setState('completed', { scenarioId: scenario.id, passed: false });
        return {
          passed: false,
          kind: learnerExec.kind,
          message: learnerExec.message,
          columns: [],
          rows: [],
          actualRows: 0,
          expectedRows: 0,
          preview: []
        };
      }

      // 4. Retrieve or compute expected/reference result
      let expectedRaw = this.expectedCache.get(scenario.id);
      if (!expectedRaw) {
        const expectedExec = await QueryExecutor.execute(this.currentDb, scenario.sql, {
          timeoutMs: this.timeoutMs
        });
        if (!expectedExec.ok) {
          throw new Error(`Reference query execution failed: ${expectedExec.message}`);
        }
        expectedRaw = expectedExec.raw;
        this.expectedCache.set(scenario.id, expectedRaw);
      }

      // 5. Compare results locally
      const ordered = scenario.evaluation?.ordered === true;
      const comparison = ResultComparator.compare(learnerExec.raw, expectedRaw, { ordered });

      this.setState('completed', { scenarioId: scenario.id, passed: comparison.passed });

      return {
        passed: comparison.passed,
        kind: 'result',
        message: comparison.reason,
        columns: comparison.actual.columns,
        rows: comparison.actual.rows,
        actualRows: comparison.actual.rows.length,
        expectedRows: comparison.expected.rows.length,
        preview: comparison.actual.rows.slice(0, 10)
      };
    } catch (err) {
      const msg = String(err?.message || err).split('\n')[0].replace(/^error:\s*/i, '').slice(0, 400);
      this.setState('error', { scenarioId: scenario.id, error: msg });
      return {
        passed: false,
        kind: 'sql',
        message: msg,
        columns: [],
        rows: [],
        actualRows: 0,
        expectedRows: 0,
        preview: []
      };
    }
  }

  async close() {
    await this.closeCurrentSession();
    this.expectedCache.clear();
    this.setState('idle');
  }
}

// ==========================================
// Backward-compatible SqlEvaluator wrapper
// ==========================================
export class SqlEvaluator {
  constructor(PGliteClass) {
    this.manager = new SqlEngineManager({
      loadPGlite: async () => PGliteClass
    });
  }
  async close() {
    return this.manager.close();
  }
  async prepare(domain, asset) {
    // For compatibility with any legacy test that calls evaluator.prepare
    return this.manager.initScenario({ id: domain, domain }, asset);
  }
  async query(sql) {
    if (!this.manager.currentDb) {
      throw new Error('Database session not initialized');
    }
    const res = await QueryExecutor.execute(this.manager.currentDb, sql, { timeoutMs: 4000 });
    if (!res.ok) throw new Error(res.message);
    return res.raw;
  }
  async evaluate(scenario, asset, learnerSql) {
    return this.manager.evaluate(scenario, asset, learnerSql);
  }
}

// ==========================================
// 5. Dynamic Engine Loader with Fallbacks
// ==========================================
let browserClassPromise = null;
export async function loadBrowserPGlite() {
  if (browserClassPromise) return browserClassPromise;
  browserClassPromise = (async () => {
    // 1. Try local vendor bundle first
    try {
      const module = await import('../vendor/pglite/index.js');
      if (module?.PGlite) return module.PGlite;
    } catch (localErr) {
      console.warn('Local PGlite vendor bundle not found or failed to load, falling back to CDN...', localErr);
    }

    // 2. Fallback to jsDelivr CDN (e.g. GitHub Pages without vendor binaries committed)
    try {
      const module = await import('https://cdn.jsdelivr.net/npm/@electric-sql/pglite@0.5.8/dist/index.js');
      if (module?.PGlite) return module.PGlite;
    } catch (cdnErr) {
      console.warn('jsDelivr CDN load failed, trying unpkg CDN...', cdnErr);
    }

    // 3. Secondary fallback to unpkg CDN
    try {
      const module = await import('https://unpkg.com/@electric-sql/pglite@0.5.8/dist/index.js');
      if (module?.PGlite) return module.PGlite;
    } catch (unpkgErr) {
      console.error('All PGlite loading sources failed.', unpkgErr);
      throw new Error('Could not load PostgreSQL engine from local files or CDN.');
    }

    throw new Error('PGlite module loaded but did not export PGlite constructor.');
  })();
  return browserClassPromise;
}

export default SqlEngineManager;
