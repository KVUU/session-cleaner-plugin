import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { SessionCleaner } from './backend.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const EFFECT = Symbol.for('cordis.effect');
const logPath = (root, cwd, id) => join(root, `--${cwd.replace(/[\\/:]+/g, '-').replace(/^-+/, '').slice(0, 251)}--`, id, 'session.v4.jsonl');
class JsonlSessionPersistence {
  constructor(root) { this.root = root; this.config = { root }; this.rows = new Map(); this.tracker = { writers: new Map(), openHandles: new Set() }; this.coldLogMemo = new Map(); this.busy = new Set(); }
  locate(meta) { /* logPath(this.root, meta.cwd, meta.id, this.compression) */ return { kind: 'jsonl', path: logPath(this.root, meta.cwd, meta.id) }; }
  async stat(id) { const row = this.rows.get(id); if (!row) return; try { const text = await readFile(this.locate(row.header).path); return { header: row.header, revision: sha(text) }; } catch (error) { if (error.code === 'ENOENT') return; throw error; } }
  async list() { return (await Promise.all([...this.rows.keys()].map(id => this.stat(id)))).filter(Boolean); }
  async open(id, access) {
    /* this.tracker.claimWrite(id); this.acquireLease(id, void 0, dirname(resolved.currentPath)) */
    const row = this.rows.get(id);
    if (!row || !await this.stat(id)) throw new Error('session not found');
    if (access === 'write' && (this.busy.has(id) || this.tracker.writers.has(id))) throw new Error('SessionAlreadyOwnedError');
    let closed = false;
    const handle = { id, access, header: row.header, read: async () => ({ events: structuredClone(row.events) }), close: async () => { if (closed) return; closed = true; this.tracker.openHandles.delete(handle); if (access === 'write') this.tracker.writers.delete(id); } };
    this.tracker.openHandles.add(handle);
    if (access === 'write') this.tracker.writers.set(id, handle);
    return handle;
  }
}
class AgentLoop {
  constructor() { this.runtime = { ctx: { fiber: { _disposables: [] } } }; }
  prepare() { /* await handle?.close(); detachAgent?.(); detachSession?.(); agentLoop.scope(${id}); yield created.scope.rawDispose */ }
}
async function fixture(t, { live = false, running = false, generated = false, shared = false } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-cleaner-fixture-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'sessions'), cwd = join(base, 'workspace'), stateDir = join(base, 'cleaner');
  await mkdir(cwd, { recursive: true });
  const persistence = new JsonlSessionPersistence(root);
  const liveSessions = new Map(), agents = new Map(), effects = [], historyCalls = [];
  async function add(id, extra = {}) {
    const header = { id, version: 4, createdAt: 100, cwd, isSeeded: false, ...extra };
    const events = [{ type: 'session/title', seq: 0, time: 100, data: { title: `Title ${id}` } }];
    const row = { header, events };
    persistence.rows.set(id, row);
    const path = persistence.locate(header).path;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ header, events }));
    return row;
  }
  await add('one');
  await writeFile(join(dirname(persistence.locate(persistence.rows.get('one').header).path), 'session.v3.jsonl'), 'retained predecessor');
  await add('keep');
  const order = ['one', 'keep'];
  const workspace = { id: 'group', title: 'Test workspace', path: cwd, get sessionIds() { return [...order]; }, async detachSession(id) { const at = order.indexOf(id); if (at >= 0) order.splice(at, 1); } };
  const registry = {
    archivedSessionIds: [], pinnedSessionIds: ['one'], headers: new Map(), sessionPaths: new Map(), missingSessionPaths: new Set(), invalidSessionPaths: new Map(),
    list: () => registry.deleted ? [] : [workspace], get: id => id === 'group' && !registry.deleted ? workspace : undefined,
    archiveSession: async id => { if (!registry.archivedSessionIds.includes(id)) registry.archivedSessionIds.push(id); registry.pinnedSessionIds = registry.pinnedSessionIds.filter(value => value !== id); effects.push(`archive:${id}`); },
    unarchiveSession: async id => { registry.archivedSessionIds = registry.archivedSessionIds.filter(value => value !== id); },
    pinSession: async id => { registry.pinnedSessionIds.push(id); },
    unpinSession: async id => { registry.pinnedSessionIds = registry.pinnedSessionIds.filter(value => value !== id); },
    delete: async id => { assert.equal(id, 'group'); registry.deleted = true; },
  };
  const loop = new AgentLoop();
  if (live) {
    const row = persistence.rows.get('one'), scoped = {};
    const session = { id: 'one', header: row.header, snapshotEvents: () => row.events };
    const agent = { id: 'one', status: running ? 'running' : 'idle', session, ctx: scoped, scope: { ctx: scoped } };
    agents.set('one', agent); liveSessions.set('one', session); persistence.tracker.writers.set('one', {});
    const dispose = async () => { effects.push('ordered-dispose:one'); persistence.tracker.writers.delete('one'); agents.delete('one'); liveSessions.delete('one'); };
    dispose[EFFECT] = { label: 'agentLoop.scope(one)' };
    loop.runtime.ctx.fiber._disposables.push(dispose);
  }
  const generatedPath = join(cwd, 'generated.txt');
  if (generated) await writeFile(generatedPath, 'made by session one');
  const tracker = { stateDir: join(stateDir, 'artifacts'), warnings: [], history: async (id, events) => historyCalls.push([id, events.length]), candidates: async ids => generated && !shared && ids.includes('one') ? [{ path: generatedPath, bytes: 19, fingerprint: sha('made by session one'), sessionIds: ['one'] }] : [] };
  const table = { delete: async id => { effects.push(`cache:${id}`); return true; } };
  const ctx = { sessionPersistence: persistence, workspaceRegistry: registry, agentLoop: loop,
    sessions: { list: () => [...liveSessions.values()], get: id => liveSessions.get(id) }, agents: { get: id => agents.get(id) },
    storageDomain: { get: () => ({ table: () => table }) }, sessionQuery: { searchSessions: async () => { effects.push('reconcile'); return { items: [] }; } },
    waterfall: async (_event, _request, next) => next(), emit: (event, id) => effects.push(`${event}:${id}`),
  };
  ctx.get = name => ctx[name];
  const cleaner = new SessionCleaner(ctx, { stateDir, tracker });
  cleaner._platform = 'win32';
  return { base, root, cwd, ctx, persistence, cleaner, effects, historyCalls, generatedPath, add, agents, registry };
}
const exists = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

