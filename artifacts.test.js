import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ArtifactTracker } from './artifacts.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const ok = (value = {}, meta) => ({ isError: false, value, content: [], ...(meta ? { meta } : {}) });
const error = text => ({ isError: true, error: { message: text, info: { code: 'FS_NOT_FOUND', name: 'FsError' } }, content: [{ type: 'text', text }] });
let nextId = 0;
const execution = (session, name, args) => ({ name, arguments: args, callId: `call-${++nextId}`, agent: { id: session } });
async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'session-cleaner-artifacts-test-'));
  const cwd = path.join(base, 'work');
  const stateDir = path.join(base, 'state');
  await fs.mkdir(cwd);
  t.after(async () => {
    const resolved = path.resolve(base);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^session-cleaner-artifacts-test-/);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return { base, cwd, stateDir, tracker: new ArtifactTracker({ stateDir, ...options }) };
}
async function write(tracker, cwd, session, file, content, result = ok()) {
  const exec = execution(session, 'write', { file_path: file, content });
  await tracker.before(exec, cwd);
  await fs.mkdir(path.dirname(path.resolve(cwd, file)), { recursive: true });
  await fs.writeFile(path.resolve(cwd, file), content);
  await tracker.after(exec, result, cwd);
  return exec;
}
function pair(name, args, result, time = nextId + 100) {
  const callId = `history-${++nextId}`;
  return [
    { type: 'tool/call', time: time - 1, data: { callId, name, arguments: JSON.stringify(args) } },
    { type: 'tool/result', time, data: { message: { toolCallId: callId, role: 'tool', isError: result.isError, content: result.content ?? [], value: result.value }, meta: result.meta, ...(result.isError ? { error: result.error?.info ?? { code: 'FAILED' } } : {}) } },
  ];
}

test('new write is eligible; pre-existing write and failed write remain protected', async t => {
  const { cwd, tracker } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'existing.txt'), 'user data');
  await write(tracker, cwd, 'A', 'existing.txt', 'updated');
  await write(tracker, cwd, 'A', 'new.txt', 'new file 中文');
  await write(tracker, cwd, 'A', 'failed.txt', 'partial', error('write failed'));
  assert.deepEqual(await tracker.candidates(['A']), [{ path: path.join(cwd, 'new.txt'), bytes: Buffer.byteLength('new file 中文'), fingerprint: hash('new file 中文'), sessionIds: ['A'] }]);
});

test('per-session JSON survives a tracker restart and session IDs are hashed', async t => {
  const { cwd, tracker, stateDir } = await fixture(t);
  await write(tracker, cwd, '../odd/session', 'file.bin', 'abc');
  const names = await fs.readdir(stateDir);
  assert.deepEqual(names, [`${hash('../odd/session')}.json`]);
  const restored = new ArtifactTracker({ stateDir });
  assert.equal((await restored.candidates(['../odd/session'])).length, 1);
});

test('present and read in another session protect a generated file until both sessions are selected', async t => {
  const { cwd, tracker } = await fixture(t);
  await write(tracker, cwd, 'A', 'shared.txt', 'abc');
  const read = execution('B', 'functions.read', { file_path: 'shared.txt' });
  await tracker.before(read, cwd);
  await tracker.after(read, ok(), cwd);
  const present = execution('C', 'present', { files: [{ path: 'shared.txt' }] });
  await tracker.before(present, cwd);
  await tracker.after(present, ok(), cwd);
  assert.deepEqual(await tracker.candidates(['A']), []);
  assert.deepEqual(await tracker.candidates(['A', 'B']), []);
  assert.deepEqual((await tracker.candidates(['A', 'B', 'C']))[0].sessionIds, ['A', 'B', 'C']);
});

test('a tracked update by another selected session updates the expected hash', async t => {
  const { cwd, tracker } = await fixture(t);
  await write(tracker, cwd, 'A', 'shared.txt', 'first');
  await write(tracker, cwd, 'B', 'shared.txt', 'second');
  assert.deepEqual(await tracker.candidates(['A']), []);
  assert.equal((await tracker.candidates(['A', 'B']))[0].fingerprint, hash('second'));
});

