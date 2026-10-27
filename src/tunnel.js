import { performance } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, chmod, writeFile, rm, access, realpath, stat, readFile } from 'node:fs/promises';
import { constants, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { bundledCodexEntry, commandVersion, engineCommand, resolveEngine } from './engine.js';
import { formatConnectionFailure, readConnectionFailure, readDiagnostics } from './latency.js';
import { catalogScopePattern, clearModelCache, loadModelCache, MODEL_CACHE_MAX_AGE_MS, modelCacheIdentity, saveModelCache } from './state.js';
import { withShellEnvironment } from './shell-environment.js';

const require = createRequire(import.meta.url);
const wrapperManifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const nativeVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function nativePackage(platform = process.platform, arch = process.arch) {
  const supported = new Set(['linux-x64', 'linux-arm64', 'darwin-arm64']);
  const target = `${platform}-${arch}`;
  if (!supported.has(target)) throw new Error(`Unsupported platform ${target}; use Linux x64/arm64 or Apple Silicon.`);
  return `@m9rco/mcodex-${target}`;
}

export async function resolveNative({ env = process.env } = {}) {
  if (env.MCODEX_NATIVE_BIN !== undefined) {
    if (typeof env.MCODEX_NATIVE_BIN !== 'string' || !env.MCODEX_NATIVE_BIN.trim()) {
      throw new Error('MCODEX_NATIVE_BIN must name an executable native transport. Unset it to use the bundled transport.');
    }
    const binary = path.resolve(env.MCODEX_NATIVE_BIN);
    try {
      if (!(await stat(binary)).isFile()) throw new Error('not a file');
      await access(binary, constants.X_OK);
    } catch { throw new Error('The selected native transport is missing or cannot be executed. Unset MCODEX_NATIVE_BIN to use the bundled transport.'); }
    return binary;
  }
  const name = nativePackage();
  let manifest;
  try { manifest = require.resolve(`${name}/package.json`); }
  catch { throw new Error(`Native transport ${name} is missing. Reinstall @m9rco/mcodex with npm optional dependencies enabled.`); }
  const binary = path.join(path.dirname(manifest), 'bin', 'mlab-gateway');
  await access(binary, constants.X_OK);
  return binary;
}

export async function inspectNative({ binary, env = process.env, signal, timeoutMs, resolveManifest = name => require.resolve(`${name}/package.json`) } = {}) {
  const external = binary !== undefined || env.MCODEX_NATIVE_BIN !== undefined;
  binary ??= await resolveNative({ env });
  let packageVersion = null;
  let expectedVersion = null;
  if (!external) {
    const name = nativePackage();
    let metadata;
    try { metadata = JSON.parse(await readFile(resolveManifest(name), 'utf8')); }
    catch { throw new Error('The bundled native transport metadata is invalid. Reinstall mcodex with optional dependencies enabled.'); }
    packageVersion = metadata.version;
    expectedVersion = metadata.mcodex?.transportVersion;
    if (metadata.name !== name || packageVersion !== wrapperManifest.optionalDependencies[name] || !nativeVersionPattern.test(expectedVersion ?? '')) {
      throw new Error('The bundled native transport package does not match mcodex. Reinstall mcodex with optional dependencies enabled.');
    }
  }
  const output = await commandVersion(binary, ['--version'], { env, signal, timeoutMs, subject: 'native transport' });
  const match = output.match(/^mlab-gateway (\S+)\s*$/);
  if (!match || !nativeVersionPattern.test(match[1])) throw new Error('The native transport returned an invalid version.');
  if (expectedVersion !== null && match[1] !== expectedVersion) throw new Error('The bundled native transport binary does not match its package metadata. Reinstall mcodex.');
  return { version: match[1], source: external ? 'external' : 'bundled', path: await realpath(binary), packageVersion, expectedVersion,
    matchesExpected: expectedVersion === null ? null : match[1] === expectedVersion };
}

export function resolveCodex() {
  return bundledCodexEntry();
}

async function stopProcess(child, exitSignal = 'SIGTERM') {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
    child.kill(exitSignal);
  });
}