test('removes all generations, keeps other session and cwd, refreshes derived state', async t => {
  const f = await fixture(t);
  const preview = await f.cleaner.preview({ kind: 'session', id: 'one' });
  assert.deepEqual(preview.blocked, []);
  assert.equal(preview.title, 'Title one');
  assert.equal(preview.files.filter(file => file.kind === 'session-data').length, 2);
  const result = await f.cleaner.remove({ token: preview.token }, 'different');
  assert.deepEqual(result.deletedSessionIds, ['one']);
  assert.equal(result.deletedFiles.filter(file => file.kind === 'session-data').length, 2);
  assert.equal(await f.persistence.stat('one'), undefined);
  assert.ok(await f.persistence.stat('keep'));
  assert.ok(await exists(f.cwd));
  assert.ok(f.effects.includes('cache:one'));
  assert.ok(f.effects.includes('api-session/removed:one'));
  assert.ok(f.effects.includes('reconcile'));
  assert.ok(f.historyCalls.some(([id]) => id === 'keep'));
});

test('quiet live Agent uses exact ordered factory lifecycle before acquiring writer', async t => {
  const f = await fixture(t, { live: true });
  const p = await f.cleaner.preview({ kind: 'session', id: 'one' });
  assert.deepEqual(p.blocked, []);
  const result = await f.cleaner.remove({ token: p.token });
  assert.deepEqual(result.deletedSessionIds, ['one']);
  assert.ok(f.effects.indexOf('archive:one') < f.effects.indexOf('ordered-dispose:one'));
  assert.equal(f.persistence.tracker.writers.size, 0);
});

test('running target stays blocked without archive or file changes', async t => {
  const f = await fixture(t, { live: true, running: true });
  const p = await f.cleaner.preview({ kind: 'session', id: 'one' });
  assert.ok(p.blocked.some(text => text.includes('请先停止')));
  await assert.rejects(f.cleaner.remove({ token: p.token }), /请先停止/);
  assert.ok(await f.persistence.stat('one'));
  assert.deepEqual(f.effects, []);
});

test('rejects expired, stale, self-targeted and reused confirmation tokens', async t => {
  const f = await fixture(t);
  const first = await f.cleaner.preview({ kind: 'session', id: 'one' });
  await assert.rejects(f.cleaner.remove({ token: first.token }, 'one'), /当前执行/);
  f.cleaner.plans.get(first.token).expires = 0;
  await assert.rejects(f.cleaner.remove({ token: first.token }), /过期/);
  const stale = await f.cleaner.preview({ kind: 'session', id: 'one' });
  await writeFile(f.persistence.locate(f.persistence.rows.get('one').header).path, 'changed persisted bytes');
  await assert.rejects(f.cleaner.remove({ token: stale.token }), /发生变化/);
  assert.ok(await f.persistence.stat('one'));
  const valid = await f.cleaner.preview({ kind: 'session', id: 'one' });
  await f.cleaner.remove({ token: valid.token });
  await assert.rejects(f.cleaner.remove({ token: valid.token }), /过期/);
});