test('external edits, removal and same-content replacement are protected', async t => {
  const { cwd, tracker } = await fixture(t);
  await write(tracker, cwd, 'A', 'edited.txt', 'original');
  await write(tracker, cwd, 'A', 'removed.txt', 'original');
  await write(tracker, cwd, 'A', 'replaced.txt', 'original');
  await fs.writeFile(path.join(cwd, 'edited.txt'), 'user edit');
  await fs.unlink(path.join(cwd, 'removed.txt'));
  await fs.rename(path.join(cwd, 'replaced.txt'), path.join(cwd, 'old.txt'));
  await fs.writeFile(path.join(cwd, 'replaced.txt'), 'original');
  assert.deepEqual(await tracker.candidates(['A']), []);
});

test('paths outside cwd and protected roots are never candidates', async t => {
  const { cwd, base, stateDir } = await fixture(t);
  const protectedRoot = path.join(cwd, 'keep');
  const tracker = new ArtifactTracker({ stateDir, protectedRoots: [protectedRoot] });
  for (const file of ['../outside.txt', 'keep/file.txt', '.git/config', 'node_modules/pkg/a.js']) await write(tracker, cwd, 'A', file, 'x');
  assert.deepEqual(await tracker.candidates(['A']), []);
  assert.equal(await fs.readFile(path.join(base, 'outside.txt'), 'utf8'), 'x');
});

test('symlink and junction ancestors are protected, including replacement after tracking', async t => {
  const { cwd, base, tracker } = await fixture(t);
  const target = path.join(base, 'target');
  await fs.mkdir(target);
  const link = path.join(cwd, 'link');
  try { await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (e.code === 'EPERM') { t.skip('platform does not permit directory links'); return; } throw e; }
  await write(tracker, cwd, 'A', 'link/secret.txt', 'x');
  await write(tracker, cwd, 'A', 'normal/file.txt', 'y');
  await fs.rename(path.join(cwd, 'normal'), path.join(base, 'moved'));
  await fs.symlink(path.join(base, 'moved'), path.join(cwd, 'normal'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.deepEqual(await tracker.candidates(['A']), []);
});

test('hard-linked files are protected both before and after ownership is tracked', async t => {
  const { cwd, base, tracker } = await fixture(t);
  await write(tracker, cwd, 'A', 'owned.txt', 'x');
  await fs.link(path.join(cwd, 'owned.txt'), path.join(base, 'alias.txt'));
  await fs.writeFile(path.join(base, 'user.txt'), 'y');
  await fs.link(path.join(base, 'user.txt'), path.join(cwd, 'existing.txt'));
  await write(tracker, cwd, 'A', 'existing.txt', 'z');
  assert.deepEqual(await tracker.candidates(['A']), []);
});

test('shell scans identify new files and only touch existing changed files', async t => {
  const { cwd, tracker } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'existing.txt'), 'old');
  const exec = execution('A', 'pwsh', { command: 'fixture' });
  await tracker.before(exec, cwd);
  await fs.writeFile(path.join(cwd, 'existing.txt'), 'updated');
  await fs.mkdir(path.join(cwd, 'nested'));
  await fs.writeFile(path.join(cwd, 'nested', 'new.txt'), 'new');
  const report = await tracker.after(exec, ok({ exitCode: 0 }), cwd);
  assert.equal(report.truncated, false);
  assert.deepEqual((await tracker.candidates(['A'])).map(item => item.path), [path.join(cwd, 'nested', 'new.txt')]);
});

test('shell workdir overrides session cwd and excluded dependency trees are not scanned', async t => {
  const { cwd, tracker } = await fixture(t);
  const actual = path.join(cwd, 'sub');
  await fs.mkdir(actual);
  const exec = execution('A', 'bash', { workdir: 'sub', command: 'fixture' });
  await tracker.before(exec, cwd);
  await fs.mkdir(path.join(actual, 'node_modules'));
  await fs.writeFile(path.join(actual, 'node_modules', 'ignored.txt'), 'x');
  await fs.writeFile(path.join(actual, 'new.txt'), 'y');
  await fs.writeFile(path.join(cwd, 'outside-scan.txt'), 'z');
  await tracker.after(exec, ok({ exitCode: 0 }), cwd);
  assert.deepEqual((await tracker.candidates(['A'])).map(item => item.path), [path.join(actual, 'new.txt')]);
});

