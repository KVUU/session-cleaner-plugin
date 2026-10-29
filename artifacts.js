import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const fsp = fs.promises;
const HASH = /^[a-f0-9]{64}$/;
const ownDirectory = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:\/)/, ''));
const hashText = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const within = (root, file) => {
  const rel = path.relative(key(root), key(file));
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
};
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const argsOf = value => {
  if (object(value)) return value;
  if (typeof value !== 'string') return {};
  try { const parsed = JSON.parse(value); return object(parsed) ? parsed : {}; } catch { return {}; }
};
const toolName = value => String(value ?? '').split(/[.:/]/).at(-1);
const fileArg = args => args.file_path ?? args.path;
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: stat.birthtimeMs });
const sameIdentity = (a, b) => !a || (a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs);
const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
const success = result => result?.isError === false && !result.error;
const texts = result => (Array.isArray(result?.content) ? result.content : []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text);
const relevant = name => ['write', 'edit', 'read', 'read_image', 'present', 'pwsh', 'bash', 'powershell'].includes(name);

/** Local-only ownership cache. No artifact deletion occurs here.
 * Await before() around dispatch and after() on the FINAL ToolExecutionResult.
 * Replay ALL retained sessions before candidates(); references count as touchers.
 * A candidate is a preview: revalidate immediately before unlink.
 * Reports: {warnings:string[],scanned:number,truncated:boolean}.
 * Partial baselines never prove creation. Unknown shell activity in a surviving
 * session protects its cwd. Corrupt or unpersisted state fails closed.
 */
