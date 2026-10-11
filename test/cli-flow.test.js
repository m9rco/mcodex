import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveState } from '../src/state.js';

const source = fileURLToPath(new URL('..', import.meta.url));
const server = 'wss://test.invalid/tunnel';
const token = 'cli-flow-dummy-connection-token-1234567890';
const codexOutput = '{"type":"fixture_codex_started"}\n';

async function fixture(t, { configured = false } = {}) {
  const directory = await mkdtemp('/tmp/mcodex-cli-flow-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const application = path.join(directory, 'application');
  await mkdir(application);
  for (const name of ['src', 'bin']) await cp(path.join(source, name), path.join(application, name), { recursive: true });
  await copyFile(path.join(source, 'package.json'), path.join(application, 'package.json'));

  // Exercise the real CLI, resolver, tunnel and process supervision. Only the
  // external transport executable and the official CLI package are fixtures.
  const native = path.join(application, 'node_modules', '@m9rco', `mcodex-${process.platform}-${process.arch}`);
  await mkdir(path.join(native, 'bin'), { recursive: true });
  await writeFile(path.join(native, 'package.json'), JSON.stringify({ name: `@m9rco/mcodex-${process.platform}-${process.arch}`, exports: { './package.json': './package.json' } }));
  const binary = path.join(native, 'bin', 'mlab-gateway');
  await copyFile(path.join(source, 'test', 'fixtures', 'transport.mjs'), binary);
  await chmod(binary, 0o755);

  const config = path.join(directory, 'config');
  const record = path.join(directory, 'handoff.json');
  const env = { ...process.env, MCODEX_CONFIG_DIR: config };
  const codex = path.join(application, 'node_modules', '@openai', 'codex');
  await mkdir(path.join(codex, 'bin'), { recursive: true });
  await writeFile(path.join(codex, 'package.json'), JSON.stringify({ name: '@openai/codex', type: 'module' }));
  await writeFile(path.join(codex, 'bin', 'codex.js'), `
import { writeFileSync } from 'node:fs';
const baseKeys = new Set(${JSON.stringify(Object.keys(env))});
const token = ${JSON.stringify(token)};
writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args: process.argv.slice(2),
  addedEnvironmentKeys: Object.keys(process.env).filter(key => !baseKeys.has(key)).sort(),
  connectionTokenInEnvironment: Object.values(process.env).some(value => value.includes(token)),
  hasLocalKey: Boolean(process.env.MCODEX_LOCAL_KEY),
  localKeyIsConnectionToken: process.env.MCODEX_LOCAL_KEY === token,
}));
process.stdout.write(${JSON.stringify(codexOutput)});
process.exit(17);
`);
  const preload = path.join(directory, 'tty.mjs');
  await writeFile(preload, `
for (const stream of [process.stdin, process.stdout, process.stderr]) {
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
}
process.stdin.setRawMode = value => { process.stdin.isRaw = value; return process.stdin; };
`);
  const tokenFile = path.join(directory, 'input-token');
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  if (configured) await saveState(config, { server, token, model: 'test-model' });
  return { application, config, record, env, preload, tokenFile };
}

async function run(t, context, args, { terminal = false, setup = false } = {}) {
  const argv = [...(terminal ? ['--import', context.preload] : []), path.join(context.application, 'bin', 'mcodex.js'), ...args];
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
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('CLI flow did not complete within five seconds.'));
    }, 5000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(stdout.includes(token) || stderr.includes(token), false, 'connection Token must not appear in terminal output');
  return { code, stdout, stderr, serverSent, tokenSent };
}

async function assertHandoff(context, result) {
  assert.equal(result.code, 17, 'the wrapper must preserve the official CLI exit status');
  assert.equal(result.stdout, codexOutput, 'wrapper status must not add anything to Codex stdout');
  const child = JSON.parse(await readFile(context.record, 'utf8'));
  assert.deepEqual(child.addedEnvironmentKeys, ['MCODEX_LOCAL_KEY'], 'status must not introduce child environment variables');
  assert.equal(child.connectionTokenInEnvironment, false);
  assert.equal(child.localKeyIsConnectionToken, false);
  assert.equal(child.hasLocalKey, true);
  assert.equal(JSON.stringify(child.args).includes(token), false);
  assert.equal(child.args.some(arg => /mcodex:|Connecting to the gateway|Gateway connected|Starting Codex/i.test(arg)), false, 'startup status must not become a Codex argument');
  return child;
}

test('explicit login saves the connection, gives the next command and returns without starting Codex', async t => {
  const context = await fixture(t);
  const result = await run(t, context, ['login', '--server', server, '--token-file', context.tokenFile]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /run\s+`?mcodex`?\s+to\s+(?:open|start)\s+(?:official\s+)?Codex/i);
  assert.equal((await readFile(path.join(context.config, 'server.key'), 'utf8')).trim(), token);
  await assert.rejects(readFile(context.record), { code: 'ENOENT' });
});

test('configured interactive mcodex shows connection progress and hands off to the official CLI', async t => {
  const context = await fixture(t, { configured: true });
  const result = await run(t, context, [], { terminal: true });
  const child = await assertHandoff(context, result);
  assert.equal(child.args.includes('model_provider="mcodex"'), true);
  assert.match(result.stderr, /connect(?:ing|ion.*check)/i);
  assert.match(result.stderr, /connect(?:ed|ion.*(?:verified|ready|ok))/i);
  assert.match(result.stderr, /(?:open|start|enter)(?:ing)?\s+(?:the\s+)?(?:official\s+)?Codex/i);
  assert.ok(result.stderr.search(/Connecting/i) < result.stderr.search(/connected/i), 'connecting status must precede the confirmed connection');
});

test('first interactive invocation completes hidden setup and continues directly into Codex', async t => {
  const context = await fixture(t);
  const result = await run(t, context, [], { terminal: true, setup: true });
  await assertHandoff(context, result);
  assert.equal(result.serverSent, true);
  assert.equal(result.tokenSent, true);
  assert.equal((await readFile(path.join(context.config, 'server.key'), 'utf8')).trim(), token);
  assert.match(result.stderr, /First-time setup.*Codex will start/i);
  assert.match(result.stderr, /connection verified/i);
  assert.match(result.stderr, /(?:open|start|enter)(?:ing)?\s+(?:the\s+)?(?:official\s+)?Codex/i);
  assert.ok(result.stderr.search(/connection verified/i) < result.stderr.search(/Starting Codex/i), 'verified setup must precede the Codex handoff');
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
