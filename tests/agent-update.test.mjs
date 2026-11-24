// Failing tests for aibtcdev/agent-hub#8 — POST /agents partial-update bugs.
// Drives the REAL worker (src/index.ts) via app.request() with a minimal
// D1 shim backed by an in-memory node:sqlite database loaded from schema.sql.
// No server, no network, no extra deps beyond hono (already a dependency).
//
// Run:  bun install   (once, for hono)
///       npm test        (node --test; needs Node >= 22.18 for .ts type stripping)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import app from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, '..', 'schema.sql'), 'utf8');

// ---- Minimal D1 shim over node:sqlite (only what src/index.ts uses) ----
function makeD1(db) {
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...args) {
          params = args;
          return stmt;
        },
        run() {
          const info = db.prepare(sql).run(...params);
          return {
            success: true,
            meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid), duration: 0 },
          };
        },
        all() {
          const rows = db.prepare(sql).all(...params);
          return { success: true, results: rows, meta: { changes: 0, last_row_id: 0, duration: 0 } };
        },
        first() {
          return db.prepare(sql).get(...params) ?? null;
        },
      };
      return stmt;
    },
    batch(statements) {
      return statements.map((s) => s.run());
    },
  };
}

function freshEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  return { DB: makeD1(db) };
}

async function postAgents(env, body) {
  const res = await app.request(
    'http://localhost/agents',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
  if (res.status !== 201) {
    assert.fail(`POST /agents failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function getAgent(env, name) {
  const res = await app.request(`http://localhost/agents/${name}`, {}, env);
  if (res.status !== 200) {
    assert.fail(`GET /agents/${name} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function postTask(env, body) {
  const res = await app.request(
    'http://localhost/tasks',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    env,
  );
  if (res.status !== 201) {
    assert.fail(`POST /tasks failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ============ Bug 1 (issue #8): partial update clobbers status/counts ============
test('claim 1: partial POST /agents clobbers status/skill_count/sensor_count', async () => {
  const env = freshEnv();

  await postAgents(env, {
    agent_name: 'alice',
    status: 'degraded',
    skill_count: 5,
    sensor_count: 2,
    capabilities: [{ skill_name: 'weather' }],
  });
  let { agent } = await getAgent(env, 'alice');
  assert.equal(agent.status, 'degraded');
  assert.equal(agent.skill_count, 5);
  assert.equal(agent.sensor_count, 2);

  // Partial update: only a display name — no status / skill_count / sensor_count.
  await postAgents(env, { agent_name: 'alice', display_name: 'Alice v2' });
  ({ agent } = await getAgent(env, 'alice'));
  // Expected: degraded / 5 / 2. Buggy: online / 0 / 0.
  assert.equal(agent.status, 'degraded', 'status should be preserved on partial update');
  assert.equal(agent.skill_count, 5, 'skill_count should be preserved on partial update');
  assert.equal(agent.sensor_count, 2, 'sensor_count should be preserved on partial update');
});

// ============ Bug 2 (issue #8): capabilities: [] leaves stale skills ============
test('claim 2: capabilities: [] leaves stale skills, and they still route tasks', async () => {
  const env = freshEnv();

  await postAgents(env, {
    agent_name: 'bob',
    status: 'online',
    capabilities: [{ skill_name: 'weather' }, { skill_name: 'news' }],
  });
  let { capabilities } = await getAgent(env, 'bob');
  assert.deepEqual(capabilities.map((c) => c.skill_name), ['news', 'weather']);

  // Explicitly clear capabilities.
  await postAgents(env, { agent_name: 'bob', capabilities: [] });
  ({ capabilities } = await getAgent(env, 'bob'));
  assert.deepEqual(capabilities, [], 'capabilities: [] should remove all skills');

  // A task mentioning the stale skill must NOT route to bob anymore.
  const task = await postTask(env, { from_agent: 'tester', subject: 'get weather forecast' });
  assert.equal(task.to_agent, null, 'stale skill must not route tasks');
  assert.equal(task.skill_match, null);
});

// ============ Controls ============
test('control: non-empty capabilities list DOES replace old skills', async () => {
  const env = freshEnv();
  await postAgents(env, { agent_name: 'carol', status: 'online', capabilities: [{ skill_name: 'weather' }] });
  await postAgents(env, { agent_name: 'carol', capabilities: [{ skill_name: 'news' }] });
  const { capabilities } = await getAgent(env, 'carol');
  assert.deepEqual(capabilities.map((c) => c.skill_name), ['news']);
});

test('control: explicit status/skill_count in an update ARE honored', async () => {
  const env = freshEnv();
  await postAgents(env, { agent_name: 'dave', status: 'online', skill_count: 1, sensor_count: 1 });
  await postAgents(env, { agent_name: 'dave', status: 'degraded', skill_count: 9, sensor_count: 3 });
  const { agent } = await getAgent(env, 'dave');
  assert.equal(agent.status, 'degraded');
  assert.equal(agent.skill_count, 9);
  assert.equal(agent.sensor_count, 3);
});

test('control: omitted capabilities (undefined) leaves skills untouched', async () => {
  const env = freshEnv();
  await postAgents(env, { agent_name: 'erin', status: 'online', capabilities: [{ skill_name: 'weather' }] });
  await postAgents(env, { agent_name: 'erin', display_name: 'Erin v2' }); // no capabilities key at all
  const { capabilities } = await getAgent(env, 'erin');
  assert.deepEqual(capabilities.map((c) => c.skill_name), ['weather']);
});

test('control: fresh insert defaults to online/0/0 when status/counts omitted', async () => {
  const env = freshEnv();
  await postAgents(env, { agent_name: 'frank' });
  const { agent } = await getAgent(env, 'frank');
  assert.equal(agent.status, 'online');
  assert.equal(agent.skill_count, 0);
  assert.equal(agent.sensor_count, 0);
});