export async function startTunnel(state, { binary, timeoutMs = 30000, signal, allowCachedModels = false } = {}) {
  const startedAt = performance.now();
  const native = await inspectNative({ binary, signal });
  binary = native.path;
  const directory = await mkdtemp(path.join(tmpdir(), 'mcodex-'));
  await chmod(directory, 0o700);
  const key = randomBytes(32).toString('base64url');
  const keyFile = path.join(directory, 'local.key');
  const configFile = path.join(directory, 'client.toml');
  let child;
  let closed = false;
  let failure;
  let origin;
  const lifetime = new AbortController();
  const requestSignal = ms => AbortSignal.any([lifetime.signal, AbortSignal.timeout(ms), ...(signal ? [signal] : [])]);
  let catalogRefresh;
  let cacheIdentity;
  let cached;
  const close = async () => {
    if (closed) return;
    closed = true;
    lifetime.abort();
    await catalogRefresh;
    await stopProcess(child);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    cacheIdentity = await modelCacheIdentity(state).catch(() => null);
    if (allowCachedModels) {
      cached = await loadModelCache(state);
      if (cached?.identity !== cacheIdentity
          || (state.model && !cached?.models.some(model => model.id === state.model))) cached = null;
    }
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
    let lastConnectionFailure;
    const rejectHandshake = async observed => {
      lastConnectionFailure = observed;
      if (observed?.stage === 'handshake'
          && (observed.code === 'handshake_invalid'
            || (observed.code === 'handshake_rejected' && [400, 401, 403, 404, 405, 426].includes(observed.status)))) {
        await clearModelCache(state, cacheIdentity);
        throw Object.assign(new Error(`Gateway connection rejected: ${formatConnectionFailure(observed)}. Check the gateway endpoint, connection Token and supported tunnel protocol.`), { code: 'MCODEX_CONNECTION_REJECTED' });
      }
    };
    const readCatalog = async ms => {
      const response = await fetch(`${origin}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` }, signal: requestSignal(ms),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403].includes(response.status)) {
          await clearModelCache(state, cacheIdentity);
          throw Object.assign(new Error('Gateway authentication failed. Run mcodex login with a valid connection Token.'), { code: 'MCODEX_AUTH_FAILED' });
        }
        return { status: response.status };
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > 2 * 1024 * 1024) throw Object.assign(new Error('The gateway returned an invalid model catalog.'), { code: 'MCODEX_CATALOG_INVALID' });
        chunks.push(Buffer.from(chunk));
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
      if (!Array.isArray(data?.data)) throw Object.assign(new Error('The gateway returned an invalid model catalog.'), { code: 'MCODEX_CATALOG_INVALID' });
      return { status: response.status, models: data.data, scope: response.headers.get('x-mlab-catalog-scope') };
    };
    const persistCatalog = async catalog => {
      if (!allowCachedModels || !cacheIdentity || !catalogScopePattern.test(catalog.scope ?? '') || closed) return;
      // HTTP discovery and the currently authenticated WSS must agree. A
      // reconnect/account change must never put a catalog under an old scope.
      const ready = await readDiagnostics({ origin, key }, { signal: requestSignal(500), timeoutMs: 500 });
      if (ready.connected && ready.catalog_scope === catalog.scope && !closed) {
        if (catalog.models.length === 0) await clearModelCache(state, cacheIdentity);
        else await saveModelCache(state, { scope: catalog.scope, models: catalog.models, identity: cacheIdentity });
      }
    };
    const finish = (models, modelsSource) => ({
      origin, key, models, modelsSource, connectionMs: performance.now() - startedAt,
      child, close, directory, native, catalogRefresh,
    });
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (failure) throw failure;
      if (origin) {
        try {
          if (cached && Date.now() - cached.savedAt >= MODEL_CACHE_MAX_AGE_MS) cached = null;
          if (cached) {
            let ready;
            try {
              ready = await readDiagnostics({ origin, key }, { signal: requestSignal(500), timeoutMs: Math.min(500, Math.max(1, deadline - Date.now())) });
            } catch { signal?.throwIfAborted(); }
            if (ready?.available && !ready.connected) {
              await rejectHandshake(ready.last_connection_error);
              await delay(100, undefined, { signal });
              continue;
            }
            if (ready?.connected && ready.catalog_scope === cached.scope
                && Date.now() - cached.savedAt < MODEL_CACHE_MAX_AGE_MS) {
              const models = cached.models;
              catalogRefresh = (async () => {
                const catalog = await readCatalog(3000);
                if (catalog.models) await persistCatalog(catalog);
              })().catch(() => {
                // Optional refresh never replays inference or writes into the
                // TUI. Authentication rejection has already invalidated cache.
              });
              return finish(models, 'cache');
            }
            // Legacy/malformed diagnostics or a changed account use the
            // original authenticated discovery path, never an offline launch.
            cached = null;
          }
          const catalog = await readCatalog(Math.min(3000, Math.max(1, deadline - Date.now())));
          lastStatus = catalog.status;
          if (catalog.models) {
            signal?.throwIfAborted();
            catalogRefresh = persistCatalog(catalog).catch(() => {});
            return finish(catalog.models, 'gateway');
          }
          // A successful reconnect clears the native observation. Do not keep a
          // stale handshake failure when the remaining fault is upstream HTTP.
          await rejectHandshake(await readConnectionFailure(origin, key, { signal, timeoutMs: Math.min(500, Math.max(1, deadline - Date.now())) }));
        } catch (error) {
          if (signal?.aborted) throw error;
          if (['MCODEX_AUTH_FAILED', 'MCODEX_CONNECTION_REJECTED', 'MCODEX_CATALOG_INVALID'].includes(error.code)) throw error;
        }
      }
      await delay(100, undefined, { signal });
    }
    throw new Error(lastConnectionFailure
      ? `Gateway connection failed: ${formatConnectionFailure(lastConnectionFailure)}. Check the gateway route or retry after its admission limit clears.`
      : `Gateway connection timed out${lastStatus ? ` (HTTP ${lastStatus})` : ''}. Check the server address, connection Token, TLS and network.`);
  } catch (error) {
    await close();
    throw error;
  }
}

