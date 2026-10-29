import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath, readFile, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const EFFECT = Symbol.for('cordis.effect');
const ORIGINAL = Symbol.for('cordis.original');
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const TTL = 10 * 60 * 1000;
const unwrap = value => value?.[ORIGINAL] ?? value;
const digest = value => createHash('sha256').update(value).digest('hex');
const hashJSON = value => digest(JSON.stringify(value));
const unique = values => [...new Set(values)];
const codeOf = error => error?.code;
const messageOf = error => error instanceof Error ? error.message : String(error);
function fail(message, code = 'CLEANER_BLOCKED') { const error = new Error(message); error.code = code; throw error; }
function inside(parent, child, equal = false) {
  const rel = relative(resolve(parent), resolve(child));
  return (equal && rel === '') || (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function samePath(a, b) { return relative(resolve(a), resolve(b)) === ''; }
function encodeSegment(raw) {
  if (!raw) fail('会话 ID 为空');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}
function projectKey(cwd) {
  let readable = '', separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const ch = cwd[i];
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else {
      readable += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${cwd.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}
async function noLinks(path) {
  const absolute = resolve(path);
  let cursor = parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) fail(`路径包含符号链接或目录联接：${cursor}`);
    } catch (error) { if (codeOf(error) === 'ENOENT') return; throw error; }
  }
}
async function fingerprint(path) {
  await noLinks(path);
  let before;
  try { before = await lstat(path); } catch (error) { if (codeOf(error) === 'ENOENT') return undefined; throw error; }
  if (!before.isFile() || before.isSymbolicLink()) fail(`仅处理普通文件：${path}`);
  const sha = createHash('sha256');
  for await (const chunk of createReadStream(path)) sha.update(chunk);
  const after = await lstat(path);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.dev !== after.dev) fail(`读取期间文件发生变化：${path}`, 'CLEANER_STALE');
  return { sha256: sha.digest('hex'), bytes: after.size, mtimeMs: after.mtimeMs, dev: after.dev, ino: after.ino };
}
function sameFingerprint(a, b) { return a && b && a.sha256 === b.sha256 && a.bytes === b.bytes && a.dev === b.dev && a.ino === b.ino && a.mtimeMs === b.mtimeMs; }
function trackedHash(value) {
  if (typeof value === 'string') return /^(?:sha256:)?([a-f\d]{64})$/i.exec(value)?.[1]?.toLowerCase();
  return value?.sha256 ?? value?.hash ?? value?.digest;
}
async function treeFiles(dir) {
  await noLinks(dir);
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (codeOf(error) === 'ENOENT') return []; throw error; }
  const result = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name), info = await lstat(path);
    if (info.isSymbolicLink()) fail(`会话目录含链接，保留目录：${path}`);
    if (info.isDirectory()) result.push(...await treeFiles(path));
    else if (info.isFile()) result.push({ path, bytes: info.size, fingerprint: await fingerprint(path), kind: 'session-data' });
    else fail(`会话目录含特殊文件：${path}`);
  }
  return result;
}

/**
 * Source-pinned adapter for DSH 0.2.1-rc.3 / Cordis 4.0.5. No private adapter
 * runs solely because a property happens to exist: its owning implementation
 * and the load-bearing method bodies must match the installed source shape.
 * Evidence: dsh-session-persistence-jsonl/lib/index.js:858,880,907,2403,2488;
 * dsh-agent-loop/lib/index.js:1681-1805; cordis/lib/index.js:1169-1248.
 */