test('workspace cascade includes owned subagents and leaves independent forks', async t => {
  const f = await fixture(t);
  await f.add('child', { origin: 'subagent', parentSession: 'one' });
  await f.add('fork', { isSeeded: true, parentSession: 'one' });
  const p = await f.cleaner.preview({ kind: 'workspace', id: 'group' });
  assert.deepEqual(p.sessionIds, ['child', 'keep', 'one']);
  const result = await f.cleaner.remove({ token: p.token });
  assert.equal(result.deletedWorkspaceId, 'group');
  assert.ok(await f.persistence.stat('fork'));
  assert.ok(await exists(f.cwd));
});

test('hash-matching generated file is removed only after retained history was checked', async t => {
  const f = await fixture(t, { generated: true });
  const p = await f.cleaner.preview({ kind: 'session', id: 'one' });
  assert.equal(p.files.filter(file => file.kind === 'generated').length, 1);
  const result = await f.cleaner.remove({ token: p.token });
  assert.equal(await exists(f.generatedPath), false);
  assert.ok(result.deletedFiles.some(file => file.path === f.generatedPath));
});

test('shared and externally changed generated files survive', async t => {
  const f = await fixture(t, { generated: true, shared: true });
  const p = await f.cleaner.preview({ kind: 'session', id: 'one' });
  assert.equal(p.files.filter(file => file.kind === 'generated').length, 0);
  await f.cleaner.remove({ token: p.token });
  assert.ok(await exists(f.generatedPath));
  const g = await fixture(t, { generated: true });
  const stale = await g.cleaner.preview({ kind: 'session', id: 'one' });
  await writeFile(g.generatedPath, 'external edit');
  const changedResult = await g.cleaner.remove({ token: stale.token });
  assert.deepEqual(changedResult.deletedSessionIds, ['one']);
  assert.ok(changedResult.warnings.some(text => text.includes('保留')));
  assert.equal(await readFile(g.generatedPath, 'utf8'), 'external edit');
});

test('external writer contention preserves logs and restores archive/pin state', async t => {
  const f = await fixture(t);
  const p = await f.cleaner.preview({ kind: 'session', id: 'one' });
  f.persistence.busy.add('one');
  await assert.rejects(f.cleaner.remove({ token: p.token }), /Owned/);
  assert.ok(await f.persistence.stat('one'));
  assert.deepEqual(f.registry.archivedSessionIds, []);
  assert.ok(f.registry.pinnedSessionIds.includes('one'));
});

test('unrelated session activity does not invalidate target log deletion', async t => {
  const f = await fixture(t);
  const p = await f.cleaner.preview({ kind: 'session', id: 'one' });
  f.persistence.rows.get('keep').events.push({ type: 'user/message', seq: 1, time: 101, data: { content: [{ type: 'text', text: 'unrelated work' }] } });
  await writeFile(f.persistence.locate(f.persistence.rows.get('keep').header).path, 'unrelated new durable revision');
  const result = await f.cleaner.remove({ token: p.token });
  assert.deepEqual(result.deletedSessionIds, ['one']);
  assert.ok(await f.persistence.stat('keep'));
});

test('a new shared reference after preview preserves generated file', async t => {
  const f = await fixture(t, { generated: true });
  const p = await f.cleaner.preview({ kind: 'session', id: 'one' });
  assert.ok(p.files.some(file => file.kind === 'generated'));
  f.cleaner.tracker.candidates = async () => [];
  const result = await f.cleaner.remove({ token: p.token });
  assert.deepEqual(result.deletedSessionIds, ['one']);
  assert.ok(await exists(f.generatedPath));
  assert.ok(result.warnings.some(text => text.includes('共享引用')));
});

test('catalog is lossless JSON when ordinary sessions have no origin', async t => {
  const f = await fixture(t);
  const value = await f.cleaner.catalog();
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  assert.equal(Object.hasOwn(value.sessions[0], 'origin'), false);
});

test('source adapter rejects alternate backend implementations', async t => {
  const f = await fixture(t);
  f.persistence.config.root = join(f.base, 'different');
  const p = await f.cleaner.preview({ kind: 'session', id: 'one' });
  assert.ok(p.blocked.some(text => text.includes('适配版本')));
  await assert.rejects(f.cleaner.remove({ token: p.token }), /适配版本/);
});
