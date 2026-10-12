import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { saveState } from '../src/state.js';

const source = fileURLToPath(new URL('..', import.meta.url));
const server = 'wss://test.invalid/tunnel';
const token = 'cli-flow-dummy-connection-token-1234567890';
const codexOutput = '{"type":"fixture_codex_started"}\n';

async function events(context) {
  try {
    return (await readFile(context.events, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitFor(description, inspect) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const result = await inspect();
    if (result) return result;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function fixture(t, { configured = false, transport = 'normal', codexHolds = false } = {}) {
  const directory = await mkdtemp('/tmp/mcodex-cli-flow-');
  const context = { directory, events: path.join(directory, 'events.jsonl') };
  t.after(async () => {
    // A failing assertion must not leave a fixture executable or key directory.
    for (const event of await events(context)) {
      if (!['transport-start', 'codex-start'].includes(event.type)) continue;
      if (isRunning(event.pid)) process.kill(event.pid, 'SIGKILL');
      if (event.runtimeDirectory) await rm(event.runtimeDirectory, { recursive: true, force: true });
      if (event.candidateDirectory && path.basename(event.candidateDirectory).startsWith('mcodex-login-')) await rm(event.candidateDirectory, { recursive: true, force: true });
    }
    await rm(directory, { recursive: true, force: true });
  });
  const application = path.join(directory, 'application');
  await mkdir(application);
  for (const name of ['src', 'bin']) await cp(path.join(source, name), path.join(application, name), { recursive: true });
  await copyFile(path.join(source, 'package.json'), path.join(application, 'package.json'));

  // Exercise the real CLI, resolver, tunnel and process supervision. Only the
  // external transport executable and the official CLI package are fixtures.
  const nativeName = `@m9rco/mcodex-${process.platform}-${process.arch}`;
  const native = path.join(application, 'node_modules', '@m9rco', `mcodex-${process.platform}-${process.arch}`);
  await mkdir(path.join(native, 'bin'), { recursive: true });
  await writeFile(path.join(native, 'package.json'), JSON.stringify({ name: nativeName, exports: { './package.json': './package.json' } }));
  const binary = path.join(native, 'bin', 'mlab-gateway');
  await writeFile(binary, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const record = value => appendFileSync(${JSON.stringify(context.events)}, JSON.stringify(value) + '\\n', { mode: 0o600 });
const configFile = process.argv[process.argv.indexOf('--config') + 1];
const config = Object.fromEntries(readFileSync(configFile, 'utf8').trim().split('\\n').map(line => {
  const at = line.indexOf(' = ');
  return [line.slice(0, at), JSON.parse(line.slice(at + 3))];
}));
const key = readFileSync(config.api_key_file, 'utf8').trim();
record({ type: 'transport-start', pid: process.pid, runtimeDirectory: path.dirname(configFile), candidateDirectory: path.dirname(config.server_key_file) });
const server = http.createServer((request, response) => {
  const authenticated = request.headers.authorization === 'Bearer ' + key;
  record({ type: 'catalog-request', authenticated });
  if (${JSON.stringify(transport)} === 'blocked') return;
  response.writeHead(authenticated && ${JSON.stringify(transport)} !== 'unauthorized' ? 200 : 401, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  record({ type: 'transport-ready', origin: 'http://127.0.0.1:' + port });
  process.stdout.write('INFO client listening over an authenticated persistent tunnel; ');
  setTimeout(() => process.stdout.write('listen=127.0.0.1:' + port + '\\n'), 20);
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  record({ type: 'transport-stop', signal });
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
`);
  await chmod(binary, 0o755);

  const config = path.join(directory, 'config');
  const record = path.join(directory, 'handoff.json');
  const env = { ...process.env, MCODEX_CONFIG_DIR: config };
  const codex = path.join(application, 'node_modules', '@openai', 'codex');
  await mkdir(path.join(codex, 'bin'), { recursive: true });
  await writeFile(path.join(codex, 'package.json'), JSON.stringify({ name: '@openai/codex', type: 'module' }));
  await writeFile(path.join(codex, 'bin', 'codex.js'), `
import { appendFileSync, writeFileSync } from 'node:fs';
const baseKeys = new Set(${JSON.stringify(Object.keys(env))});
const token = ${JSON.stringify(token)};
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  pid: process.pid,
  args: process.argv.slice(2),
  addedEnvironmentKeys: Object.keys(process.env).filter(key => !baseKeys.has(key)).sort(),
  connectionTokenInEnvironment: Object.values(process.env).some(value => value.includes(token)),
  hasLocalKey: Boolean(process.env.MCODEX_LOCAL_KEY),
  localKeyIsConnectionToken: process.env.MCODEX_LOCAL_KEY === token,
}));
const event = value => appendFileSync(${JSON.stringify(context.events)}, JSON.stringify(value) + '\\n', { mode: 0o600 });
event({ type: 'codex-start', pid: process.pid });
if (${JSON.stringify(codexHolds)}) {
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    event({ type: 'codex-stop', signal });
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
  setInterval(() => {}, 1000);
}
process.stdout.write(${JSON.stringify(codexOutput)}, () => {
  event({ type: 'codex-ready', pid: process.pid });
  if (!${JSON.stringify(codexHolds)}) process.exit(17);
});
`);
  const preloads = {};
  for (const [kind, streams] of Object.entries({ terminal: ['stdin', 'stdout', 'stderr'], inputOnly: ['stdin'], outputOnly: ['stdout', 'stderr'] })) {
    const filename = path.join(directory, `tty-${kind}.mjs`);
    await writeFile(filename, `
for (const name of ${JSON.stringify(streams)}) {
  Object.defineProperty(process[name], 'isTTY', { value: true, configurable: true });
}
process.stdin.setRawMode = value => { process.stdin.isRaw = value; return process.stdin; };
`);
    preloads[kind] = filename;
  }
  const tokenFile = path.join(directory, 'input-token');
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  if (configured) await saveState(config, { server, token, model: 'test-model' });
  return Object.assign(context, { application, config, record, env, preloads, tokenFile });
}

async function run(t, context, args, { terminal = false, setup = false, interruptAt, signal = 'SIGTERM' } = {}) {
  const preload = terminal === true ? context.preloads.terminal : context.preloads[terminal];
  const argv = [...(preload ? ['--import', preload] : []), path.join(context.application, 'bin', 'mcodex.js'), ...args];
  const child = spawn(process.execPath, argv, { env: context.env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let stdout = '';
  let stderr = '';
  let serverSent = false;
  let tokenSent = false;
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
    if (setup && !serverSent && stderr.includes('Gateway WSS URL:')) {
      serverSent = true;
      child.stdin.write(`${server}\n`);
    }
    if (setup && !tokenSent && stderr.includes('Connection Token (hidden):')) {
      tokenSent = true;
      child.stdin.end(`${token}\n`);
    }
  });
  if (!setup) child.stdin.end();
  const completion = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('CLI flow did not complete within six seconds.'));
    }, 6000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, exitSignal) => { clearTimeout(timeout); resolve({ code, exitSignal }); });
  });
  let action;
  if (interruptAt) action = (async () => {
    const list = await waitFor(`fixture ${interruptAt}`, async () => {
      const list = await events(context);
      const ready = list.some(event => event.type === (interruptAt === 'catalog' ? 'catalog-request' : 'codex-ready'));
      return ready ? list : undefined;
    });
    const transport = list.find(event => event.type === 'transport-start');
    if (interruptAt === 'catalog') {
      assert.notEqual(transport.candidateDirectory, context.config);
      await access(transport.candidateDirectory);
    }
    if (interruptAt === 'transport') process.kill(transport.pid, 'SIGTERM');
    else child.kill(signal);
  })().catch(error => { child.kill('SIGTERM'); throw error; });
  const [{ code, exitSignal }] = await Promise.all([completion, action]);
  assert.equal(stdout.includes(token) || stderr.includes(token), false, 'connection Token must not appear in terminal output');
  return { code, exitSignal, stdout, stderr, serverSent, tokenSent };
}

async function assertClean(context, { starts = 1, catalogRequests = 1 } = {}) {
  const list = await events(context);
  const transports = list.filter(event => event.type === 'transport-start');
  assert.equal(transports.length, starts, 'verified setup and Codex must reuse one transport process');
  if (catalogRequests !== undefined) assert.equal(list.filter(event => event.type === 'catalog-request').length, catalogRequests);
  assert.equal(list.filter(event => event.type === 'catalog-request').every(event => event.authenticated), true);
  for (const entry of list.filter(event => ['transport-start', 'codex-start'].includes(event.type))) {
    assert.equal(isRunning(entry.pid), false, `${entry.type} must stop before the wrapper exits`);
  }
  for (const entry of transports) {
    await assert.rejects(access(entry.runtimeDirectory), { code: 'ENOENT' });
    if (entry.candidateDirectory !== context.config) await assert.rejects(access(entry.candidateDirectory), { code: 'ENOENT' });
  }
  return list;
}

async function assertSavedWithoutHandoff(context, result) {
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /run\s+`?mcodex`?\s+to\s+(?:open|start)\s+(?:official\s+)?Codex/i);
  assert.equal((await readFile(path.join(context.config, 'server.key'), 'utf8')).trim(), token);
  await assert.rejects(readFile(context.record), { code: 'ENOENT' });
  await assertClean(context);
}

async function assertHandoff(context, result, code = 17) {
  assert.equal(result.code, code, 'the wrapper must preserve the official CLI exit status');
  assert.equal(result.stdout, codexOutput, 'wrapper status must not add anything to Codex stdout');
  const child = JSON.parse(await readFile(context.record, 'utf8'));
  assert.deepEqual(child.addedEnvironmentKeys, ['MCODEX_LOCAL_KEY'], 'status must not introduce child environment variables');
  assert.equal(child.connectionTokenInEnvironment, false);
  assert.equal(child.localKeyIsConnectionToken, false);
  assert.equal(child.hasLocalKey, true);
  assert.equal(JSON.stringify(child.args).includes(token), false);
  assert.equal(child.args.some(arg => /mcodex:|Connecting to the gateway|Gateway connected|Starting Codex/i.test(arg)), false, 'startup status must not become a Codex argument');
  const list = await assertClean(context);
  const ready = list.find(event => event.type === 'transport-ready');
  assert.equal(child.args.some(arg => arg.includes(`${ready.origin}/v1`)), true, 'Codex must use the same transport that verified the Token');
  return child;
}

test('interactive login verifies and saves the connection, then enters Codex using the same transport', async t => {
  const context = await fixture(t);
  const result = await run(t, context, ['login'], { terminal: true, setup: true });
  const child = await assertHandoff(context, result);
  assert.equal(result.serverSent && result.tokenSent, true);
  assert.equal((await readFile(path.join(context.config, 'server.key'), 'utf8')).trim(), token);
  assert.equal(child.args.includes('login'), false);
  assert.match(result.stderr, /connection verified/i);
  assert.match(result.stderr, /Starting Codex/i);
  assert.ok(result.stderr.search(/connection verified/i) < result.stderr.search(/Starting Codex/i));
});

test('interactive login --no-launch saves the connection and returns without opening Codex', async t => {
  const context = await fixture(t);
  const result = await run(t, context, ['login', '--no-launch'], { terminal: true, setup: true });
  await assertSavedWithoutHandoff(context, result);
  assert.doesNotMatch(result.stderr, /Starting Codex/i);
});

test('nonterminal login saves the connection and returns without starting Codex', async t => {
  const context = await fixture(t);
  const result = await run(t, context, ['login', '--server', server, '--token-file', context.tokenFile]);
  await assertSavedWithoutHandoff(context, result);
});

for (const terminal of ['inputOnly', 'outputOnly']) {
  test(`login with ${terminal} TTY saves without launching Codex`, async t => {
    const context = await fixture(t);
    const result = await run(t, context, ['login', '--server', server, '--token-file', context.tokenFile], { terminal });
    await assertSavedWithoutHandoff(context, result);
  });
}

test('configured interactive mcodex shows connection progress and hands off to the official CLI', async t => {
  const context = await fixture(t, { configured: true });
  const result = await run(t, context, [], { terminal: true });
  const child = await assertHandoff(context, result);
  assert.equal(child.args.includes('model_provider="mcodex"'), true);
  assert.match(result.stderr, /Connecting to the gateway/i);
  assert.match(result.stderr, /Gateway connected.*Starting Codex/i);
  assert.ok(result.stderr.search(/Connecting/i) < result.stderr.search(/connected/i));
});

test('first interactive invocation completes hidden setup and continues using its already verified transport', async t => {
  const context = await fixture(t);
  const result = await run(t, context, [], { terminal: true, setup: true });
  await assertHandoff(context, result);
  assert.equal(result.serverSent && result.tokenSent, true);
  assert.equal((await readFile(path.join(context.config, 'server.key'), 'utf8')).trim(), token);
  assert.match(result.stderr, /First-time setup.*Codex will start/i);
  assert.match(result.stderr, /connection verified/i);
  assert.ok(result.stderr.search(/connection verified/i) < result.stderr.search(/Starting Codex/i));
});

test('nonterminal exec forwards arguments and keeps JSON stdout and stderr free of startup status', async t => {
  const context = await fixture(t, { configured: true });
  const args = ['exec', '--json', 'a prompt with $ and ` literals'];
  const result = await run(t, context, args);
  const child = await assertHandoff(context, result);
  assert.deepEqual(child.args.slice(-args.length), args);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { type: 'fixture_codex_started' });
});

test('terminal exec keeps its JSON stdout clean while connection status stays on stderr', async t => {
  const context = await fixture(t, { configured: true });
  const result = await run(t, context, ['exec', '--json', 'fixture prompt'], { terminal: true });
  await assertHandoff(context, result);
  assert.deepEqual(JSON.parse(result.stdout), { type: 'fixture_codex_started' });
});

test('failed login cleans the candidate and transport without replacing saved settings', async t => {
  const context = await fixture(t, { configured: true, transport: 'unauthorized' });
  const before = await readFile(path.join(context.config, 'config.json'), 'utf8');
  const result = await run(t, context, ['login', '--server', server, '--token-file', context.tokenFile], { terminal: true });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /authentication failed/i);
  assert.equal(await readFile(path.join(context.config, 'config.json'), 'utf8'), before);
  await assert.rejects(readFile(context.record), { code: 'ENOENT' });
  await assertClean(context);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} during login verification removes the candidate and stops the transport`, async t => {
    const context = await fixture(t, { transport: 'blocked' });
    const result = await run(t, context, ['login', '--server', server, '--token-file', context.tokenFile], { terminal: true, interruptAt: 'catalog', signal });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`Interrupted by ${signal}`));
    await assert.rejects(readFile(context.record), { code: 'ENOENT' });
    await assert.rejects(access(context.config), { code: 'ENOENT' });
    await assertClean(context);
  });

  test(`${signal} after interactive login reaches Codex and cleans both child processes`, async t => {
    const context = await fixture(t, { codexHolds: true });
    const result = await run(t, context, ['login', '--server', server, '--token-file', context.tokenFile], { terminal: true, interruptAt: 'codex', signal });
    await assertHandoff(context, result, signal === 'SIGINT' ? 130 : 143);
    const stopped = (await events(context)).find(event => event.type === 'codex-stop');
    assert.equal(stopped.signal, signal, 'the wrapper must forward its signal to Codex');
    assert.equal((await readFile(path.join(context.config, 'server.key'), 'utf8')).trim(), token);
  });
}

test('a transport failure after login stops Codex and removes temporary state', async t => {
  const context = await fixture(t, { codexHolds: true });
  const result = await run(t, context, ['login', '--server', server, '--token-file', context.tokenFile], { terminal: true, interruptAt: 'transport' });
  assert.equal(result.code, 1);
  assert.equal(result.stdout, codexOutput);
  assert.match(result.stderr, /native transport stopped while Codex was running/i);
  assert.equal((await events(context)).find(event => event.type === 'codex-stop').signal, 'SIGTERM');
  await assertClean(context);
});

test('ping measures the configured tunnel without opening Codex and cleans up', async t => {
  const context = await fixture(t, { configured: true });
  const result = await run(t, context, ['ping']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /min\/avg\/max: [\d.]+\/[\d.]+\/[\d.]+ ms/);
  assert.match(result.stdout, /Failed requests: 0\/5/);
  await assert.rejects(readFile(context.record), { code: 'ENOENT' });
  await assertClean(context, { catalogRequests: 6 });
});
