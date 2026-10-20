import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { bundledVersion, checkEngineUpdate, commandVersion, engineCommand, formatEngine, resolveEngine } from '../src/engine.js';
import { startTunnel, runCodex } from '../src/tunnel.js';

async function fixture(t, { name = 'codex engine.mjs', version = bundledVersion, executable = false, hang = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcodex-engine-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, name);
  await writeFile(filename, `#!/usr/bin/env node
${executable ? "const { writeFileSync } = require('node:fs');" : "import { writeFileSync } from 'node:fs';"}
if (process.argv.includes('--version')) {
  if (process.env.PROBE_RECORD) writeFileSync(process.env.PROBE_RECORD, JSON.stringify({ hasFacadeKey: Boolean(process.env.MCODEX_LOCAL_KEY), home: process.env.HOME, codeHome: process.env.CODEX_HOME, cwd: process.cwd() }));
  ${hang ? 'setInterval(() => {}, 1000);' : `console.log(${JSON.stringify('codex-cli ' + version)});`}
} else {
  const at = process.argv.indexOf('--record');
  writeFileSync(process.argv[at + 1], JSON.stringify({ args: process.argv.slice(2), home: process.env.HOME, codeHome: process.env.CODEX_HOME, cwd: process.cwd(), localKey: process.env.MCODEX_LOCAL_KEY }));
  process.exit(9);
}
`, { mode: executable ? 0o700 : 0o600 });
  return { directory, filename };
}

test('bundled selection ignores PATH and reports the actual official engine', async t => {
  const { filename } = await fixture(t);
  const engine = await resolveEngine({ env: { PATH: '/nonexistent' }, bundledEntry: () => filename });
  assert.equal(engine.source, 'bundled');
  assert.equal(engine.version, bundledVersion);
  assert.equal(engine.command, process.execPath);
  assert.deepEqual(engine.prefix, [await realpath(filename)]);
  assert.equal(engine.tested, true);
  assert.match(formatEngine(engine).join('\n'), /source: bundled/);
});

test('external JS selection preserves home and cwd during inspection but removes a previous local key', async t => {
  const { directory, filename } = await fixture(t, { version: '9.8.7' });
  const record = path.join(directory, 'probe.json');
  const engine = await resolveEngine({ env: { ...process.env, HOME: '/fixture/home', CODEX_HOME: '/fixture/codex', MCODEX_LOCAL_KEY: 'must-not-reach-inspection', PROBE_RECORD: record, MCODEX_CODEX_BIN: filename } });
  assert.equal(engine.source, 'external');
  assert.equal(engine.tested, false);
  assert.match(formatEngine(engine).join('\n'), /not yet tested/);
  assert.deepEqual(JSON.parse(await readFile(record, 'utf8')), { hasFacadeKey: false, home: '/fixture/home', codeHome: '/fixture/codex', cwd: process.cwd() });
});

test('unsetting the external selector returns to the bundled engine without changing files', async t => {
  const older = await fixture(t, { version: '0.162.1' });
  const bundled = await fixture(t);
  assert.equal((await resolveEngine({ env: { ...process.env, MCODEX_CODEX_BIN: older.filename } })).version, '0.162.1');
  assert.equal((await resolveEngine({ env: {}, bundledEntry: () => bundled.filename })).version, bundledVersion);
});

test('native symlink launchers retain their selected invocation name', async t => {
  const { directory } = await fixture(t);
  const native = path.join(directory, 'multicall-launcher');
  const selected = path.join(directory, 'codex');
  await writeFile(native, '#!/bin/sh\ncase "$0" in */codex) echo "codex-cli 0.163.0" ;; *) echo "wrong-launcher" ;; esac\n', { mode: 0o700 });
  await symlink(native, selected);
  const engine = await resolveEngine({ env: { ...process.env, MCODEX_CODEX_BIN: selected } });
  assert.equal(engine.path, await realpath(native));
  assert.equal(engine.command, selected);
  assert.equal(engine.version, '0.163.0');
  assert.match(formatEngine(engine).join('\n'), /Codex launcher path: .*\/codex/);
});

test('missing, empty, directory, non-executable and recursive selectors fail before a gateway starts', async t => {
  const { directory, filename } = await fixture(t, { name: 'codex-native', executable: false });
  for (const target of ['', '/nonexistent/mcodex-codex', directory, filename]) {
    await assert.rejects(resolveEngine({ env: { MCODEX_CODEX_BIN: target } }), /must name|missing|cannot be executed|directory/);
  }
  const recursion = path.join(directory, 'self');
  await symlink(fileURLToPath(new URL('../bin/mcodex.js', import.meta.url)), recursion);
  await assert.rejects(resolveEngine({ env: { MCODEX_CODEX_BIN: recursion } }), /not mcodex/);
});

test('wrong version output and tampered bundled versions are rejected without echoing process output', async t => {
  const { filename } = await fixture(t, { version: 'fixture-sensitive-output' });
  await assert.rejects(resolveEngine({ env: { ...process.env, MCODEX_CODEX_BIN: filename } }), error => /did not identify/.test(error.message) && !error.message.includes('fixture-sensitive-output'));
  const wrong = await fixture(t, { version: '9.8.7' });
  await assert.rejects(resolveEngine({ env: {}, bundledEntry: () => wrong.filename }), /does not match/);
});

