import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import {
  SqlEngineManager,
  ScenarioDatabaseLoader,
  QueryExecutor,
  ResultComparator,
  validateReadOnlySql
} from '../js/sql-evaluator.js';

const data = JSON.parse(fs.readFileSync('./data/scenarios.json', 'utf8'));

describe('SQL Engine Architecture & Execution Workflow', () => {
  const createTestManager = () => new SqlEngineManager({
    loadPGlite: async () => PGlite,
    timeoutMs: 3000
  });

  const bankingScenario = data.scenarios.find(s => s.domain === 'Banking' && s.level === 'Beginner');
  const bankingAsset = data.assets.Banking;

  const healthcareScenario = data.scenarios.find(s => s.domain === 'Healthcare' && s.level === 'Beginner');
  const healthcareAsset = data.assets.Healthcare;

  // 1. Engine initialization
  it('1. engine initialization transitions states correctly and creates session', async () => {
    const manager = createTestManager();
    const states = [];
    manager.onStateChange((state) => states.push(state));

    assert.strictEqual(manager.state, 'idle');
    const ok = await manager.initScenario(bankingScenario, bankingAsset);
    assert.strictEqual(ok, true);
    assert.strictEqual(manager.state, 'ready');
    assert(states.includes('initializing'), 'States should include initializing');
    assert(states.includes('ready'), 'States should include ready');
    assert(manager.currentDb, 'currentDb should be instantiated');

    await manager.close();
  });

  // 2. Schema and sample data loading
  it('2. schema/data loading populates tables and sample records', async () => {
    const manager = createTestManager();
    await manager.initScenario(bankingScenario, bankingAsset);

    const checkRes = await manager.currentDb.query(
      `SELECT count(*)::int AS cnt FROM ${bankingScenario.tables[0]}`
    );
    assert(checkRes.rows[0].cnt > 0, 'Table should contain sample rows loaded from scenario asset');

    await manager.close();
  });

  // 3. Successful query & comparison
  it('3. successful query evaluates and returns verified result table', async () => {
    const manager = createTestManager();
    await manager.initScenario(bankingScenario, bankingAsset);

    const result = await manager.evaluate(bankingScenario, bankingAsset, bankingScenario.sql);
    assert.strictEqual(result.passed, true, 'Learner query matching scenario.sql should pass');
    assert.strictEqual(result.kind, 'result');
    assert(result.columns.length > 0, 'Result should include column headers');
    assert(result.rows.length > 0, 'Result should include rows');
    assert.strictEqual(result.actualRows, result.expectedRows, 'Row counts should match');

    await manager.close();
  });

  // 4. Invalid query
  it('4. handles invalid SQL syntax, relation errors, and write attempts with clear errors', async () => {
    const manager = createTestManager();
    await manager.initScenario(bankingScenario, bankingAsset);

    // Syntax error
    const syntaxRes = await manager.evaluate(bankingScenario, bankingAsset, 'SELECT * FORM accounts');
    assert.strictEqual(syntaxRes.passed, false);
    assert(/syntax error/i.test(syntaxRes.message));

    // Non-existent table
    const tableRes = await manager.evaluate(bankingScenario, bankingAsset, 'SELECT * FROM nonexistent_secret_tbl');
    assert.strictEqual(tableRes.passed, false);
    assert(/does not exist/i.test(tableRes.message));

    // Write attempt guard
    const writeRes = await manager.evaluate(bankingScenario, bankingAsset, 'DROP TABLE accounts;');
    assert.strictEqual(writeRes.passed, false);
    assert.strictEqual(writeRes.kind, 'guard');
    assert(/SELECT|read-only/i.test(writeRes.message), `Expected guard message, got: ${writeRes.message}`);

    await manager.close();
  });

  // 5. Reset without browser refresh
  it('5. reset recreates clean scenario database without browser refresh', async () => {
    const manager = createTestManager();
    await manager.initScenario(bankingScenario, bankingAsset);

    const dbBefore = manager.currentDb;
    const states = [];
    manager.onStateChange(st => states.push(st));

    // Execute reset
    await manager.resetScenario(bankingScenario, bankingAsset);

    assert.notStrictEqual(manager.currentDb, dbBefore, 'Reset should destroy old database and create a new one');
    assert(states.includes('resetting'), 'State should pass through resetting');
    assert.strictEqual(manager.state, 'ready');

    // Verify clean database is ready to execute queries
    const res = await manager.evaluate(bankingScenario, bankingAsset, bankingScenario.sql);
    assert.strictEqual(res.passed, true);

    await manager.close();
  });

  // 6. Exercise switching with session isolation
  it('6. exercise switching destroys previous session and ensures isolated database', async () => {
    const manager = createTestManager();

    // 1. Load Banking scenario
    await manager.initScenario(bankingScenario, bankingAsset);
    assert.strictEqual(manager.currentScenarioId, bankingScenario.id);
    const bankingDb = manager.currentDb;

    // Banking table exists
    const bCheck = await bankingDb.query(`SELECT 1 FROM ${bankingScenario.tables[0]} LIMIT 1`);
    assert.strictEqual(bCheck.rows.length, 1);

    // 2. Switch to Healthcare scenario
    await manager.initScenario(healthcareScenario, healthcareAsset);
    assert.strictEqual(manager.currentScenarioId, healthcareScenario.id);
    assert.notStrictEqual(manager.currentDb, bankingDb, 'Database instance should be fresh');

    // Healthcare table exists
    const hCheck = await manager.currentDb.query(`SELECT 1 FROM ${healthcareScenario.tables[0]} LIMIT 1`);
    assert.strictEqual(hCheck.rows.length, 1);

    // Banking table MUST NOT exist in Healthcare session
    let leaked = false;
    try {
      await manager.currentDb.query(`SELECT 1 FROM ${bankingScenario.tables[0]} LIMIT 1`);
      leaked = true;
    } catch {
      leaked = false;
    }
    assert.strictEqual(leaked, false, 'Banking tables must not leak into Healthcare session');

    await manager.close();
  });

  // 7. Repeated execution
  it('7. repeated execution on the same scenario runs deterministically', async () => {
    const manager = createTestManager();
    await manager.initScenario(bankingScenario, bankingAsset);

    for (let i = 0; i < 5; i++) {
      const res = await manager.evaluate(bankingScenario, bankingAsset, bankingScenario.sql);
      assert.strictEqual(res.passed, true, `Execution iteration ${i} should pass`);
      assert.strictEqual(res.actualRows, res.expectedRows);
    }

    await manager.close();
  });

  // 8. Concurrent execution protection
  it('8. concurrent execution protection rejects overlapping queries safely', async () => {
    const manager = createTestManager();
    await manager.initScenario(bankingScenario, bankingAsset);

    // Start a query and immediately attempt a concurrent evaluate
    const p1 = manager.evaluate(bankingScenario, bankingAsset, bankingScenario.sql);
    const p2 = manager.evaluate(bankingScenario, bankingAsset, bankingScenario.sql);

    const [r1, r2] = await Promise.all([p1, p2]);
    const busyResult = [r1, r2].find(r => r.kind === 'busy');
    const successResult = [r1, r2].find(r => r.passed === true);

    assert(busyResult, 'One of the concurrent queries should have been blocked by the busy concurrency guard');
    assert(successResult, 'One of the queries should succeed');

    await manager.close();
  });

  // 9. Result comparison
  it('9. result comparison accurately handles row mismatch, ordering, and column differences', () => {
    // Exact match
    const r1 = { fields: [{ name: 'a' }, { name: 'b' }], rows: [{ a: 1, b: 'x' }, { a: 2, b: 'y' }] };
    const r2 = { fields: [{ name: 'a' }, { name: 'b' }], rows: [{ a: 2, b: 'y' }, { a: 1, b: 'x' }] };

    // Unordered comparison passes
    const unorderedComp = ResultComparator.compare(r1, r2, { ordered: false });
    assert.strictEqual(unorderedComp.passed, true);

    // Ordered comparison fails because rows are inverted
    const orderedComp = ResultComparator.compare(r1, r2, { ordered: true });
    assert.strictEqual(orderedComp.passed, false);

    // Column count mismatch
    const r3 = { fields: [{ name: 'a' }], rows: [{ a: 1 }] };
    const colMismatch = ResultComparator.compare(r1, r3);
    assert.strictEqual(colMismatch.passed, false);
    assert(/columns/i.test(colMismatch.reason));

    // Row count mismatch
    const r4 = { fields: [{ name: 'a' }, { name: 'b' }], rows: [{ a: 1, b: 'x' }] };
    const rowMismatch = ResultComparator.compare(r1, r4);
    assert.strictEqual(rowMismatch.passed, false);
    assert(/rows/i.test(rowMismatch.reason));
  });

  // 10. Engine initialization failure
  it('10. handles empty or missing schema/sample initialization failures gracefully', async () => {
    const manager = createTestManager();

    // Empty schema asset
    await assert.rejects(
      async () => {
        await manager.initScenario({ id: 'dummy', domain: 'Dummy' }, { schema: '', sample: 'SELECT 1;' });
      },
      /schema is empty or missing/i
    );
    assert.strictEqual(manager.state, 'error');

    // Missing asset entirely
    await assert.rejects(
      async () => {
        await manager.initScenario({ id: 'dummy', domain: 'Dummy' }, null);
      },
      /asset definitions are missing/i
    );
    assert.strictEqual(manager.state, 'error');

    await manager.close();
  });
});