export class ArtifactTracker {
  constructor({ stateDir, protectedRoots = [], maxFiles = 20000 } = {}) {
    if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) throw new TypeError('stateDir must be an absolute path');
    if (!Array.isArray(protectedRoots) || protectedRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) throw new TypeError('protectedRoots must contain absolute paths');
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new TypeError('maxFiles must be a positive safe integer');
    this.stateDir = path.resolve(stateDir);
    this.maxFiles = maxFiles;
    this.protectedRoots = [...new Set([this.stateDir, ownDirectory, process.execPath, process.resourcesPath,
      process.env.DSH_HOME, process.env.DSH_PROFILE_DIR, process.env.DSH_INSTALL_DIR, process.env.DSH_APP_DIR,
      process.env.DSH_RUNTIME_DIR, ...protectedRoots].filter(root => typeof root === 'string' && path.isAbsolute(root)).map(root => path.resolve(root)))];
    this.warnings = [];
    this._ledgers = new Map();
    this._pending = new Map();
    this._tail = Promise.resolve();
    this._ready = false;
    this._unsafe = false;
    this._clock = 0;
  }
  _run(fn) {
    const operation = this._tail.then(fn);
    this._tail = operation.catch(() => {});
    return operation;
  }
  _report() { return { warnings: [], scanned: 0, truncated: false }; }
  _warn(message, report) {
    if (report && !report.warnings.includes(message)) report.warnings.push(message);
    if (!this.warnings.includes(message)) this.warnings.push(message);
    if (this.warnings.length > 200) this.warnings.splice(0, this.warnings.length - 200);
  }
  _now() { return this._clock = Math.max(Date.now(), this._clock + 0.001); }
  _excluded(file) {
    return this.protectedRoots.some(root => within(root, file)) || path.resolve(file).split(/[\\/]/).some(part => ['.git', 'node_modules'].includes(part.toLowerCase()));
  }
  _resolve(raw, cwd) {
    if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0') || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return undefined;
    if (/^[a-z]+:\/\//i.test(raw) || /^\\\\[?.]\\/.test(raw) || (process.platform === 'win32' && /:/.test(raw.replace(/^[A-Za-z]:[\\/]/, '')))) return undefined;
    const root = path.resolve(cwd);
    const file = path.resolve(root, raw);
    return within(root, file) && key(file) !== key(root) && !this._excluded(file) ? { file, cwd: root } : undefined;
  }
  async _ancestors(target, allowMissing = false) {
    const absolute = path.resolve(target);
    const root = path.parse(absolute).root;
    let current = root;
    for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = await fsp.lstat(current); }
      catch (error) { if (allowMissing && error.code === 'ENOENT') return true; throw error; }
      if (stat.isSymbolicLink()) return false;
      if (current !== absolute && !stat.isDirectory()) return false;
    }
    try { return key(path.resolve(await fsp.realpath(absolute))) === key(absolute); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return true; throw error; }
  }
  async _inspect(file, cwd, { fingerprint = true } = {}) {
    if (!this._resolve(file, cwd)) return { exists: true, safe: false };
    try {
      if (!await this._ancestors(file, true)) return { exists: true, safe: false };
      let stat;
      try { stat = await fsp.lstat(file); }
      catch (error) { if (error.code === 'ENOENT') return { exists: false, safe: true }; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { exists: true, safe: false };
      if (!fingerprint) return { exists: true, safe: true, stat, identity: identity(stat) };
      const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!sameStat(stat, opened) || opened.nlink !== 1) return { exists: true, safe: false };
        const hash = crypto.createHash('sha256');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let position = 0;
        while (true) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead) break;
          hash.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        const end = await handle.stat();
        const latest = await fsp.lstat(file);
        if (!sameStat(opened, end) || !sameStat(end, latest) || !await this._ancestors(file)) return { exists: true, safe: false };
        return { exists: true, safe: true, fingerprint: hash.digest('hex'), bytes: end.size, identity: identity(end), stat: end };
      } finally { await handle.close(); }
    } catch { return { exists: true, safe: false }; }
  }
  _ledger(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 4096) return undefined;
    let ledger = this._ledgers.get(sessionId);
    if (!ledger) {
      ledger = { version: 1, sessionId, records: new Map(), uncertainRoots: new Set(), shellCalls: new Set(), incomplete: false };
      this._ledgers.set(sessionId, ledger);
    }
    return ledger;
  }
  _record(ledger, resolved, patch, report) {
    if (!ledger || !resolved) return;
    const recordKey = key(resolved.file);
    let record = ledger.records.get(recordKey);
    if (!record) {
      if (ledger.records.size >= this.maxFiles) {
        ledger.incomplete = true;
        ledger.uncertainRoots.add(resolved.cwd);
        report.truncated = true;
        this._warn(`Artifact ledger limit ${this.maxFiles} reached for session ${ledger.sessionId}; untracked paths under ${resolved.cwd} are protected.`, report);
        return;
      }
      record = { path: resolved.file, cwd: resolved.cwd, created: false, touched: true };
      ledger.records.set(recordKey, record);
    }
    record.touched = true;
    if (patch.created) record.created = true;
    if (patch.identity && patch.created && !record.creationIdentity) record.creationIdentity = patch.identity;
    if (patch.evidence && patch.created) record.evidence = patch.evidence;
    if (patch.fingerprint && (record.at === undefined || patch.at > record.at || (patch.at === record.at && record.fingerprint === patch.fingerprint))) {
      record.fingerprint = patch.fingerprint;
      record.bytes = patch.bytes;
      record.at = patch.at;
      if (patch.identity) record.identity = patch.identity;
    }
  }
  async _init(report) {
    if (this._ready) return;
    this._ready = true;
    try {
      if (!await this._ancestors(this.stateDir, true)) throw new Error('stateDir has a symbolic-link or junction ancestor');
      await fsp.mkdir(this.stateDir, { recursive: true });
      if (!await this._ancestors(this.stateDir)) throw new Error('stateDir is not canonical');
      let count = 0;
      const dir = await fsp.opendir(this.stateDir);
      for await (const entry of dir) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        if (++count > this.maxFiles) throw new Error(`ledger count exceeds ${this.maxFiles}`);
        const file = path.join(this.stateDir, entry.name);
        const stat = await fsp.lstat(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink() || stat.size > Math.max(1024 * 1024, this.maxFiles * 8192)) throw new Error(`unsafe ledger ${entry.name}`);
        const data = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (data.version !== 1 || typeof data.sessionId !== 'string' || `${hashText(data.sessionId)}.json` !== entry.name || !Array.isArray(data.records) || data.records.length > this.maxFiles || !Array.isArray(data.uncertainRoots)) throw new Error(`invalid ledger ${entry.name}`);
        const ledger = this._ledger(data.sessionId);
        if (!ledger) throw new Error(`invalid session id in ${entry.name}`);
        for (const record of data.records) {
          if (!object(record) || typeof record.path !== 'string' || typeof record.cwd !== 'string' || !path.isAbsolute(record.path) || !path.isAbsolute(record.cwd) || !within(record.cwd, record.path) || typeof record.created !== 'boolean' || record.touched !== true || (record.fingerprint !== undefined && (!HASH.test(record.fingerprint) || !Number.isFinite(record.at) || !Number.isSafeInteger(record.bytes) || record.bytes < 0))) throw new Error(`invalid record in ${entry.name}`);
          for (const field of ['creationIdentity', 'identity']) {
            if (record[field] && (!object(record[field]) || typeof record[field].dev !== 'string' || typeof record[field].ino !== 'string' || !Number.isFinite(record[field].birthtimeMs))) throw new Error(`invalid identity in ${entry.name}`);
          }
          ledger.records.set(key(path.resolve(record.path)), record);
        }
        for (const root of data.uncertainRoots) {
          if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error(`invalid uncertainty root in ${entry.name}`);
          ledger.uncertainRoots.add(path.resolve(root));
        }
        if (data.shellCalls !== undefined && (!Array.isArray(data.shellCalls) || data.shellCalls.length > this.maxFiles || data.shellCalls.some(id => typeof id !== 'string'))) throw new Error(`invalid shell observations in ${entry.name}`);
        for (const callId of data.shellCalls ?? []) ledger.shellCalls.add(callId);
        ledger.incomplete = data.incomplete === true;
      }
    } catch (error) {
      this._unsafe = true;
      this._warn(`Artifact tracking is fail-closed: ${error.message}`, report);
    }
  }
  async _save(ledger, report) {
    if (!ledger || this._unsafe) return;
    const destination = path.join(this.stateDir, `${hashText(ledger.sessionId)}.json`);
    const temporary = path.join(this.stateDir, `${hashText(ledger.sessionId)}.${crypto.randomBytes(12).toString('hex')}.tmp`);
    try {
      if (!within(this.stateDir, destination) || !within(this.stateDir, temporary) || !await this._ancestors(this.stateDir)) throw new Error('unsafe ledger destination');
      try {
        const existing = await fsp.lstat(destination);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error('unsafe existing ledger');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const data = { version: 1, sessionId: ledger.sessionId, records: [...ledger.records.values()], uncertainRoots: [...ledger.uncertainRoots], shellCalls: [...ledger.shellCalls], incomplete: ledger.incomplete };
      const handle = await fsp.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify(data)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      // Both paths are verified direct children of canonical stateDir.
      await fsp.rename(temporary, destination);
    } catch (error) {
      this._unsafe = true;
      this._warn(`Artifact ledger persistence failed; candidates are disabled: ${error.message}`, report);
    }
  }
  async _scan(cwd, report) {
    const snapshot = { files: new Map(), paths: new Set(), complete: true };
    const root = typeof cwd === 'string' && path.isAbsolute(cwd) ? path.resolve(cwd) : undefined;
    if (!root || this._excluded(root)) {
      snapshot.complete = false;
      this._warn(`Shell scan skipped protected or invalid cwd: ${String(cwd)}`, report);
      return snapshot;
    }
    try {
      if (!await this._ancestors(root)) throw new Error('cwd has a symbolic-link or junction ancestor');
      let visited = 0;
      const stack = [root];
      while (stack.length) {
        const directory = stack.pop();
        if (!await this._ancestors(directory)) throw new Error(`directory changed to a link: ${directory}`);
        const dir = await fsp.opendir(directory);
        for await (const entry of dir) {
          const file = path.join(directory, entry.name);
          if (this._excluded(file)) continue;
          if (++visited > this.maxFiles) {
            snapshot.complete = false;
            report.truncated = true;
            this._warn(`Shell scan limit ${this.maxFiles} entries reached under ${root}; partial baseline never proves new files.`, report);
            return snapshot;
          }
          snapshot.paths.add(key(file));
          const stat = await fsp.lstat(file);
          if (stat.isSymbolicLink()) continue;
          if (stat.isDirectory()) { stack.push(file); continue; }
          if (!stat.isFile() || stat.nlink !== 1) continue;
          const info = await this._inspect(file, root, { fingerprint: false });
          if (!info.safe || !info.exists) throw new Error(`file changed while scanning: ${file}`);
          snapshot.files.set(key(file), { ...info, path: file });
          report.scanned += 1;
        }
      }
    } catch (error) {
      snapshot.complete = false;
      this._warn(`Shell scan incomplete under ${root}: ${error.message}`, report);
    }
    return snapshot;
  }
  before(exec, cwd) {
    const name = toolName(exec?.name);
    if (!relevant(name)) return Promise.resolve(this._report());
    return this._run(async () => {
      const report = this._report();
      await this._init(report);
      const sessionId = exec?.agent?.id;
      const ledger = this._ledger(sessionId);
      if (!ledger || !exec.callId) return report;
      const args = argsOf(exec.arguments);
      const shell = ['pwsh', 'bash', 'powershell'].includes(name);
      if (shell && typeof (args.workdir ?? args.cwd) === 'string') cwd = path.resolve(cwd, args.workdir ?? args.cwd);
      const pending = { sessionId, name, args, cwd, shell, ambiguous: false };
      const pendingKey = `${sessionId}\0${exec.callId}`;
      if (this._pending.has(pendingKey)) this._warn(`Duplicate before() for ${exec.callId}; earlier baseline discarded.`, report);
      if (shell || ['write', 'edit'].includes(name)) {
        for (const other of this._pending.values()) {
          if (typeof cwd === 'string' && typeof other.cwd === 'string' && (within(cwd, other.cwd) || within(other.cwd, cwd))) {
            if (shell) pending.ambiguous = true;
            if (other.shell) other.ambiguous = true;
          }
        }
      }
      if (shell) {
        pending.snapshot = await this._scan(cwd, report);
        for (const info of pending.snapshot.files.values()) this._record(ledger, { file: info.path, cwd: path.resolve(cwd) }, {}, report);
        if (!pending.snapshot.complete && typeof cwd === 'string' && path.isAbsolute(cwd)) ledger.uncertainRoots.add(path.resolve(cwd));
      } else if (['write', 'edit', 'read', 'read_image'].includes(name)) {
        pending.resolved = this._resolve(fileArg(args), cwd);
        if (pending.resolved) {
          pending.info = await this._inspect(pending.resolved.file, pending.resolved.cwd, { fingerprint: false });
          if (pending.info.exists) this._record(ledger, pending.resolved, {}, report);
        }
      }
      this._pending.set(pendingKey, pending);
      await this._save(ledger, report);
      return report;
    });
  }
  after(exec, result, cwd) {
    const name = toolName(exec?.name);
    if (!relevant(name)) return Promise.resolve(this._report());
    return this._run(async () => {
      const report = this._report();
      await this._init(report);
      const sessionId = exec?.agent?.id;
      const ledger = this._ledger(sessionId);
      if (!ledger) return report;
      const pendingKey = `${sessionId}\0${exec.callId}`;
      const pending = this._pending.get(pendingKey);
      this._pending.delete(pendingKey);
      const args = argsOf(exec.arguments);
      if (pending?.shell) {
        const snapshot = await this._scan(pending.cwd, report);
        if (!snapshot.complete && typeof pending.cwd === 'string' && path.isAbsolute(pending.cwd)) ledger.uncertainRoots.add(path.resolve(pending.cwd));
        if (pending.ambiguous) {
          ledger.uncertainRoots.add(path.resolve(pending.cwd));
          this._warn(`Overlapping tool calls under ${pending.cwd}; shell creations are retained as touches only.`, report);
        }
        const ok = success(result) && (result.value?.exitCode === undefined || result.value.exitCode === 0) && !result.value?.jobId && !result.value?.job_id;
        const background = result.value?.jobId || result.value?.job_id;
        if (pending.snapshot.complete && snapshot.complete && !pending.ambiguous && !background && ledger.shellCalls.size < this.maxFiles) ledger.shellCalls.add(exec.callId);
        if (background) {
          ledger.uncertainRoots.add(path.resolve(pending.cwd));
          this._warn(`Background shell ${exec.callId} has no final filesystem boundary; later files are not claimed.`, report);
        }
        for (const [fileKey, observed] of snapshot.files) {
          const previous = pending.snapshot.files.get(fileKey);
          const changed = !previous || !sameStat(previous.stat, observed.stat);
          if (!changed) continue;
          const info = await this._inspect(observed.path, path.resolve(pending.cwd));
          if (!info.safe || !info.exists) continue;
          const created = ok && pending.snapshot.complete && !pending.ambiguous && !pending.snapshot.paths.has(fileKey);
          this._record(ledger, { file: observed.path, cwd: path.resolve(pending.cwd) }, { ...info, created, at: this._now(), evidence: 'complete-shell-baseline' }, report);
        }
      } else if (['pwsh', 'bash', 'powershell'].includes(name)) {
        const rawRoot = args.workdir ?? args.cwd ?? cwd;
        if (typeof cwd === 'string' && path.isAbsolute(cwd) && typeof rawRoot === 'string') ledger.uncertainRoots.add(path.resolve(cwd, rawRoot));
        this._warn(`Shell ${exec.callId} has no before() snapshot; surviving-session cwd is protected.`, report);
      } else if (['write', 'edit', 'read', 'read_image'].includes(name)) {
        const resolved = pending?.resolved ?? this._resolve(fileArg(args), cwd);
        if (resolved && success(result)) {
          const mutation = ['write', 'edit'].includes(name);
          const info = await this._inspect(resolved.file, resolved.cwd, { fingerprint: mutation });
          if (info.safe && info.exists) {
            const created = name === 'write' && !this._updated(result, resolved.file, resolved.cwd) && (pending ? pending.info?.exists === false && pending.info.safe : this._creation(result, resolved.file, resolved.cwd));
            this._record(ledger, resolved, mutation ? { ...info, created, at: this._now(), evidence: 'live-write-absent' } : {}, report);
          }
        }
      } else if (name === 'present' && success(result)) {
        for (const item of Array.isArray(args.files) ? args.files : []) this._record(ledger, this._resolve(item?.path, cwd), {}, report);
      }
      await this._save(ledger, report);
      return report;
    });
  }
  _updated(result, file, cwd) {
    for (const value of [result?.value, result?.meta]) {
      if (!object(value) || !(value.operation === 'update' || value.created === false || value.newFile === false)) continue;
      const returned = value.path === undefined ? { file } : this._resolve(value.path, cwd);
      if (returned && key(returned.file) === key(file)) return true;
    }
    return texts(result).some(text => {
      const match = /^<path>([^\r\n<>]+)<\/path>\r?\n<type>file<\/type>\r?\n<content>\r?\nUpdated file\r?\n<\/content>$/.exec(text.trim());
      const resolved = match && this._resolve(match[1], cwd);
      return resolved && key(resolved.file) === key(file);
    });
  }
  _creation(result, file, cwd) {
    if (!success(result) || this._updated(result, file, cwd)) return false;
    for (const value of [result.value, result.meta]) {
      if (!object(value)) continue;
      const returned = typeof value.path === 'string' ? this._resolve(value.path, cwd) : undefined;
      if (value.path !== undefined && (!returned || key(returned.file) !== key(file))) continue;
      if (value.operation === 'create' || value.created === true || value.newFile === true) return true;
    }
    // Verified current dsh-tool-fs renderer: only operation=create emits this.
    for (const text of texts(result)) {
      const match = /^<path>([^\r\n<>]+)<\/path>\r?\n<type>file<\/type>\r?\n<content>\r?\nCreated file\r?\n<\/content>$/.exec(text.trim());
      const resolved = match && this._resolve(match[1], cwd);
      if (resolved && key(resolved.file) === key(file)) return true;
    }
    return false;
  }
  _absent(result, file, cwd) {
    for (const value of [result?.value, result?.meta]) {
      if (!object(value) || !(value.exists === false || value.kind === 'absent')) continue;
      const resolved = this._resolve(value.path ?? file, cwd);
      if (resolved && key(resolved.file) === key(file)) return true;
    }
    if (result?.isError !== true) return false;
    return [...texts(result), result.error?.message].filter(value => typeof value === 'string').some(text => {
      const match = /^(?:Error:\s*)?cannot read "([^"\r\n]+)": not found\.?$/.exec(text.trim());
      const resolved = match && this._resolve(match[1], cwd);
      return resolved && key(resolved.file) === key(file);
    });
  }
  _references(text, cwd, ledger, report) {
    if (typeof text !== 'string') return;
    if (text.length > 200000 && typeof cwd === 'string' && path.isAbsolute(cwd)) {
      report.truncated = true;
      ledger.uncertainRoots.add(path.resolve(cwd));
      this._warn('Historical text reference scan limited to 200000 characters; surviving-session cwd is protected.', report);
    }
    const matches = text.slice(0, 200000).matchAll(/<path>([^<>\r\n]+)<\/path>|\]\(<?([^>\)\r\n]+)>?\)|["'`]([A-Za-z]:[\\/][^"'`\r\n]+|\/[^"'`\r\n]+)["'`]/g);
    let count = 0;
    for (const match of matches) {
      if (++count > this.maxFiles) {
        report.truncated = true;
        if (typeof cwd === 'string' && path.isAbsolute(cwd)) ledger.uncertainRoots.add(path.resolve(cwd));
        this._warn(`Historical path reference limit ${this.maxFiles} reached; surviving-session cwd is protected.`, report);
        break;
      }
      this._record(ledger, this._resolve(match[1] ?? match[2] ?? match[3], cwd), {}, report);
    }
  }
  history(sessionId, events, cwd) {
    return this._run(async () => {
      const report = this._report();
      await this._init(report);
      const ledger = this._ledger(sessionId);
      if (!ledger || !Array.isArray(events)) return report;
      const calls = new Map();
      const absent = new Set();
      const expected = new Map();
      let currentCwd = cwd;
      let ordinal = 0;
      const processResult = async (call, result, event) => {
        const name = toolName(call.name);
        const args = argsOf(call.arguments);
        const callCwd = call.cwd ?? currentCwd;
        if (name === 'working_directory' && success(result)) {
          const next = result.value?.cwd ?? result.value?.path ?? args.cd;
          if (typeof next === 'string' && typeof callCwd === 'string' && path.isAbsolute(callCwd)) currentCwd = path.resolve(callCwd, next);
        }
        if (['pwsh', 'bash', 'powershell'].includes(name) && !ledger.shellCalls.has(call.callId)) {
          const rawRoot = args.workdir ?? args.cwd ?? callCwd;
          const root = typeof rawRoot === 'string' && typeof callCwd === 'string' && path.isAbsolute(callCwd) ? path.resolve(callCwd, rawRoot) : undefined;
          if (root) ledger.uncertainRoots.add(root);
          this._warn('Historical shell calls lack a before/after snapshot; their cwd is protected for surviving sessions.', report);
        }
        if (name === 'present' && success(result)) {
          for (const item of Array.isArray(args.files) ? args.files : []) this._record(ledger, this._resolve(item?.path, callCwd), {}, report);
        }
        if (['write', 'edit', 'read', 'read_image'].includes(name)) {
          const resolved = this._resolve(fileArg(args), callCwd);
          if (!resolved) return;
          const fileKey = key(resolved.file);
          if (['read', 'read_image'].includes(name)) {
            if (this._absent(result, resolved.file, resolved.cwd)) absent.add(fileKey);
            else if (success(result)) { absent.delete(fileKey); this._record(ledger, resolved, {}, report); }
          } else if (success(result)) {
            const created = name === 'write' && !this._updated(result, resolved.file, resolved.cwd) && (this._creation(result, resolved.file, resolved.cwd) || call.absent === true);
            let content;
            if (typeof result.value?.after === 'string') content = result.value.after;
            else if (name === 'write' && typeof args.content === 'string') content = args.content;
            else if (name === 'edit' && expected.has(fileKey) && typeof args.old_string === 'string' && args.old_string && typeof args.new_string === 'string') {
              const before = expected.get(fileKey);
              const pieces = before.split(args.old_string);
              if (pieces.length === 2 || (args.replace_all === true && pieces.length > 1)) content = args.replace_all ? pieces.join(args.new_string) : before.replace(args.old_string, args.new_string);
            }
            const patch = { created, evidence: call.absent ? 'historical-read-absent' : 'historical-write-create' };
            if (typeof content === 'string') {
              expected.set(fileKey, content);
              patch.fingerprint = hashText(content);
              patch.bytes = Buffer.byteLength(content, 'utf8');
              patch.at = Number.isFinite(event.time) ? event.time : ordinal / 1000000;
              if (created) {
                const info = await this._inspect(resolved.file, resolved.cwd);
                if (info.safe && info.fingerprint === patch.fingerprint) patch.identity = info.identity;
              }
            } else expected.delete(fileKey);
            this._record(ledger, resolved, patch, report);
            absent.delete(fileKey);
          }
        }
        for (const text of texts(result)) this._references(text, callCwd, ledger, report);
      };
      for (const event of events) {
        ordinal += 1;
        if (!object(event)) continue;
        const data = object(event.data) ? event.data : {};
        if (event.type === 'tool/call') {
          const args = argsOf(data.arguments);
          const resolved = this._resolve(fileArg(args), currentCwd);
          const name = toolName(data.name);
          calls.set(data.callId, { ...data, cwd: currentCwd, absent: !!resolved && absent.has(key(resolved.file)) });
          if (['pwsh', 'bash', 'powershell'].includes(name)) absent.clear();
          else if (['write', 'edit'].includes(name) && resolved) absent.delete(key(resolved.file));
        } else if (event.type === 'tool/result') {
          const message = data.message ?? {};
          const id = message.toolCallId ?? message.source?.callId ?? data.callId;
          const call = calls.get(id);
          if (call) {
            const result = data.result ?? { isError: message.isError === true || !!data.error, content: message.content ?? [], meta: data.meta, value: data.value ?? message.value, error: data.error };
            await processResult(call, result, event);
            calls.delete(id);
          }
        } else if (event.type === 'tool/ptc-dispatch') {
          const call = data.exec ?? data.execution ?? data;
          if (typeof call.name === 'string' && data.result) await processResult(call, data.result, event);
          else {
            if (typeof currentCwd === 'string' && path.isAbsolute(currentCwd)) ledger.uncertainRoots.add(path.resolve(currentCwd));
            this._warn('Historical PTC record lacks a normalized result; surviving-session cwd is protected.', report);
          }
        } else {
          const message = data.message ?? (event.type === 'user/message' ? event.data : undefined);
          for (const block of Array.isArray(message?.content) ? message.content : []) if (block?.type === 'text') this._references(block.text, currentCwd, ledger, report);
        }
      }
      await this._save(ledger, report);
      return report;
    });
  }
  candidates(sessionIds) {
    return this._run(async () => {
      const report = this._report();
      await this._init(report);
      if (this._unsafe) return [];
      const deleting = new Set(typeof sessionIds === 'string' ? [sessionIds] : sessionIds ?? []);
      const byPath = new Map();
      for (const [sessionId, ledger] of this._ledgers) {
        for (const record of ledger.records.values()) {
          const recordKey = key(path.resolve(record.path));
          if (!byPath.has(recordKey)) byPath.set(recordKey, []);
          byPath.get(recordKey).push({ sessionId, record });
        }
      }
      const candidates = [];
      const retained = new Map();
      const retain = (reason, file) => {
        const summary = retained.get(reason) ?? { count: 0, examples: [] };
        summary.count += 1;
        if (summary.examples.length < 3) summary.examples.push(file);
        retained.set(reason, summary);
      };
      for (const entries of byPath.values()) {
        if (!entries.some(entry => deleting.has(entry.sessionId))) continue;
        const owners = entries.filter(entry => entry.record.created);
        const file = entries[0].record.path;
        if (!owners.length) { retain('缺少可靠新增证据', file); continue; }
        if (entries.some(entry => !deleting.has(entry.sessionId))) { retain('保留会话共享引用', file); continue; }
        if ([...this._ledgers].some(([sessionId, ledger]) => !deleting.has(sessionId) && [...ledger.uncertainRoots].some(root => within(root, file)))) { retain('保留会话扫描或历史不完整', file); continue; }
        if ([...this._pending.values()].some(pending => typeof pending.cwd === 'string' && within(pending.cwd, file))) { retain('文件所在目录仍有工具执行', file); continue; }
        const mutations = entries.map(entry => entry.record).filter(record => HASH.test(record.fingerprint ?? '') && Number.isFinite(record.at));
        if (!mutations.length) { retain('缺少可靠内容哈希', file); continue; }
        const latestAt = Math.max(...mutations.map(record => record.at));
        const latest = mutations.filter(record => record.at === latestAt);
        if (new Set(latest.map(record => record.fingerprint)).size !== 1) { retain('内容版本证据有冲突', file); continue; }
        const expected = latest[0];
        let valid = true;
        let info;
        for (const { record } of owners) {
          info = await this._inspect(record.path, record.cwd);
          if (!info.exists || !info.safe || !sameIdentity(expected.identity ?? record.creationIdentity, info.identity) || info.fingerprint !== expected.fingerprint || info.bytes !== expected.bytes) { valid = false; break; }
        }
        if (!valid) { retain('文件已修改、缺失或路径/链接受保护', file); continue; }
        candidates.push({ path: file, bytes: info.bytes, fingerprint: info.fingerprint, sessionIds: [...new Set(entries.map(entry => entry.sessionId))].sort() });
      }
      for (const [reason, summary] of retained) this._warn(`保留 ${summary.count} 个文件（${reason}）：${summary.examples.join('；')}${summary.count > summary.examples.length ? '；…' : ''}`, report);
      return candidates.sort((a, b) => a.path.localeCompare(b.path));
    });
  }
}