test('scan caps are explicit and a partial baseline claims no new files', async t => {
  const { cwd, tracker } = await fixture(t, { maxFiles: 2 });
  await Promise.all(['a', 'b', 'c'].map(name => fs.writeFile(path.join(cwd, name), name)));
  const exec = execution('A', 'bash', { command: 'fixture' });
  const before = await tracker.before(exec, cwd);
  await fs.writeFile(path.join(cwd, 'new'), 'x');
  await tracker.after(exec, ok({ exitCode: 0 }), cwd);
  assert.equal(before.truncated, true);
  assert.match(before.warnings.join('\n'), /limit 2/);
  assert.deepEqual(await tracker.candidates(['A']), []);
});

test('overlapping shell calls do not claim ambiguous creations', async t => {
  const { cwd, tracker } = await fixture(t);
  const a = execution('A', 'bash', { command: 'fixture' });
  const b = execution('B', 'pwsh', { command: 'fixture' });
  await tracker.before(a, cwd);
  await tracker.before(b, cwd);
  await fs.writeFile(path.join(cwd, 'new'), 'x');
  await tracker.after(a, ok({ exitCode: 0 }), cwd);
  await tracker.after(b, ok({ exitCode: 0 }), cwd);
  assert.deepEqual(await tracker.candidates(['A', 'B']), []);
  assert.match(tracker.warnings.join('\n'), /Overlapping/);
});

test('failed and background shells do not establish ownership', async t => {
  const { cwd, tracker } = await fixture(t);
  for (const [file, result] of [['failed', ok({ exitCode: 1 })], ['background', ok({ jobId: '123' })]]) {
    const exec = execution('A', 'bash', { command: 'fixture' });
    await tracker.before(exec, cwd);
    await fs.writeFile(path.join(cwd, file), 'x');
    await tracker.after(exec, result, cwd);
  }
  assert.deepEqual(await tracker.candidates(['A']), []);
});

test('history accepts structured creation evidence and the verified current write envelope', async t => {
  const { cwd, tracker } = await fixture(t);
  const events = [];
  for (const [file, result] of [
    ['operation', ok({}, { operation: 'create', path: path.join(cwd, 'operation') })],
    ['created', ok({ created: true })],
    ['newFile', ok({ newFile: true })],
    ['envelope', { isError: false, content: [{ type: 'text', text: `<path>${path.join(cwd, 'envelope')}</path>\n<type>file</type>\n<content>\nCreated file\n</content>` }] }],
  ]) {
    await fs.writeFile(path.join(cwd, file), file);
    events.push(...pair('write', { file_path: file, content: file }, result));
  }
  await tracker.history('A', events, cwd);
  assert.equal((await tracker.candidates(['A'])).length, 4);
});

test('history needs a successful write: present, loose text, update and failed create never establish ownership', async t => {
  const { cwd, tracker } = await fixture(t);
  const events = [];
  for (const file of ['present', 'text', 'update', 'failed']) await fs.writeFile(path.join(cwd, file), file);
  events.push(...pair('present', { files: [{ path: 'present' }] }, ok()));
  events.push(...pair('write', { file_path: 'text', content: 'text' }, { isError: false, content: [{ type: 'text', text: `Created file ${path.join(cwd, 'text')}` }] }));
  events.push(...pair('write', { file_path: 'update', content: 'update' }, ok({}, { operation: 'update' })));
  events.push(...pair('write', { file_path: 'failed', content: 'failed' }, { ...error('failed'), meta: { created: true } }));
  await tracker.history('A', events, cwd);
  assert.deepEqual(await tracker.candidates(['A']), []);
});

test('historical absent read followed by successful write proves creation; offset errors do not', async t => {
  const { cwd, tracker } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'new'), 'new');
  await fs.writeFile(path.join(cwd, 'existing'), 'existing');
  await tracker.history('A', [
    ...pair('read', { file_path: 'new' }, error(`cannot read "${path.join(cwd, 'new')}": not found`)),
    ...pair('write', { file_path: 'new', content: 'new' }, ok()),
    ...pair('read', { file_path: 'existing', offset: 999 }, error('offset 999 is out of range')),
    ...pair('write', { file_path: 'existing', content: 'existing' }, ok()),
  ], cwd);
  assert.deepEqual((await tracker.candidates(['A'])).map(item => item.path), [path.join(cwd, 'new')]);
});