test('bounded version inspection terminates a hung executable on timeout and cancellation', async t => {
  const { filename } = await fixture(t, { hang: true });
  await assert.rejects(resolveEngine({ env: { ...process.env, MCODEX_CODEX_BIN: filename }, timeoutMs: 50 }), /timed out/);
  const controller = new AbortController();
  const pending = commandVersion(process.execPath, [filename, '--version'], { signal: controller.signal });
  controller.abort(new Error('fixture cancelled'));
  await assert.rejects(pending, /fixture cancelled/);
});

test('cancelling version inspection also stops a launcher native child', async t => {
  const { directory, filename } = await fixture(t);
  const pidFile = path.join(directory, 'native-child.pid');
  await writeFile(filename, `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  const pending = commandVersion(process.execPath, [filename, '--version'], { signal: controller.signal });
  let pid;
  for (let i = 0; i < 100; i++) {
    try { pid = Number(await readFile(pidFile, 'utf8')); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.ok(pid > 0);
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  controller.abort(new Error('fixture child cancellation'));
  await assert.rejects(pending, /fixture child cancellation/);
  let stopped = false;
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') { stopped = true; break; } throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(stopped, true, 'inspection must not leave a native child running');
});

for (const kind of ['js', 'native']) {
  test(`${kind} external engine preserves literal args, cwd and config; only the temporary facade key reaches Codex`, async t => {
    const fixtureEngine = await fixture(t, { name: kind === 'js' ? 'codex launcher.mjs' : 'codex-native', executable: kind === 'native' });
    // A Node shebang fixture exercises direct executable spawning without a shell.
    if (kind === 'native') await chmod(fixtureEngine.filename, 0o700);
    const engine = await resolveEngine({ env: { ...process.env, MCODEX_CODEX_BIN: fixtureEngine.filename } });
    assert.equal(engine.prefix.length, kind === 'js' ? 1 : 0);
    assert.deepEqual(engineCommand(fixtureEngine.filename), { command: kind === 'js' ? process.execPath : fixtureEngine.filename, prefix: kind === 'js' ? [fixtureEngine.filename] : [] });
    const tokenFile = path.join(fixtureEngine.directory, 'connection.key');
    const connectionToken = 'engine-fixture-server-token-1234567890';
    await writeFile(tokenFile, connectionToken + '\n', { mode: 0o600 });
    const binary = fileURLToPath(new URL('./fixtures/transport.mjs', import.meta.url));
    await chmod(binary, 0o700);
    const tunnel = await startTunnel({ server: 'wss://fixture.invalid/tunnel', tokenFile }, { binary, timeoutMs: 3000 });
    t.after(() => tunnel.close());
    const record = path.join(fixtureEngine.directory, 'handoff.json');
    const args = ['exec', '--record', record, '--json', 'literal `command` $(substitution) $HOME spaces'];
    assert.equal(await runCodex(tunnel, args, { model: 'test-model', engine }), 9);
    const handoff = JSON.parse(await readFile(record, 'utf8'));
    assert.deepEqual(handoff.args.slice(-args.length), args);
    assert.equal(handoff.home, process.env.HOME);
    assert.equal(handoff.codeHome, process.env.CODEX_HOME);
    assert.equal(handoff.cwd, process.cwd());
    assert.equal(handoff.localKey, tunnel.key);
    assert.equal(JSON.stringify(handoff).includes(connectionToken), false);
    assert.equal(handoff.args.some(value => value.includes('check_for_update_on_startup')), false, 'an explicit external engine retains its own update policy');
  });
}

test('the bundled engine receives the centrally managed updater policy without changing its user config', async t => {
  const { directory, filename } = await fixture(t);
  const engine = await resolveEngine({ env: {}, bundledEntry: () => filename });
  const tokenFile = path.join(directory, 'connection.key');
  await writeFile(tokenFile, 'engine-fixture-server-token-1234567890\n', { mode: 0o600 });
  const binary = fileURLToPath(new URL('./fixtures/transport.mjs', import.meta.url));
  await chmod(binary, 0o700);
  const tunnel = await startTunnel({ server: 'wss://fixture.invalid/tunnel', tokenFile }, { binary, timeoutMs: 3000 });
  t.after(() => tunnel.close());
  const record = path.join(directory, 'bundled-handoff.json');
  assert.equal(await runCodex(tunnel, ['exec', '--record', record, 'fixture'], { model: 'test-model', engine }), 9);
  const handoff = JSON.parse(await readFile(record, 'utf8'));
  assert.ok(handoff.args.includes('check_for_update_on_startup=false'));
  assert.equal(handoff.home, process.env.HOME);
  assert.equal(handoff.codeHome, process.env.CODEX_HOME);
  assert.equal(handoff.cwd, process.cwd());
});

test('official version check is read-only, bounded and never supplies authentication headers', async () => {
  let calls = 0;
  const latest = await checkEngineUpdate({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://registry.npmjs.org/@openai%2fcodex/latest');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    return new Response(JSON.stringify({ name: '@openai/codex', version: '9.8.7' }));
  } });
  assert.deepEqual(latest, { version: '9.8.7', tested: false });
  assert.equal(calls, 1);
  await assert.rejects(checkEngineUpdate({ fetchImpl: async () => new Response('{invalid') }), /invalid metadata/);
  await assert.rejects(checkEngineUpdate({ fetchImpl: async () => new Response(JSON.stringify({ name: 'other', version: '1.2.3' })) }), /invalid metadata/);
  await assert.rejects(checkEngineUpdate({ fetchImpl: async () => new Response('x'.repeat(131073)) }), /exceeded its limit/);
});
