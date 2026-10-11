import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startTunnel, runCodex, nativePackage } from '../src/tunnel.js';
import { providerArguments, chooseModel } from '../src/provider.js';

const binary = fileURLToPath(new URL('fixtures/transport.mjs', import.meta.url));
const codexEntry = fileURLToPath(new URL('fixtures/codex.mjs', import.meta.url));
await chmod(binary, 0o755);

async function fixture(t, server = 'wss://test.invalid/tunnel') {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcodex-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'server.key');
  await writeFile(tokenFile, 'test-server-connection-token-1234567890\n', { mode: 0o600 });
  return { directory, state: { server, tokenFile } };
}

test('dynamic loopback transport authenticates and cleans up its private local key', async t => {
  const { state } = await fixture(t);
  const tunnel = await startTunnel(state, { binary, timeoutMs: 3000 });
  t.after(() => tunnel.close());
  assert.match(tunnel.origin, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/);
  assert.equal((await stat(tunnel.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(tunnel.directory, 'local.key'))).mode & 0o777, 0o600);
  assert.deepEqual(tunnel.models, [{ id: 'test-model' }]);
  const response = await fetch(`${tunnel.origin}/v1/models`);
  assert.equal(response.status, 401);
  await tunnel.close();
  await assert.rejects(stat(tunnel.directory), { code: 'ENOENT' });
  assert.ok(tunnel.child.exitCode !== null || tunnel.child.signalCode !== null);
});

test('Codex gets a temporary local key and exit status; provider overrides do not contain the server token', async t => {
  const { state, directory } = await fixture(t);
  const tunnel = await startTunnel(state, { binary, timeoutMs: 3000 });
  t.after(() => tunnel.close());
  const record = path.join(directory, 'record.json');
  const status = await runCodex(tunnel, ['exec', '--record', record, 'a prompt with $ and ` literals'], { model: 'test-model', codexEntry });
  assert.equal(status, 7);
  const data = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(data.localKey, tunnel.key);
  assert.equal(data.codeHome, process.env.CODEX_HOME);
  assert.ok(data.args.includes('a prompt with $ and ` literals'));
  assert.ok(data.args.includes('model_provider="mcodex"'));
  assert.equal(JSON.stringify(data.args).includes(tunnel.key), false);
  assert.equal(JSON.stringify(data).includes((await readFile(state.tokenFile, 'utf8')).trim()), false);
});

test('invalid server credentials and early native failure are surfaced without leaked logs', async t => {
  const denied = await fixture(t, 'wss://denied.invalid/tunnel');
  await assert.rejects(startTunnel(denied.state, { binary, timeoutMs: 3000 }), /authentication failed/);
  const exited = await fixture(t, 'wss://exit.invalid/tunnel');
  await assert.rejects(startTunnel(exited.state, { binary, timeoutMs: 3000 }), /Native transport exited \(17\)/);
  await assert.rejects(startTunnel(exited.state, { binary: '/nonexistent/mcodex-native', timeoutMs: 1000 }), /Unable to start/);
});

test('aborted setup terminates native transport', async t => {
  const { state } = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('test cancellation'));
  await assert.rejects(startTunnel(state, { binary, signal: controller.signal }), /test cancellation/);
});

test('cancellation escalates when Codex ignores termination, then allows tunnel cleanup', async t => {
  const { state, directory } = await fixture(t);
  const tunnel = await startTunnel(state, { binary, timeoutMs: 3000 });
  t.after(() => tunnel.close());
  const controller = new AbortController();
  const record = path.join(directory, 'cancel-record.json');
  const running = runCodex(tunnel, ['--record', record, '--hang'], { model: 'test-model', codexEntry, signal: controller.signal });
  for (let i = 0; i < 100; i++) {
    try { await stat(record); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  const start = Date.now();
  controller.abort(Object.assign(new Error('cancel'), { signal: 'SIGTERM' }));
  assert.equal(await running, 143);
  assert.ok(Date.now() - start < 4000);
  await tunnel.close();
  await assert.rejects(stat(tunnel.directory), { code: 'ENOENT' });
});

test('provider uses Responses with no automatic replay; model must exist in the catalog', () => {
  const args = providerArguments({ origin: 'http://127.0.0.1:4321', model: 'test-model' });
  assert.ok(args.includes('model_providers.mcodex.request_max_retries=0'));
  assert.ok(args.includes('model_providers.mcodex.stream_max_retries=0'));
  assert.ok(args.includes('model_providers.mcodex.supports_websockets=false'));
  assert.equal(chooseModel([{ id: 'test-model' }]), 'test-model');
  assert.throws(() => chooseModel([{ id: 'test-model' }], 'wrong'), /unavailable/);
  assert.throws(() => chooseModel([]), /no available models/);
  assert.equal(nativePackage('linux', 'arm64'), '@m9rco/mcodex-linux-arm64');
  assert.throws(() => nativePackage('win32', 'x64'), /Unsupported platform/);
});