test('history compares expected written content instead of trusting current content', async t => {
  const { cwd, tracker } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'file'), 'external edit');
  await tracker.history('A', pair('write', { file_path: 'file', content: 'original' }, ok({}, { operation: 'create' })), cwd);
  assert.deepEqual(await tracker.candidates(['A']), []);
});

test('history reconstructs subsequent edits and is idempotent', async t => {
  const { cwd, tracker } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'file'), 'hello world');
  const events = [
    ...pair('write', { file_path: 'file', content: 'hello user' }, ok({}, { operation: 'create' }), 100),
    ...pair('edit', { file_path: 'file', old_string: 'user', new_string: 'world' }, ok(), 200),
  ];
  await tracker.history('A', events, cwd);
  await tracker.history('A', events, cwd);
  const candidates = await tracker.candidates(['A']);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].fingerprint, hash('hello world'));
});

test('historical references protect shared files but never create ownership', async t => {
  const { cwd, tracker } = await fixture(t);
  await write(tracker, cwd, 'A', 'shared', 'data');
  await tracker.history('B', [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `[file](<${path.join(cwd, 'shared')}>)` }] } } }], cwd);
  assert.deepEqual(await tracker.candidates(['A']), []);
  assert.equal((await tracker.candidates(['A', 'B'])).length, 1);
});

test('historical shells in surviving sessions protect their cwd', async t => {
  const { cwd, tracker } = await fixture(t);
  await write(tracker, cwd, 'A', 'file', 'data');
  await tracker.history('B', pair('bash', { command: 'unknown old command' }, ok()), cwd);
  assert.deepEqual(await tracker.candidates(['A']), []);
  assert.equal((await tracker.candidates(['A', 'B'])).length, 1);
});

test('corrupt ledgers disable candidates and expose diagnostics', async t => {
  const { cwd, tracker, stateDir } = await fixture(t);
  await write(tracker, cwd, 'A', 'file', 'data');
  await fs.writeFile(path.join(stateDir, `${hash('B')}.json`), '{bad');
  const restored = new ArtifactTracker({ stateDir });
  assert.deepEqual(await restored.candidates(['A']), []);
  assert.match(restored.warnings.join('\n'), /fail-closed/);
});

test('unrelated tools including session_cleanup do no filesystem work', async t => {
  const { tracker, stateDir, cwd } = await fixture(t);
  const exec = execution('A', 'session_cleanup', { action: 'list' });
  assert.deepEqual(await tracker.before(exec, cwd), { warnings: [], scanned: 0, truncated: false });
  await tracker.after(exec, ok(), cwd);
  await assert.rejects(fs.stat(stateDir), { code: 'ENOENT' });
});

test('atomic tracked overwrites preserve deletion eligibility with the new identity', async t => {
  const { cwd, tracker } = await fixture(t);
  await write(tracker, cwd, 'A', 'file', 'first');
  const exec = execution('B', 'write', { file_path: 'file', content: 'second' });
  await tracker.before(exec, cwd);
  await fs.writeFile(path.join(cwd, 'tmp'), 'second');
  await fs.rename(path.join(cwd, 'tmp'), path.join(cwd, 'file'));
  await tracker.after(exec, ok({}, { operation: 'update' }), cwd);
  assert.equal((await tracker.candidates(['A', 'B'])).length, 1);
});

test('shell reads protect files already present in their baseline', async t => {
  const { cwd, tracker } = await fixture(t);
  await write(tracker, cwd, 'A', 'file', 'data');
  const exec = execution('B', 'bash', { command: 'read fixture' });
  await tracker.before(exec, cwd);
  await tracker.after(exec, ok({ exitCode: 0 }), cwd);
  assert.deepEqual(await tracker.candidates(['A']), []);
  assert.equal((await tracker.candidates(['A', 'B'])).length, 1);
  assert.match(tracker.warnings.join('\n'), /共享引用/);
});

