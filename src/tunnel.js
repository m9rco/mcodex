import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, chmod, writeFile, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);

export function nativePackage(platform = process.platform, arch = process.arch) {
  const supported = new Set(['linux-x64', 'linux-arm64', 'darwin-arm64']);
  const target = `${platform}-${arch}`;
  if (!supported.has(target)) throw new Error(`Unsupported platform ${target}; use Linux x64/arm64 or Apple Silicon.`);
  return `@m9rco/mcodex-${target}`;
}

export async function resolveNative() {
  const name = nativePackage();
  let manifest;
  try { manifest = require.resolve(`${name}/package.json`); }
  catch { throw new Error(`Native transport ${name} is missing. Reinstall @m9rco/mcodex with npm optional dependencies enabled.`); }
  const binary = path.join(path.dirname(manifest), 'bin', 'mlab-gateway');
  await access(binary, constants.X_OK);
  return binary;
}

export function resolveCodex() {
  try { return require.resolve('@openai/codex/bin/codex.js'); }
  catch { throw new Error('The bundled official Codex CLI is missing. Reinstall mcodex.'); }
}

async function stopProcess(child, exitSignal = 'SIGTERM') {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill(exitSignal);
  });
}

export async function startTunnel(state, { binary, timeoutMs = 30000, signal } = {}) {
  binary ??= await resolveNative();
  const directory = await mkdtemp(path.join(tmpdir(), 'mcodex-'));
  await chmod(directory, 0o700);
  const key = randomBytes(32).toString('base64url');
  const keyFile = path.join(directory, 'local.key');
  const configFile = path.join(directory, 'client.toml');
  let child;
  let closed = false;
  let failure;
  let origin;
  const close = async () => {
    if (closed) return;
    closed = true;
    await stopProcess(child);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await writeFile(keyFile, `${key}\n`, { mode: 0o600, flag: 'wx' });
    const config = {
      listen: '127.0.0.1:0',
      api_key_file: keyFile,
      server_key_file: state.tokenFile,
      server_url: state.server,
      // SG may renew OAuth before its 30s inference deadline. Wait longer than
      // the relay's 90s total budget so its structured error can reach Codex.
      header_timeout_seconds: 120,
      idle_timeout_seconds: 300,
    };
    await writeFile(configFile, Object.entries(config).map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    child = spawn(binary, ['client', 'serve', '--config', configFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RUST_LOG: 'info', NO_COLOR: '1' },
    });
    child.once('error', () => { failure = new Error('Unable to start the native transport.'); });
    child.once('exit', (code, exitSignal) => {
      failure = new Error(`Native transport exited (${exitSignal ?? code}).`);
    });
    let log = '';
    const inspect = chunk => {
      log = (log + chunk.toString().replace(/\x1b\[[0-9;]*m/g, '')).slice(-8192);
      const match = log.match(/listen=(127\.0\.0\.1:[1-9][0-9]*)/);
      if (match) origin = `http://${match[1]}`;
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    const deadline = Date.now() + timeoutMs;
    let lastStatus;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      if (origin) {
        try {
          const response = await fetch(`${origin}/v1/models`, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.any([AbortSignal.timeout(Math.min(3000, Math.max(1, deadline - Date.now()))), ...(signal ? [signal] : [])]),
          });
          lastStatus = response.status;
          if (response.ok) {
            const data = await response.json();
            if (!Array.isArray(data.data)) throw new Error('The gateway returned an invalid model catalog.');
            return { origin, key, models: data.data, child, close, directory };
          }
          await response.body?.cancel();
          if ([401, 403].includes(lastStatus)) throw new Error('Gateway authentication failed. Run mcodex login with a valid connection Token.');
        } catch (error) {
          if (signal?.aborted) throw error;
          if (lastStatus === 401 || lastStatus === 403 || error.message === 'The gateway returned an invalid model catalog.') throw error;
        }
      }
      await delay(100, undefined, { signal });
    }
    throw new Error(`Gateway connection timed out${lastStatus ? ` (HTTP ${lastStatus})` : ''}. Check the server address, connection Token, TLS and network.`);
  } catch (error) {
    await close();
    throw error;
  }
}

export async function runCodex(tunnel, args, { model, codexEntry = resolveCodex(), signal } = {}) {
  const { providerArguments } = await import('./provider.js');
  signal?.throwIfAborted();
  if (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null) throw new Error('The native transport stopped before Codex could start.');
  const child = spawn(process.execPath, [codexEntry, ...providerArguments({ origin: tunnel.origin, model }), ...args], {
    stdio: 'inherit',
    env: { ...process.env, MCODEX_LOCAL_KEY: tunnel.key },
  });
  let transportFailed = false;
  let stopping;
  const stop = exitSignal => { stopping ??= stopProcess(child, exitSignal); };
  const onTransportExit = () => { transportFailed = true; stop('SIGTERM'); };
  tunnel.child.once('exit', onTransportExit);
  const forward = () => { stop(signal.reason?.signal ?? 'SIGTERM'); };
  signal?.addEventListener('abort', forward, { once: true });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, exitSignal) => resolve(code ?? (exitSignal === 'SIGINT' ? 130 : 143)));
      if (signal?.aborted) forward();
    });
    if (transportFailed) throw new Error('The native transport stopped while Codex was running.');
    return code;
  } finally {
    signal?.removeEventListener('abort', forward);
    tunnel.child.removeListener('exit', onTransportExit);
    await (stopping ?? stopProcess(child));
  }
}