// The official CLI may honor system proxy settings even for the loopback
// facade. Scope the bypass to its child process; keep native upstream routing
// and all existing user exclusions intact, including both spelling variants.
export function codexEnvironment(localKey, env = process.env) {
  const exclusions = new Set([env.NO_PROXY, env.no_proxy]
    .flatMap(value => typeof value === 'string' ? value.split(',').map(entry => entry.trim()).filter(Boolean) : []));
  for (const host of ['127.0.0.1', 'localhost', '::1']) exclusions.add(host);
  const bypass = [...exclusions].join(',');
  return { ...env, MCODEX_LOCAL_KEY: localKey, NO_PROXY: bypass, no_proxy: bypass };
}

export async function runCodex(tunnel, args, { model, engine, codexEntry, signal } = {}) {
  const cwd = process.cwd();
  const { providerArguments, codexArguments } = await import('./provider.js');
  signal?.throwIfAborted();
  engine ??= codexEntry ? engineCommand(codexEntry) : await resolveEngine({ signal });
  signal?.throwIfAborted();
  if (tunnel.child.exitCode !== null || tunnel.child.signalCode !== null) throw new Error('The native transport stopped before Codex could start.');
  return withShellEnvironment(codexEnvironment(tunnel.key), async env => {
    signal?.throwIfAborted();
    const child = spawn(engine.command, [...engine.prefix, ...codexArguments(providerArguments({ origin: tunnel.origin, model, engine }), args)], {
      cwd,
      stdio: 'inherit',
      env,
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
  });
}