test('tracked shell boundaries survive historical replay without protecting unrelated future files', async t => {
  const { cwd, stateDir, tracker } = await fixture(t);
  const exec = execution('B', 'bash', { command: 'fixture' });
  await tracker.before(exec, cwd);
  await tracker.after(exec, ok({ exitCode: 0 }), cwd);
  await write(tracker, cwd, 'A', 'future', 'data');
  const restored = new ArtifactTracker({ stateDir });
  const history = pair('bash', exec.arguments, ok({ exitCode: 0 }));
  history[0].data.callId = exec.callId;
  history[1].data.message.toolCallId = exec.callId;
  await restored.history('B', history, cwd);
  assert.equal((await restored.candidates(['A'])).length, 1);
});

test('historical update evidence overrides a stale absent observation', async t => {
  const { cwd, tracker } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'file'), 'data');
  await tracker.history('A', [
    ...pair('read', { file_path: 'file' }, error(`cannot read "${path.join(cwd, 'file')}": not found`)),
    ...pair('write', { file_path: 'file', content: 'data' }, ok({}, { operation: 'update' })),
  ], cwd);
  assert.deepEqual(await tracker.candidates(['A']), []);
});

test('historical shell execution invalidates old negative observations', async t => {
  const { cwd, tracker } = await fixture(t);
  await fs.writeFile(path.join(cwd, 'file'), 'data');
  await tracker.history('A', [
    ...pair('read', { file_path: 'file' }, error(`cannot read "${path.join(cwd, 'file')}": not found`)),
    ...pair('bash', { command: 'unknown' }, ok()),
    ...pair('write', { file_path: 'file', content: 'data' }, ok()),
  ], cwd);
  assert.deepEqual(await tracker.candidates(['A']), []);
});

test('historical cwd changes resolve later relative file paths', async t => {
  const { cwd, tracker } = await fixture(t);
  await fs.mkdir(path.join(cwd, 'sub'));
  await fs.writeFile(path.join(cwd, 'sub', 'file'), 'data');
  await tracker.history('A', [
    ...pair('working_directory', { cd: 'sub' }, ok()),
    ...pair('write', { file_path: 'file', content: 'data' }, ok({}, { created: true })),
  ], cwd);
  assert.deepEqual((await tracker.candidates(['A'])).map(item => item.path), [path.join(cwd, 'sub', 'file')]);
});

test('runtime executable protection does not protect sibling user workspaces', async t => {
  const { tracker } = await fixture(t);
  assert.equal(tracker.protectedRoots.includes(process.execPath), true);
  assert.equal(tracker.protectedRoots.includes(path.dirname(process.execPath)), false);
  const desktop = path.win32.resolve('D:\\A-DSH\\dsh.exe');
  const workspace = path.win32.resolve('D:\\A-DSH\\A-WORK');
  assert.equal(path.win32.relative(desktop, workspace).startsWith('..'), true);
});

test('ledger overflow in a surviving session protects unrecorded references', async t => {
  const { cwd, stateDir } = await fixture(t);
  const tracker = new ArtifactTracker({ stateDir, maxFiles: 1 });
  await write(tracker, cwd, 'A', 'owned', 'data');
  const exec = execution('B', 'present', { files: [{ path: 'other' }, { path: 'owned' }] });
  await tracker.before(exec, cwd);
  const report = await tracker.after(exec, ok(), cwd);
  assert.equal(report.truncated, true);
  assert.deepEqual(await tracker.candidates(['A']), []);
});

test('truncated text history protects paths beyond the inspection budget', async t => {
  const { cwd, tracker } = await fixture(t);
  await write(tracker, cwd, 'A', 'owned', 'data');
  const text = `${'x'.repeat(200001)} [file](<${path.join(cwd, 'owned')}>)`;
  const report = await tracker.history('B', [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }], cwd);
  assert.equal(report.truncated, true);
  assert.deepEqual(await tracker.candidates(['A']), []);
});

test('shell result without a before snapshot protects its cwd', async t => {
  const { cwd, tracker } = await fixture(t);
  await write(tracker, cwd, 'A', 'owned', 'data');
  await tracker.after(execution('B', 'bash', { command: 'fixture' }), ok(), cwd);
  assert.deepEqual(await tracker.candidates(['A']), []);
});