function persistenceAdapter(service) {
  const p = unwrap(service), proto = p && Object.getPrototypeOf(p);
  if (p?.constructor?.name !== 'JsonlSessionPersistence' || typeof p.root !== 'string' || !isAbsolute(p.root)
    || typeof p.config?.root !== 'string' || !samePath(p.root, p.config.root)
    || !(p.tracker?.writers instanceof Map) || !(p.tracker?.openHandles instanceof Set)
    || !String(proto?.locate).includes('logPath(this.root, meta.cwd, meta.id, this.compression)')
    || !String(proto?.open).includes('this.tracker.claimWrite(id)')
    || !String(proto?.open).includes('this.acquireLease(id, void 0, dirname(resolved.currentPath))')) {
    fail('当前持久化实现与已核对的 JSONL 适配版本不同；保留数据并检查适配器。');
  }
  return p;
}
function lifecycleDisposer(ctx, agent) {
  const loop = unwrap(ctx.agentLoop), proto = loop && Object.getPrototypeOf(loop);
  const body = String(proto?.prepare);
  if (loop?.constructor?.name !== 'AgentLoop' || !body.includes('await handle?.close()')
    || !body.includes('detachAgent?.()') || !body.includes('detachSession?.()')
    || !body.includes('agentLoop.scope(${id})') || !body.includes('yield created.scope.rawDispose')
    || agent?.scope?.ctx !== agent.ctx) fail(`会话 ${agent?.id} 的有序生命周期适配检查未通过。`);
  const fiber = loop.runtime?.ctx?.fiber;
  const found = [...(fiber?._disposables ?? [])].filter(dispose => dispose?.[EFFECT]?.label === `agentLoop.scope(${agent.id})`);
  if (found.length !== 1) fail(`会话 ${agent.id} 的有序生命周期句柄数量为 ${found.length}；请停止后重试。`);
  return found[0];
}

