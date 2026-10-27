import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { saveState } from '../src/state.js';

const source = fileURLToPath(new URL('..', import.meta.url));
const packageManifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
const transportVersion = '0.4.2';
// Optional HTTPS telemetry must fail locally rather than depend on external DNS.
// This plain HTTP fixture immediately rejects TLS, while inference uses the
// separate authenticated transport fixture below.
const relayFixture = createServer();
let relayConnections = 0;
relayFixture.on('connection', () => { relayConnections++; });
relayFixture.on('clientError', (_error, socket) => socket.destroy());
await new Promise(resolve => relayFixture.listen(0, '127.0.0.1', resolve));
const server = `wss://127.0.0.1:${relayFixture.address().port}/tunnel`;
after(() => new Promise(resolve => { relayFixture.closeAllConnections(); relayFixture.close(resolve); }));
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

async function fixture(t, { configured = false, transport = 'normal', codexHolds = false, engineHolds = false, diagnostics = 'legacy', proxyEnv = {},
  nativePackageVersion, nativeBinaryVersion = transportVersion, nativeMetadataVersion = transportVersion,
  engineVersionDelayMs = 0, nativeVersionDelayMs = 0 } = {}) {
  const directory = await mkdtemp('/tmp/mcodex-cli-flow-');
  const context = { directory, events: path.join(directory, 'events.jsonl') };
  t.after(async () => {
    // A failing assertion must not leave a fixture executable or key directory.
    for (const event of await events(context)) {
      if (!['transport-start', 'codex-start', 'codex-ready'].includes(event.type)) continue;
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
  await writeFile(path.join(native, 'package.json'), JSON.stringify({ name: nativeName, version: nativePackageVersion ?? packageManifest.optionalDependencies[nativeName], mcodex: { transportVersion: nativeMetadataVersion }, exports: { './package.json': './package.json' } }));
  const binary = path.join(native, 'bin', 'mlab-gateway');
  const diagnosticBody = typeof diagnostics === 'object' ? JSON.stringify(diagnostics)
    : diagnostics === 'malformed' ? '{"schema_version":1,"connected":true,"hops":null}' : '';
  await writeFile(binary, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
if (process.argv.length === 3 && process.argv[2] === '--version') {
  if (${JSON.stringify(nativeVersionDelayMs)} > 0) await new Promise(resolve => setTimeout(resolve, ${JSON.stringify(nativeVersionDelayMs)}));
  console.log('mlab-gateway ${nativeBinaryVersion}');
  process.exit(0);
}
const record = value => appendFileSync(${JSON.stringify(context.events)}, JSON.stringify(value) + '\\n', { mode: 0o600 });
const configFile = process.argv[process.argv.indexOf('--config') + 1];
const config = Object.fromEntries(readFileSync(configFile, 'utf8').trim().split('\\n').map(line => {
  const at = line.indexOf(' = ');
  return [line.slice(0, at), JSON.parse(line.slice(at + 3))];
}));
const key = readFileSync(config.api_key_file, 'utf8').trim();
record({ type: 'transport-start', pid: process.pid, server: config.server_url, runtimeDirectory: path.dirname(configFile), candidateDirectory: path.dirname(config.server_key_file), connectionTokenMatches: readFileSync(config.server_key_file, 'utf8').trim() === ${JSON.stringify(token)} });
let catalogCount = 0;
const server = http.createServer((request, response) => {
  const authenticated = request.headers.authorization === 'Bearer ' + key;
  record({ type: request.url === '/diagnostics' ? 'diagnostics-request' : 'catalog-request', server: config.server_url, authenticated });
  if (request.url === '/diagnostics') {
    if (${JSON.stringify(diagnostics)} === 'blocked') return;
    response.writeHead(${JSON.stringify(diagnostics)} === 'legacy' ? 404 : 200);
    response.end(${JSON.stringify(diagnosticBody)}); return;
  }
  catalogCount++;
  if (${JSON.stringify(transport)} === 'blocked' || (${JSON.stringify(transport)} === 'probe-blocked' && catalogCount > 1)) return;
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
  const env = { ...process.env, ...proxyEnv, MCODEX_CONFIG_DIR: config };
  delete env.MCODEX_CODEX_BIN;
  const proxyHashes = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']
    .map(name => [name, env[name] === undefined ? null : createHash('sha256').update(env[name]).digest('hex')]));
  const codex = path.join(application, 'node_modules', '@openai', 'codex');
  await mkdir(path.join(codex, 'bin'), { recursive: true });
  await writeFile(path.join(codex, 'package.json'), JSON.stringify({ name: '@openai/codex', type: 'module' }));
  await writeFile(path.join(codex, 'bin', 'codex.js'), `
import { appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
if (process.argv.length === 3 && process.argv[2] === '--version') {
  if (${JSON.stringify(engineVersionDelayMs)} > 0) await new Promise(resolve => setTimeout(resolve, ${JSON.stringify(engineVersionDelayMs)}));
  if (${JSON.stringify(engineHolds)}) {
    appendFileSync(${JSON.stringify(context.events)}, JSON.stringify({ type: 'codex-ready', pid: process.pid }) + '\\n');
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }
  console.log('codex-cli ' + ${JSON.stringify(JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')).dependencies['@openai/codex'])});
  process.exit(0);
}
const baseKeys = new Set(${JSON.stringify(Object.keys(env))});
const token = ${JSON.stringify(token)};
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  pid: process.pid,
  cwd: process.cwd(),
  home: process.env.HOME,
  codeHome: process.env.CODEX_HOME,
  shellDirectory: process.env.ZDOTDIR,
  args: process.argv.slice(2),
  addedEnvironmentKeys: Object.keys(process.env).filter(key => !baseKeys.has(key)).sort(),
  connectionTokenInEnvironment: Object.values(process.env).some(value => value.includes(token)),
  hasLocalKey: Boolean(process.env.MCODEX_LOCAL_KEY),
  localKeyIsConnectionToken: process.env.MCODEX_LOCAL_KEY === token,
  proxyBypass: { uppercase: process.env.NO_PROXY, lowercase: process.env.no_proxy },
  inheritedProxyUnchanged: Object.entries(${JSON.stringify(proxyHashes)}).every(([name, expected]) =>
    (process.env[name] === undefined ? null : createHash('sha256').update(process.env[name]).digest('hex')) === expected),
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

async function run(t, context, args, { terminal = false, setup = false, interruptAt, signal = 'SIGTERM', cwd, timeoutMs = 6000 } = {}) {
  const previousRelayConnections = relayConnections;
  const preload = terminal === true ? context.preloads.terminal : context.preloads[terminal];
  const argv = [...(preload ? ['--import', preload] : []), path.join(context.application, 'bin', 'mcodex.js'), ...args];
  const child = spawn(process.execPath, argv, { cwd, env: context.env, stdio: ['pipe', 'pipe', 'pipe'] });
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
      reject(new Error(`CLI flow did not complete within ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, exitSignal) => { clearTimeout(timeout); resolve({ code, exitSignal }); });
  });
  let action;
  if (interruptAt) action = (async () => {
    const list = await waitFor(`fixture ${interruptAt}`, async () => {
      const list = await events(context);
      const expected = interruptAt === 'catalog' ? 'catalog-request' : interruptAt === 'diagnostics' ? 'diagnostics-request' : 'codex-ready';
      const ready = interruptAt === 'paired-probe' ? list.filter(event => event.type === 'catalog-request').length >= 3
        : list.some(event => event.type === expected);
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
  return { code, exitSignal, stdout, stderr, serverSent, tokenSent, relayConnections: relayConnections - previousRelayConnections };
}

async function assertClean(context, { starts = 1, catalogRequests = 1 } = {}) {
  const list = await events(context);
  const transports = list.filter(event => event.type === 'transport-start');
  assert.equal(transports.length, starts, 'verified setup and Codex must reuse one transport process');
  if (catalogRequests !== undefined) assert.equal(list.filter(event => event.type === 'catalog-request').length, catalogRequests);
  assert.equal(list.filter(event => event.type === 'catalog-request').every(event => event.authenticated), true);
  assert.equal(transports.every(event => event.connectionTokenMatches), true, 'all temporary endpoints must reuse the original private connection key');
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
  assert.equal(result.relayConnections, 0, 'login must not open an independent relay probe');
  assert.equal((await events(context)).some(event => event.type === 'diagnostics-request'), false, 'login must not wait for optional diagnostics');
}

async function assertHandoff(context, result, code = 17) {
  assert.equal(result.code, code, 'the wrapper must preserve the official CLI exit status');
  assert.equal(result.stdout, codexOutput, 'wrapper status must not add anything to Codex stdout');
  assert.equal(result.relayConnections, 0, 'ordinary startup must not open an independent relay probe');
  const child = JSON.parse(await readFile(context.record, 'utf8'));
  const allowed = ['MCODEX_LOCAL_KEY', 'NO_PROXY', 'no_proxy', 'BASH_ENV', 'ZDOTDIR'];
  assert.equal(child.addedEnvironmentKeys.every(key => allowed.includes(key)), true, 'only local authentication, loopback exclusions and private shell startup paths may be introduced');
  assert.deepEqual(child.addedEnvironmentKeys, allowed.filter(key => !Object.hasOwn(context.env, key)).sort());
  assert.equal(child.proxyBypass.uppercase, child.proxyBypass.lowercase);
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.ok(child.proxyBypass.uppercase.split(',').includes(host));
  assert.equal(child.inheritedProxyUnchanged, true);
  assert.equal(child.connectionTokenInEnvironment, false);
  assert.equal(child.localKeyIsConnectionToken, false);
  assert.equal(child.hasLocalKey, true);
  await assert.rejects(access(child.shellDirectory), { code: 'ENOENT' });
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

const currentDiagnostics = { schema_version: 1, connected: true, hops: [], tunnel: { rtt: null }, transport: {
  protocol: 'mlab-tunnel-v2', server_version: '0.4.2', effective_max_body_bytes: 16 * 1024 * 1024,
  configured_max_body_bytes: 16 * 1024 * 1024, request_body_budget_bytes: 128 * 1024 * 1024,
} };

test('interactive startup reports local versions without requesting optional diagnostics or relay probes', async t => {
  const context = await fixture(t, { configured: true, diagnostics: currentDiagnostics });
  const result = await run(t, context, [], { terminal: true });
  await assertHandoff(context, result);
  assert.match(result.stderr, new RegExp(`mcodex ${packageManifest.version.replaceAll('.', '\\.')}`));
  assert.match(result.stderr, /Codex \d+\.\d+\.\d+; source: bundled/);
  assert.match(result.stderr, /Native transport: mlab-gateway 0.4.2; source: bundled; package: 0.1.3; bundled match: verified/);
  assert.doesNotMatch(result.stderr, /Gateway version:|request-body cap|WSS heartbeat RTT|Per-hop probe/);
  assert.equal((await events(context)).some(event => event.type === 'diagnostics-request'), false);
});

test('doctor shows native package and gateway versions and keeps different limits distinct', async t => {
  const context = await fixture(t, { configured: true, diagnostics: currentDiagnostics });
  const result = await run(t, context, ['doctor']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Native transport: mlab-gateway 0.4.2; source: bundled; package: 0.1.3/);
  assert.match(result.stdout, /Gateway version: 0.4.2/);
  assert.match(result.stdout, /protocol v2; request-body cap 16.0 MiB/);
  assert.match(result.stdout, /413 is a transport request-body limit; 400 context_length_exceeded is the model token window; 429 may be a local memory\/concurrency limit or upstream quota/);
  const list = await assertClean(context);
  assert.equal(list.filter(event => event.type === 'diagnostics-request').length, 1);
  assert.equal(result.relayConnections, 1, 'doctor must still probe the configured relay');
});

test('legacy protocol fallback warns that both client and server determine the body cap', async t => {
  const diagnostics = { ...currentDiagnostics, transport: { ...currentDiagnostics.transport, protocol: 'mlab-tunnel-v1',
    server_version: null, effective_max_body_bytes: 1024 * 1024 } };
  const context = await fixture(t, { configured: true, diagnostics });
  const result = await run(t, context, ['doctor']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Legacy v1 fallback:.*update both the mcodex native transport and gateway/);
  assert.match(result.stdout, /Gateway version: unavailable/);
  await assertClean(context);
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
  const list = await assertClean(context, { catalogRequests: 6 });
  assert.equal(list.filter(event => event.type === 'diagnostics-request').length, 1);
  assert.equal(result.relayConnections, 1, 'ping must still probe the configured relay');
});

for (const args of [['engine', 'status'], ['doctor', '--local'], ['--version']]) {
  test(`${args.join(' ')} reports actual local engine versions without connection settings or a gateway`, async t => {
    const context = await fixture(t);
    const result = await run(t, context, args);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Codex \d+\.\d+\.\d+; source: bundled; compatibility: tested/);
    assert.match(result.stdout, /Codex path: .*node_modules\/@openai\/codex\/bin\/codex.js/);
    if (args[0] === 'doctor') assert.match(result.stdout, /Native transport: mlab-gateway 0.4.2/);
    assert.equal((await events(context)).length, 0);
    await assert.rejects(readFile(context.record), { code: 'ENOENT' });
  });
}

test('ping does not resolve or execute an explicitly configured invalid Codex engine', async t => {
  const context = await fixture(t, { configured: true });
  context.env.MCODEX_CODEX_BIN = '/does-not-exist/selected-codex';
  const result = await run(t, context, ['ping']);
  assert.equal(result.code, 0);
  await assertClean(context, { catalogRequests: 6 });
});

test('an invalid selected engine stops before creating a gateway process', async t => {
  const context = await fixture(t, { configured: true });
  context.env.MCODEX_CODEX_BIN = '/does-not-exist/selected-codex';
  const result = await run(t, context, ['exec', '--json', 'fixture prompt']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /selected Codex engine is missing/);
  assert.equal((await events(context)).length, 0);
  await assert.rejects(readFile(context.record), { code: 'ENOENT' });
});

for (const [description, options, message] of [
  ['stale native package', { nativePackageVersion: '0.1.1' }, /native transport package does not match mcodex/],
  ['native binary different from its metadata', { nativeBinaryVersion: '0.3.5' }, /native transport binary does not match its package metadata/],
]) {
  test(`${description} fails before connecting or launching Codex`, async t => {
    const context = await fixture(t, { configured: true, ...options });
    const before = await readFile(path.join(context.config, 'config.json'), 'utf8');
    const result = await run(t, context, ['exec', '--json', 'fixture prompt']);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
    assert.equal((await events(context)).length, 0);
    assert.equal(await readFile(path.join(context.config, 'config.json'), 'utf8'), before);
    await assert.rejects(readFile(context.record), { code: 'ENOENT' });
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} during a local engine version check terminates its process without a gateway`, async t => {
    const context = await fixture(t, { engineHolds: true });
    const result = await run(t, context, ['engine', 'status'], { interruptAt: 'codex', signal });
    assert.equal(result.code, 1);
    assert.match(result.stderr, new RegExp(`Interrupted by ${signal}`));
    const list = await events(context);
    const inspecting = list.find(event => event.type === 'codex-ready');
    assert.equal(isRunning(inspecting.pid), false);
    assert.equal(list.some(event => event.type === 'transport-start'), false);
  });
}

for (const diagnostics of ['malformed', 'blocked']) {
  test(`${diagnostics} optional diagnostics are not requested during interactive Codex startup`, async t => {
    const context = await fixture(t, { configured: true, diagnostics });
    const result = await run(t, context, [], { terminal: true });
    await assertHandoff(context, result);
    assert.equal((await events(context)).some(event => event.type === 'diagnostics-request'), false);
    assert.doesNotMatch(result.stderr, /telemetry unavailable|Per-hop probe/);
  });
}

test('route comparison launches two independent authenticated transports and cleans both', async t => {
  const context = await fixture(t, { configured: true });
  const comparedUrl = new URL('/comparison', server);
  comparedUrl.hostname = '127.0.0.2';
  const compared = comparedUrl.href;
  const result = await run(t, context, ['ping', '--compare', compared]);
  assert.equal(result.code, 0);
  const started = (await events(context)).filter(event => event.type === 'transport-start');
  assert.deepEqual(started.map(event => event.server), [server, compared]);
  assert.match(result.stdout, /Baseline 127\.0\.0\.1:\d+: setup \d+ ms;/);
  assert.match(result.stdout, /Comparison 127\.0\.0\.2:\d+: setup \d+ ms;/);
  assert.doesNotMatch(result.stdout, /^\d+: \d+\.\d+ ms$/m);
  assert.doesNotMatch(result.stdout, /^min\/avg\/max:/m);
  await assert.rejects(readFile(context.record), { code: 'ENOENT' });
  const list = await assertClean(context, { starts: 2, catalogRequests: 12 });
  assert.deepEqual(list.filter(event => event.type === 'catalog-request').slice(2).map(event => event.server),
    [server, compared, compared, server, server, compared, compared, server, server, compared]);
});

test('same endpoint comparison creates two transports and reports connection variation', async t => {
  const context = await fixture(t, { configured: true });
  const before = await Promise.all(['config.json', 'server.key'].map(name => readFile(path.join(context.config, name), 'utf8')));
  const result = await run(t, context, ['ping', '--compare', server], { terminal: true });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Same endpoint, two independent connections:.*connection variation/);
  assert.doesNotMatch(result.stdout, /changing routes|min\/avg\/max:/);
  assert.doesNotMatch(result.stderr, /Starting Codex|WSS heartbeat RTT|Per-hop probe/);
  const list = await assertClean(context, { starts: 2, catalogRequests: 12 });
  assert.deepEqual(list.filter(event => event.type === 'transport-start').map(event => event.server), [server, server]);
  assert.deepEqual(await Promise.all(['config.json', 'server.key'].map(name => readFile(path.join(context.config, name), 'utf8'))), before);
  await assert.rejects(readFile(context.record), { code: 'ENOENT' });
});

for (const option of ['positional', '--server']) {
  test(`ping ${option} target only overrides the endpoint temporarily`, async t => {
    const context = await fixture(t, { configured: true });
    const target = new URL('/target-only', server).href;
    const before = await Promise.all(['config.json', 'server.key'].map(name => readFile(path.join(context.config, name), 'utf8')));
    const result = await run(t, context, ['ping', ...(option === 'positional' ? [target] : ['--server', target])]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Failed requests: 0\/5/);
    assert.doesNotMatch(result.stdout, /Comparing|Comparison .*setup/);
    const list = await assertClean(context, { catalogRequests: 6 });
    assert.equal(list.find(event => event.type === 'transport-start').server, target);
    assert.deepEqual(await Promise.all(['config.json', 'server.key'].map(name => readFile(path.join(context.config, name), 'utf8'))), before);
    await assert.rejects(readFile(context.record), { code: 'ENOENT' });
  });
}

test('explicit baseline and comparison both override saved route without replacing settings', async t => {
  const context = await fixture(t, { configured: true });
  const baseline = new URL('/explicit-baseline', server).href;
  const compared = new URL('/explicit-comparison', server).href;
  const before = await Promise.all(['config.json', 'server.key'].map(name => readFile(path.join(context.config, name), 'utf8')));
  const result = await run(t, context, ['ping', '--server', baseline, '--compare', compared]);
  assert.equal(result.code, 0);
  const list = await assertClean(context, { starts: 2, catalogRequests: 12 });
  assert.deepEqual(list.filter(event => event.type === 'transport-start').map(event => event.server), [baseline, compared]);
  assert.deepEqual(await Promise.all(['config.json', 'server.key'].map(name => readFile(path.join(context.config, name), 'utf8'))), before);
  await assert.rejects(readFile(context.record), { code: 'ENOENT' });
});

test('invalid or duplicate ping endpoints fail before any transport starts', async t => {
  const context = await fixture(t, { configured: true });
  const invalid = ['http://test.invalid', 'wss://user:fixture-secret@test.invalid', 'wss://test.invalid?token=fixture-secret', 'wss://test.invalid#fixture-secret'];
  const inputs = invalid.flatMap(endpoint => [[endpoint], ['--server', endpoint], ['--compare', endpoint]]);
  inputs.push(['--server', server, server], [server, '--server', server], ['--compare', server, '--compare', server]);
  for (const args of inputs) {
    const result = await run(t, context, ['ping', ...args]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('fixture-secret'), false);
  }
  assert.equal((await events(context)).length, 0);
});

test('cancelling a paired comparison stops both transports and leaves saved settings intact', async t => {
  const context = await fixture(t, { configured: true, transport: 'probe-blocked' });
  const before = await Promise.all(['config.json', 'server.key'].map(name => readFile(path.join(context.config, name), 'utf8')));
  const result = await run(t, context, ['ping', '--compare', server], { interruptAt: 'paired-probe' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Interrupted by SIGTERM/);
  await assertClean(context, { starts: 2, catalogRequests: 3 });
  assert.deepEqual(await Promise.all(['config.json', 'server.key'].map(name => readFile(path.join(context.config, name), 'utf8'))), before);
  await assert.rejects(readFile(context.record), { code: 'ENOENT' });
});

test('cancellation during explicit doctor diagnostics cleans transport without launching Codex', async t => {
  const context = await fixture(t, { configured: true, diagnostics: 'blocked' });
  const result = await run(t, context, ['doctor'], { terminal: true, interruptAt: 'diagnostics' });
  assert.equal(result.code, 1);
  assert.match(result.stdout, /^Launcher [^\n]+; runtime [^\n]+; source: bundled\.\n$/);
  assert.match(result.stderr, /Interrupted by SIGTERM/);
  await assert.rejects(readFile(context.record), { code: 'ENOENT' });
  await assertClean(context);
});

test('actual Codex child preserves inherited proxy settings and merges uppercase and lowercase bypass lists', async t => {
  const context = await fixture(t, { configured: true, proxyEnv: {
    NO_PROXY: 'upper.example,localhost', no_proxy: 'lower.example,upper.example',
    HTTPS_PROXY: 'http://fixture-proxy.invalid:8888', http_proxy: 'http://fixture-proxy.invalid:8889',
  } });
  const result = await run(t, context, ['exec', '--json', 'fixture prompt']);
  const child = await assertHandoff(context, result);
  assert.equal(child.proxyBypass.uppercase, 'upper.example,localhost,lower.example,127.0.0.1,::1');
});

test('workspace stays separate from HOME during saved startup, first login and explicit directory forwarding', async t => {
  for (const configured of [true, false]) {
    const context = await fixture(t, { configured, proxyEnv: { HOME: 'fixture', CODEX_HOME: 'fixture', PWD: 'fixture' } });
    const workspace = path.join(await realpath(context.directory), 'workspace with spaces');
    await mkdir(workspace);
    context.env.HOME = path.join(context.directory, 'separate-home');
    context.env.CODEX_HOME = path.join(context.directory, 'separate-codex-home');
    context.env.PWD = context.env.HOME;
    const args = configured ? ['exec', '--cd', './child directory', '-c', 'allow_login_shell=true', 'fixture prompt'] : [];
    const result = await run(t, context, args, { cwd: workspace, terminal: true, setup: !configured });
    const child = await assertHandoff(context, result);
    assert.equal(child.cwd, workspace);
    assert.equal(child.home, context.env.HOME);
    assert.equal(child.codeHome, context.env.CODEX_HOME);
    assert.ok(child.args.includes('allow_login_shell=false'));
    if (configured) {
      assert.deepEqual(child.args.slice(-4), ['exec', '--cd', './child directory', 'fixture prompt']);
      assert.ok(child.args.indexOf('allow_login_shell=true') > child.args.indexOf('allow_login_shell=false'));
      assert.ok(child.args.indexOf('allow_login_shell=true') < child.args.indexOf('exec'));
    }
    assert.ok(result.stderr.includes(`Launch directory: ${JSON.stringify(workspace)}`));
  }
});

test('local doctor reports launch directory and independent home paths without a gateway', async t => {
  const context = await fixture(t);
  const workspace = path.join(await realpath(context.directory), 'workspace');
  await mkdir(workspace);
  context.env.HOME = path.join(context.directory, 'home');
  context.env.CODEX_HOME = path.join(context.directory, 'codex-home');
  const result = await run(t, context, ['doctor', '--local'], { cwd: workspace });
  assert.equal(result.code, 0);
  for (const [label, value] of [['Launch directory', workspace], ['HOME', context.env.HOME], ['CODEX_HOME', context.env.CODEX_HOME]]) {
    assert.ok(result.stdout.includes(`${label}: ${JSON.stringify(value)}`));
  }
  assert.equal((await events(context)).length, 0);
});

for (const [component, options] of [
  ['Codex', { engineVersionDelayMs: 5500 }],
  ['native transport', { nativeVersionDelayMs: 5500 }],
]) {
  test(`local doctor accepts a cold ${component} version probe above the normal five-second budget`, async t => {
    const context = await fixture(t, options);
    const result = await run(t, context, ['doctor', '--local'], { timeoutMs: 12000 });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Codex \d+\.\d+\.\d+; source: bundled; compatibility: tested/);
    assert.match(result.stdout, /Native transport: mlab-gateway 0\.4\.2; source: bundled; package: 0\.1\.3; bundled match: verified/);
    assert.match(result.stdout, /local checks only; no gateway connection/);
    assert.equal(result.relayConnections, 0);
    assert.equal((await events(context)).length, 0);
    await assert.rejects(readFile(context.record), { code: 'ENOENT' });
  });
}