export class SessionCleaner {
  constructor(ctx, { stateDir, tracker }) {
    if (!ctx || !stateDir || !tracker) throw new TypeError('ctx、stateDir、tracker 为必填参数');
    this.ctx = ctx;
    this.stateDir = resolve(stateDir);
    this.ledgerDir = resolve(tracker.stateDir ?? join(stateDir, 'artifacts'));
    this.tracker = tracker;
    this.plans = new Map();
    this.tail = Promise.resolve();
    this._platform = process.platform;
  }
  _service(name) { return this.ctx.get?.(name) ?? this.ctx[name]; }
  async _corpus() {
    const p = this._service('sessionPersistence');
    if (!p) fail('当前没有会话持久化服务。');
    const snapshots = await p.list();
    const records = new Map(snapshots.map(snapshot => [snapshot.header.id, { header: snapshot.header, snapshot }]));
    for (const session of this._service('sessions')?.list() ?? []) {
      const old = records.get(session.id);
      records.set(session.id, { ...old, header: session.header, session });
    }
    for (const record of records.values()) record.agent = this._service('agents')?.get(record.header.id);
    return records;
  }
  async _history(record) {
    if (record.session) return [...record.session.snapshotEvents()];
    const handle = await this._service('sessionPersistence').open(record.header.id, 'read');
    try { return [...(await handle.read()).events]; } finally { await handle.close(); }
  }
  _title(record, events = []) {
    const cache = this._service('sessionProjectionCache')?.cachedSnapshot(record.header, ['title'])?.values?.title;
    if (typeof cache === 'string' && cache) return cache;
    if (typeof cache?.title === 'string' && cache.title) return cache.title;
    for (let i = events.length - 1; i >= 0; i--) if (events[i].type === 'session/title' && typeof events[i].data?.title === 'string') return events[i].data.title;
    return record.header.id;
  }
  async catalog() {
    const records = await this._corpus();
    const sessions = [];
    for (const [id, record] of records) {
      let events = record.session ? [...record.session.snapshotEvents()] : [];
      if (!events.length && !this._service('sessionProjectionCache')) {
        try { events = await this._history(record); } catch { /* listing stays available for damaged history */ }
      }
      let title = this._title(record, events);
      if (title === id && this._service('sessionQuery')?.readTitle) try {
        const value = await this._service('sessionQuery').readTitle(id);
        if (typeof value?.title === 'string' && value.title) title = value.title;
      } catch { /* a corrupt title must not hide the catalog entry */ }
      sessions.push({ id, title, ...(record.header.cwd===undefined?{}:{cwd:record.header.cwd}), running: record.agent?.status === 'running', ...(record.header.origin===undefined?{}:{origin:record.header.origin}) });
    }
    const workspaces = (this._service('workspaceRegistry')?.list() ?? []).map(workspace => ({ id: workspace.id, title: workspace.title, path: workspace.path, sessionIds: [...workspace.sessionIds] }));
    return { sessions, workspaces };
  }
  async _activity(id) {
    if (this._service('agents')?.get(id)?.status === 'running') return ['turn'];
    if (typeof this.ctx.waterfall !== 'function') return [];
    return (await this.ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))).map(item => item.kind);
  }
  _directory(p, header) {
    const location = p.locate(header);
    const expected = join(p.root, header.cwd === undefined ? '_no-cwd' : projectKey(header.cwd), encodeSegment(header.id));
    if (location?.kind !== 'jsonl' || typeof location.path !== 'string' || !samePath(dirname(location.path), expected)
      || !inside(p.root, expected) || inside(expected, PLUGIN_DIR, true) || inside(expected, this.stateDir, true)) fail(`会话 ${header.id} 的日志路径验证未通过。`);
    return expected;
  }
  _projection() {
    const domain = unwrap(this._service('storageDomain')?.get('session_projcache'));
    const unit = domain?.unit;
    // PerRecordJsonUnit.dir is source-pinned in dsh-storage-json:437-470.
    const dir = unit?.constructor?.name === 'PerRecordJsonUnit' && unit.descriptor?.name === 'session_projcache' && unit.descriptor?.layout === 'per-record' ? unit.dir : undefined;
    return { domain, dir: typeof dir === 'string' && isAbsolute(dir) ? dir : undefined };
  }
  async _build({ kind, id }) {
    if (!['session', 'workspace'].includes(kind) || typeof id !== 'string' || !id) fail('删除目标参数无效。');
    const warnings = [
      '工作区原目录与已有文件保留；仅清理证据完整且内容未变化的会话生成文件。',
      '历史 shell 创建文件缺少可靠创建前证据时保留；共享附件、共享请求图片缓存及共享 SQLite 文件保留。',
      '文件归属账本保留少量路径与哈希元数据，以保全其他会话的共享引用保护；账本不保存完整会话内容。',
    ];
    const blocked = [];
    let p;
    try { p = persistenceAdapter(this._service('sessionPersistence')); } catch (error) { blocked.push(messageOf(error)); }
    if (this._platform !== 'win32') blocked.push('当前物理删除适配器限定 Windows 内核信号量实现；该平台保留日志。');
    const records = await this._corpus();
    const workspace = kind === 'workspace' ? this._service('workspaceRegistry')?.get(id) : undefined;
    if (kind === 'workspace' && !workspace) fail('工作区分组不存在。', 'CLEANER_NOT_FOUND');
    if (kind === 'session' && !records.has(id)) fail('会话不存在。', 'CLEANER_NOT_FOUND');
    const selected = new Set(kind === 'session' ? [id] : workspace.sessionIds.filter(sessionId => records.has(sessionId)));
    // Owned subagents follow their parent; independent forks remain separate.
    for (let changed = true; changed;) {
      changed = false;
      for (const [childId, record] of records) if (record.header.origin === 'subagent' && selected.has(record.header.parentSession) && !selected.has(childId)) { selected.add(childId); changed = true; }
    }
    const histories = new Map();
    let completeHistory = true;
    for (const [sessionId, record] of records) {
      try {
        const events = await this._history(record);
        histories.set(sessionId, events);
        await this.tracker.history(sessionId, events, record.header.cwd);
      } catch (error) {
        if (selected.has(sessionId)) blocked.push(`读取会话 ${sessionId} 失败：${messageOf(error)}`);
        else { completeHistory = false; warnings.push(`保留会话 ${sessionId} 的历史读取失败，生成文件全部保留。`); }
      }
    }
    const files = [], directories = new Map(), stamps = [];
    for (const sessionId of selected) {
      const record = records.get(sessionId), activity = await this._activity(sessionId);
      if (activity.length) blocked.push(`会话 ${sessionId} 仍有活动（${activity.join('、')}），请先停止后重新预览。`);
      if (record.agent) try { lifecycleDisposer(this.ctx, record.agent); } catch (error) { blocked.push(messageOf(error)); }
      if (p) try {
        const dir = this._directory(p, record.header);
        await noLinks(dir);
        directories.set(sessionId, dir);
        files.push(...await treeFiles(dir));
      } catch (error) { blocked.push(messageOf(error)); }
      stamps.push([sessionId, record.snapshot?.revision ?? null, hashJSON(histories.get(sessionId) ?? [])]);
    }
    const home = resolve(process.env.DSH_HOME || join(dirname(p?.root ?? this.stateDir), '..'));
    if (completeHistory) for (const candidate of await this.tracker.candidates([...selected])) {
      const path = typeof candidate.path === 'string' ? resolve(candidate.path) : undefined;
      if (!path || !isAbsolute(candidate.path) || !selected.size || (candidate.sessionIds ?? []).some(sessionId => !selected.has(sessionId))) continue;
      if (inside(home, path, true) || inside(PLUGIN_DIR, path, true) || inside(this.stateDir, path, true) || [...directories.values()].some(dir => inside(dir, path, true))) {
        warnings.push(`保护共享或插件路径，保留：${path}`); continue;
      }
      try {
        const fp = await fingerprint(path), expected = trackedHash(candidate.fingerprint);
        if (!fp) continue;
        if (!expected || fp.sha256 !== String(expected).replace(/^sha256:/, '').toLowerCase()) { warnings.push(`生成文件内容已变化或缺少哈希，保留：${path}`); continue; }
        files.push({ path, bytes: fp.bytes, kind: 'generated', fingerprint: fp });
      } catch (error) { warnings.push(`生成文件保留：${path}（${messageOf(error)}）`); }
    }
    const projection = this._projection();
    for (const sessionId of selected) {
      const cachePaths = [];
      if (projection.dir && /^[a-zA-Z0-9_-]+$/.test(sessionId)) {
        const dir = join(projection.dir, 'sessions');
        cachePaths.push(join(dir, `${sessionId}.json`));
        try { for (const name of await readdir(dir)) if (name.startsWith(`${sessionId}.json.bak.`)) cachePaths.push(join(dir, name)); } catch (error) { if (codeOf(error) !== 'ENOENT') warnings.push(`缓存备份列表读取失败：${messageOf(error)}`); }
      }
      for (const path of cachePaths) try {
        const fp = await fingerprint(path);
        if (fp) files.push({ path, bytes: fp.bytes, kind: 'cache', fingerprint: fp, projection: projection.dir && inside(projection.dir, path) });
      } catch (error) { warnings.push(`缓存文件保留：${path}（${messageOf(error)}）`); }
    }
    const deduplicated = [...new Map(files.map(file => [resolve(file.path), file])).values()].sort((a, b) => a.path.localeCompare(b.path));
    const sessionIds = [...selected].sort();
    const title = kind === 'workspace' ? workspace.title : this._title(records.get(id), histories.get(id));
    const corpus = [...records].filter(([sessionId]) => selected.has(sessionId)).map(([sessionId, record]) => [sessionId, record.snapshot?.revision ?? null, hashJSON(histories.get(sessionId) ?? [])]).sort((a, b) => a[0].localeCompare(b[0]));
    const signature = hashJSON({ kind, id, sessionIds, corpus, workspace: workspace ? [workspace.id, workspace.path, [...workspace.sessionIds]] : null, files: deduplicated.filter(file => file.kind === 'session-data').map(file => [file.path, file.fingerprint]) });
    warnings.push(...this.tracker.warnings ?? []);
    return { kind, id, title, sessionIds, records, histories, directories, stamps, files: deduplicated, warnings: unique(warnings), blocked: unique(blocked), signature, p };
  }
  async preview(request) {
    const plan = await this._build(request), token = randomUUID();
    for (const [oldToken, oldPlan] of this.plans) if (oldPlan.expires < Date.now()) this.plans.delete(oldToken);
    if (this.plans.size >= 100) this.plans.delete(this.plans.keys().next().value);
    this.plans.set(token, { ...plan, expires: Date.now() + TTL });
    return { token, title: plan.title, sessionIds: plan.sessionIds, files: plan.files.map(({ path, bytes, kind }) => ({ path, bytes, kind })), warnings: plan.warnings, blocked: plan.blocked };
  }
  remove(request, callerSessionId) {
    const task = this.tail.then(() => this._remove(request, callerSessionId));
    this.tail = task.catch(() => {});
    return task;
  }
  async _remove({ token } = {}, callerSessionId) {
    const plan = this.plans.get(token);
    if (!plan || plan.expires < Date.now()) { this.plans.delete(token); fail('预览已过期，请重新预览。', 'CLEANER_STALE'); }
    if (callerSessionId && plan.sessionIds.includes(callerSessionId)) fail('当前执行删除工具的会话属于删除目标，请在其他会话或侧栏管理器操作。');
    if (plan.blocked.length) fail(plan.blocked.join('\n'));
    const fresh = await this._build({ kind: plan.kind, id: plan.id });
    if (fresh.blocked.length) fail(fresh.blocked.join('\n'));
    if (fresh.signature !== plan.signature) fail('会话、分组或文件在预览后发生变化，请重新预览。', 'CLEANER_STALE');
    const approvedGenerated = new Map(plan.files.filter(file => file.kind === 'generated').map(file => [file.path, file]));
    fresh.files = fresh.files.filter(file => file.kind !== 'generated' || sameFingerprint(approvedGenerated.get(file.path)?.fingerprint, file.fingerprint));
    for (const file of approvedGenerated.values()) if (!fresh.files.some(current => current.kind === 'generated' && current.path === file.path)) fresh.warnings.push(`文件内容或共享引用在预览后变化，保留：${file.path}`);
    this.plans.delete(token);
    const p = fresh.p, registry = this._service('workspaceRegistry');
    if (!registry) fail('工作区注册表服务缺席，删除暂缓。');
    const priorArchive = new Set(registry.archivedSessionIds ?? []), priorPins = new Set(registry.pinnedSessionIds ?? []);
    const archived = [], claims = [], deletedSessionIds = [], deletedFiles = [];
    const warnings = [...fresh.warnings];
    let deletedWorkspaceId;
    try {
      for (const id of fresh.sessionIds) {
        if ((await this._activity(id)).length) fail(`会话 ${id} 刚刚开始活动，请停止后重新预览。`);
        await registry.archiveSession(id, { stopActivity: true });
        archived.push(id);
      }
      for (const id of fresh.sessionIds) {
        if (this._service('agents')?.get(id)?.status === 'running') fail(`会话 ${id} 的活动尚未停止，请重新预览。`);
        const agent = this._service('agents')?.get(id);
        if (agent) await lifecycleDisposer(this.ctx, agent)();
        if (this._service('agents')?.get(id) || this._service('sessions')?.get(id)) fail(`会话 ${id} 的生命周期仍在关闭，数据保留。`);
      }
      // All kernel locks are acquired before the first destructive operation.
      // Windows named semaphores have no file footprint and survive directory rm.
      for (const id of fresh.sessionIds) {
        if (!await p.stat(id)) continue; // never-materialized session: disposal removed it
        const claim = await p.open(id, 'write');
        claims.push(claim);
        const actual = (await claim.read()).events;
        const expected = fresh.histories.get(id) ?? [];
        const cleanupTail = actual.slice(expected.length);
        if (hashJSON(actual.slice(0, expected.length)) !== hashJSON(expected) || cleanupTail.some(event => event.type !== 'agent/inbox/spliced' || event.data?.outcome !== 'canceled' || event.data?.inserted?.length)) fail(`会话 ${id} 的持久化内容发生变化，数据保留。`, 'CLEANER_STALE');
      }
      // Closing a live Agent can write its final projection checkpoint, so cache
      // files are excluded from the immutable user-data signature and removed
      // through the coherent domain write chain after every Agent is gone.
      for (const id of fresh.sessionIds) {
        for (const workspace of registry.list()) await workspace.detachSession(id);
        const dir = fresh.directories.get(id);
        await noLinks(dir);
        const actualFiles = await treeFiles(dir);
        // Every file inside this source-verified directory is session-owned,
        // including immutable predecessors and a successor published by open.
        if (actualFiles.length || await this._exists(dir)) {
          await rm(dir, { recursive: true, force: false });
          deletedFiles.push(...actualFiles.map(file => ({ path: file.path, bytes: file.bytes, kind: 'session-data' })));
          try { await rmdir(dirname(dir)); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(codeOf(error))) warnings.push(`日志项目目录保留：${messageOf(error)}`); }
        }
        p.coldLogMemo?.delete(id);
        deletedSessionIds.push(id);
      }
      const projection = this._projection();
      for (const id of deletedSessionIds) {
        try { await projection.domain?.table('sessions').delete(id); } catch (error) { warnings.push(`投影缓存记录清理失败（${id}）：${messageOf(error)}`); }
        const cacheFiles = fresh.files.filter(file => file.kind === 'cache' && (file.path === join(this.ledgerDir, `${digest(id)}.json`) || (projection.dir && file.path.startsWith(join(projection.dir, 'sessions', `${id}.json`)))));
        for (const file of cacheFiles) {
          try {
            const now = await fingerprint(file.path);
            if (!now) { deletedFiles.push({ path: file.path, bytes: file.bytes, kind: 'cache' }); continue; }
            // Canonical projection document was removed via domain.delete; only
            // hash-stable backups and this session's private ledger use unlink.
            if (sameFingerprint(file.fingerprint, now)) { await rm(file.path); deletedFiles.push({ path: file.path, bytes: file.bytes, kind: 'cache' }); }
            else warnings.push(`缓存文件发生变化，保留：${file.path}`);
          } catch (error) { warnings.push(`缓存文件清理失败：${file.path}（${messageOf(error)}）`); }
        }
        unwrap(registry).headers?.delete(id);
        unwrap(registry).sessionPaths?.delete(id);
        unwrap(registry).missingSessionPaths?.delete(id);
        unwrap(registry).invalidSessionPaths?.delete(id);
        await registry.unarchiveSession(id);
        await registry.unpinSession(id);
      }
      const finalCandidates = new Map((await this.tracker.candidates(deletedSessionIds)).map(file => [resolve(file.path), file]));
      for (const file of fresh.files.filter(file => file.kind === 'generated')) {
        try {
          const candidate = finalCandidates.get(file.path);
          if (!candidate || trackedHash(candidate.fingerprint) !== file.fingerprint.sha256 || (candidate.sessionIds ?? []).some(id => !deletedSessionIds.includes(id))) { warnings.push(`最新共享引用判定要求保留：${file.path}`); continue; }
          if (!sameFingerprint(file.fingerprint, await fingerprint(file.path))) { warnings.push(`生成文件发生变化，保留：${file.path}`); continue; }
          await rm(file.path);
          deletedFiles.push({ path: file.path, bytes: file.bytes, kind: 'generated' });
          // Only empty ancestor directories, bounded strictly inside a recorded
          // workspace, are candidates. The cwd itself is always retained.
          const roots = fresh.sessionIds.map(id => fresh.records.get(id).header.cwd).filter(Boolean);
          let cursor = dirname(file.path);
          while (roots.some(root => inside(root, cursor))) {
            try { await noLinks(cursor); await rmdir(cursor); } catch { break; }
            cursor = dirname(cursor);
          }
        } catch (error) { warnings.push(`生成文件清理失败：${file.path}（${messageOf(error)}）`); }
      }
      if (fresh.kind === 'workspace') { await registry.delete(fresh.id); deletedWorkspaceId = fresh.id; }
    } catch (error) {
      // Restore temporary gates only for Sessions whose authoritative log stays.
      for (const id of archived.filter(id => !deletedSessionIds.includes(id))) try {
        if (!priorArchive.has(id)) await registry.unarchiveSession(id);
        if (priorPins.has(id)) await registry.pinSession(id);
      } catch (rollbackError) { warnings.push(`还原会话状态失败（${id}）：${messageOf(rollbackError)}`); }
      error.partial = { deletedSessionIds, deletedWorkspaceId, deletedFiles, warnings };
      throw error;
    } finally {
      for (const claim of claims.reverse()) try { await claim.close(); } catch (error) { warnings.push(`关闭删除写锁失败：${messageOf(error)}`); }
      for (const id of deletedSessionIds) try { this.ctx.emit?.('api-session/removed', id); } catch (error) { warnings.push(`会话列表刷新通知失败：${messageOf(error)}`); }
    }
    // A normal public search reconciles deleted persistent/TEMP FTS rows in one
    // transaction; do not open or remove the live SQLite database externally.
    const query = this._service('sessionQuery');
    if (query?.searchSessions) try { await query.searchSessions({ query: 'session-cleaner-reconcile', limit: 1 }); }
    catch (error) { warnings.push(`搜索索引将在下一次成功搜索时刷新：${messageOf(error)}`); }
    return { deletedSessionIds, ...(deletedWorkspaceId ? { deletedWorkspaceId } : {}), deletedFiles: [...new Map(deletedFiles.map(file => [file.path, file])).values()], warnings: unique(warnings) };
  }
  async _exists(path) { try { await lstat(path); return true; } catch (error) { if (codeOf(error) === 'ENOENT') return false; throw error; } }
}

export default SessionCleaner;
