import { readFile, writeFile, mkdir, lstat, open, rename, rm, mkdtemp } from 'node:fs/promises';
import { createPublicKey, verify, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRuntime, fileDigest, safePath, verifyTree } from './runtime-archive.js';
import { hasHTTPProxy, proxyWorkerFetch } from './runtime-network.js';

export const launcherApi = 1;
export const defaultPolicy = JSON.parse(await readFile(new URL('./runtime-policy.json', import.meta.url), 'utf8'));
const launcher = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digestPattern = /^[a-f0-9]{64}$/;
const directoryPattern = /^\d+\.\d+\.\d+-[a-f0-9]{64}(?:-[a-f0-9]{12})?$/;
const targets = ['linux-x64', 'linux-arm64', 'darwin-arm64'];
const maxArchiveBytes = 256 * 1024 * 1024;
const maxExpandedBytes = 768 * 1024 * 1024;

export function compareVersions(a, b) {
  if (!versionPattern.test(a) || !versionPattern.test(b)) throw new Error('Runtime versions must be exact stable semantic versions.');
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

export function runtimeDirectory(env = process.env) {
  if (env.MCODEX_RUNTIME_DIR?.trim()) return path.resolve(env.MCODEX_RUNTIME_DIR);
  const base = env.XDG_DATA_HOME?.trim() ? path.resolve(env.XDG_DATA_HOME) : path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'mcodex', 'runtime');
}

function artifactURL(value, policy, version) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid runtime asset URL.'); }
  const prefix = `https://github.com/${policy.repository}/releases/download/runtime-v${version}/`;
  if (!url.href.startsWith(prefix) || url.username || url.password || url.search || url.hash ||
      !/^[A-Za-z0-9_.-]+\.tar\.gz$/.test(url.pathname.slice(new URL(prefix).pathname.length))) throw new Error('Runtime assets must belong to the configured immutable GitHub release.');
  return url.href;
}

export function verifyEnvelope(envelope, { policy = defaultPolicy, now = Date.now(), installed = false } = {}) {
  if (!envelope || typeof envelope.payload !== 'string' || envelope.payload.length > 400000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.payload) || typeof envelope.signature !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.signature) || typeof envelope.keyId !== 'string' ||
      !Object.hasOwn(policy.publicKeys, envelope.keyId)) throw new Error('Runtime manifest has an unknown signing key or invalid envelope.');
  const bytes = Buffer.from(envelope.payload, 'base64'), signature = Buffer.from(envelope.signature, 'base64');
  const key = createPublicKey(policy.publicKeys[envelope.keyId]);
  if (key.asymmetricKeyType !== 'ed25519' || signature.length !== 64 || !verify(null, bytes, key, signature)) throw new Error('Runtime manifest signature verification failed.');
  let manifest;
  try { manifest = JSON.parse(bytes); } catch { throw new Error('Runtime manifest is invalid JSON.'); }
  if (manifest.schema !== 1 || manifest.launcherApi !== launcherApi || !versionPattern.test(manifest.version) ||
      !Number.isFinite(Date.parse(manifest.issuedAt)) || !Number.isFinite(Date.parse(manifest.expiresAt)) ||
      Date.parse(manifest.issuedAt) > now + 300000 || Date.parse(manifest.expiresAt) <= Date.parse(manifest.issuedAt) ||
      (!installed && Date.parse(manifest.expiresAt) <= now)) throw new Error('Runtime manifest is expired or incompatible with this launcher.');
  for (const target of targets) {
    const a = manifest.artifacts?.[target];
    if (!a || !digestPattern.test(a.sha256) || !Number.isSafeInteger(a.size) || a.size < 1 || a.size > maxArchiveBytes ||
        !a.files || typeof a.files !== 'object' || Array.isArray(a.files) || Object.keys(a.files).length > 5000) throw new Error('Runtime manifest contains invalid artifact metadata.');
    artifactURL(a.url, policy, manifest.version);
    let size = 0;
    for (const [name, item] of Object.entries(a.files)) {
      if (!safePath(name) || !item || !digestPattern.test(item.sha256) || !Number.isSafeInteger(item.size) || item.size < 0 || typeof item.executable !== 'boolean') throw new Error('Runtime manifest contains invalid file metadata.');
      size += item.size;
    }
    if (size > maxExpandedBytes || !a.files['src/cli.js'] || !a.files['package.json'] || !a.files['entry.mjs']) throw new Error('Runtime manifest is incomplete or too large.');
  }
  return manifest;
}

async function owned(filename, { directory = false, missing = false } = {}) {
  let entry;
  try { entry = await lstat(filename); } catch (e) { if (missing && e.code === 'ENOENT') return; throw e; }
  if (entry.isSymbolicLink() || (directory ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1) ||
      (typeof process.getuid === 'function' && entry.uid !== process.getuid()) || (entry.mode & 0o022)) throw new Error('Runtime cache must be owned by the current user and cannot contain writable shared paths or links.');
  return entry;
}

async function readJSON(filename, limit) {
  const entry = await owned(filename);
  if (entry.size > limit) throw new Error('Runtime metadata exceeded its size limit.');
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function readState(directory) {
  if (!await owned(directory, { directory: true, missing: true })) return { schema: 1, current: null, previous: null, highestVersion: '0.0.0', highestArtifact: null };
  const filename = path.join(directory, 'state.json');
  if (!await owned(filename, { missing: true })) return { schema: 1, current: null, previous: null, highestVersion: '0.0.0', highestArtifact: null };
  const state = await readJSON(filename, 8192);
  if (state.schema !== 1 || ![state.current, state.previous].every(value => value === null || typeof value === 'string' && directoryPattern.test(value)) ||
      !versionPattern.test(state.highestVersion) || !(state.highestArtifact === null || digestPattern.test(state.highestArtifact))) throw new Error('Runtime selection metadata is invalid.');
  return state;
}

async function atomicJSON(directory, name, value) {
  const temporary = path.join(directory, `.${name}.${randomBytes(12).toString('hex')}`);
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path.join(directory, name)); }
  finally { await rm(temporary, { force: true }); }
}

async function installedRuntime(directory, id, policy, target) {
  if (!directoryPattern.test(id)) throw new Error('Invalid installed runtime identifier.');
  const release = path.join(directory, 'releases', id);
  await owned(path.join(directory, 'releases'), { directory: true });
  await owned(release, { directory: true });
  const manifest = verifyEnvelope(await readJSON(path.join(release, 'release.json'), 450000), { policy, installed: true });
  const artifact = manifest.artifacts[target];
  const prefix = `${manifest.version}-${artifact?.sha256}`;
  if (!artifact || id !== prefix && !id.startsWith(`${prefix}-`)) throw new Error('Installed runtime does not match this platform or manifest.');
  const root = path.join(release, 'runtime');
  await owned(root, { directory: true });
  await verifyTree(root, artifact.files);
  const pkg = await readJSON(path.join(root, 'package.json'), 65536);
  if (pkg.name !== '@m9rco/mcodex-runtime' || pkg.version !== manifest.version || pkg.type !== 'module') throw new Error('Installed runtime package identity is invalid.');
  return { source: 'managed', version: manifest.version, entry: path.join(root, 'src', 'cli.js'), directory: root, id };
}

export async function selectRuntime({ directory = runtimeDirectory(), policy = defaultPolicy,
  target = `${process.platform}-${process.arch}`, onWarning = () => {} } = {}) {
  const baseline = { source: 'bundled', version: launcher.version, entry: fileURLToPath(new URL('./cli.js', import.meta.url)), id: null };
  let state;
  try { state = await readState(directory); }
  catch { onWarning('Runtime selection is invalid; using the bundled baseline.'); return baseline; }
  for (const id of [state.current, state.previous]) {
    if (id === null) return baseline;
    try { return await installedRuntime(directory, id, policy, target); }
    catch { onWarning('Cached runtime verification failed; using a previously verified version or the bundled baseline.'); }
  }
  return baseline;
}

// Redirects never receive auth headers. Only public registry/GitHub asset hosts
// are accepted, including GitHub's signed release download CDN.
export async function publicResponse(url, { fetchImpl = fetch, signal, timeoutMs = 60000, allowNotFound = false, accept = 'application/octet-stream' } = {}) {
  signal?.throwIfAborted();
  let current = new URL(url);
  const hosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'registry.npmjs.org']);
  const requestSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  for (let hop = 0; hop <= 5; hop++) {
    if (current.protocol !== 'https:' || !hosts.has(current.hostname) || current.username || current.password || current.port) throw new Error('Unsupported public download origin.');
    const download = fetchImpl === fetch && hasHTTPProxy() ? proxyWorkerFetch : fetchImpl;
    const response = await download(current.href, { redirect: 'manual', credentials: 'omit', signal: requestSignal, headers: { Accept: accept } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Invalid public download redirect.');
      current = new URL(location, current);
      continue;
    }
    if (response.status === 404 && allowNotFound) return response;
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Public download failed (HTTP ${response.status}).`); }
    return response;
  }
  throw new Error('Too many public download redirects.');
}

async function smallResponse(response, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) { await response.body.cancel().catch(() => {}); throw new Error('Runtime manifest exceeded its size limit.'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks)); } catch { throw new Error('Runtime channel returned invalid JSON.'); }
}

export async function checkRuntimeUpdate({ directory = runtimeDirectory(), policy = defaultPolicy,
  target = `${process.platform}-${process.arch}`, fetchImpl = fetch, signal } = {}) {
  if (!targets.includes(target)) throw new Error('Unsupported runtime platform.');
  const expected = `https://github.com/${policy.repository}/releases/download/runtime-stable/channel.json`;
  if (policy.channelURL !== expected) throw new Error('Invalid runtime channel policy.');
  const envelope = await smallResponse(await publicResponse(policy.channelURL, { fetchImpl, signal, accept: 'application/json' }), 450000);
  const manifest = verifyEnvelope(envelope, { policy });
  const artifact = manifest.artifacts[target];
  const state = await readState(directory);
  const comparison = compareVersions(manifest.version, state.highestVersion);
  if (comparison < 0 || comparison === 0 && state.highestArtifact !== null && state.highestArtifact !== artifact.sha256) throw new Error('Runtime channel attempted a downgrade or replacement of an existing version.');
  const selected = await selectRuntime({ directory, policy, target });
  const difference = compareVersions(manifest.version, selected.version);
  return { envelope, manifest, artifact, selected, available: difference > 0 || difference === 0 && selected.source === 'bundled' };
}

export async function healthCheck(root, { signal, timeoutMs = 30000 } = {}) {
  const env = { ...process.env };
  for (const key of ['MCODEX_CODEX_BIN', 'MCODEX_NATIVE_BIN', 'MCODEX_LOCAL_KEY', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'entry.mjs'), 'doctor', '--local'], { cwd: process.cwd(), env, stdio: 'ignore', detached: true });
    const stop = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (code === 0 && !signal?.aborted) resolve(); else reject(new Error('Runtime local health check failed; the active version was not changed.'));
    });
    if (signal?.aborted) stop();
  });
}

async function withLock(directory, action) {
  if (!await owned(directory, { directory: true, missing: true })) await mkdir(directory, { recursive: true, mode: 0o700 });
  await owned(directory, { directory: true });
  const lock = path.join(directory, '.update.lock');
  let handle;
  try { handle = await open(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another runtime update is locked. If its process has exited, remove the runtime cache .update.lock file.'); throw error; }
  try { await handle.writeFile(`${process.pid}\n`); return await action(); }
  finally { await handle.close(); await rm(lock, { force: true }); }
}

export async function updateRuntime(options = {}) {
  const directory = options.directory ?? runtimeDirectory();
  const policy = options.policy ?? defaultPolicy, target = options.target ?? `${process.platform}-${process.arch}`;
  return withLock(directory, async () => {
    const candidate = await checkRuntimeUpdate({ ...options, directory, policy, target });
    if (!candidate.available) return { changed: false, version: candidate.selected.version };
    const { envelope, manifest, artifact } = candidate;
    const releases = path.join(directory, 'releases');
    await mkdir(releases, { recursive: true, mode: 0o700 });
    await owned(releases, { directory: true });
    const state = await readState(directory), baseId = `${manifest.version}-${artifact.sha256}`;
    let cached;
    for (const id of new Set([baseId, state.current, state.previous])) {
      if (id !== null && (id === baseId || id.startsWith(`${baseId}-`))) {
        try { cached = await installedRuntime(directory, id, policy, target); break; } catch { /* download a fresh immutable installation */ }
      }
    }
    if (cached) {
      await (options.healthCheckImpl ?? healthCheck)(cached.directory, { signal: options.signal });
      options.signal?.throwIfAborted();
      await atomicJSON(directory, 'state.json', { schema: 1, current: cached.id, previous: candidate.selected.id,
        highestVersion: manifest.version, highestArtifact: artifact.sha256 });
      return { changed: true, version: manifest.version, previous: state.current };
    }
    const temporary = await mkdtemp(path.join(directory, '.download-'));
    try {
      const archive = path.join(temporary, 'runtime.tar.gz');
      const handle = await open(archive, 'wx', 0o600);
      let size = 0;
      try {
        const response = await publicResponse(artifactURL(artifact.url, policy, manifest.version), { ...options, timeoutMs: 300000 });
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > artifact.size) throw new Error('Runtime archive exceeded its signed size.');
          await handle.writeFile(chunk);
        }
      } finally { await handle.close(); }
      if (size !== artifact.size || await fileDigest(archive) !== artifact.sha256) throw new Error('Runtime archive checksum or size mismatch.');
      const root = path.join(temporary, 'runtime');
      await mkdir(root, { mode: 0o700 });
      await extractRuntime(archive, root, artifact.files);
      const pkg = await readJSON(path.join(root, 'package.json'), 65536);
      if (pkg.name !== '@m9rco/mcodex-runtime' || pkg.version !== manifest.version || pkg.type !== 'module') throw new Error('Runtime package identity does not match its release.');
      await (options.healthCheckImpl ?? healthCheck)(root, { signal: options.signal });
      options.signal?.throwIfAborted();
      await rm(archive);
      await writeFile(path.join(temporary, 'release.json'), JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
      let id = `${manifest.version}-${artifact.sha256}`, destination = path.join(releases, id), reusable = false;
      const exists = await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (exists) {
        try { await installedRuntime(directory, id, policy, target); reusable = true; }
        catch {
          // Repair corruption by adding a new immutable installation. Existing
          // directories stay in place for processes that already selected them.
          id += `-${randomBytes(6).toString('hex')}`;
          destination = path.join(releases, id);
        }
      }
      if (!reusable) await rename(temporary, destination);
      await atomicJSON(directory, 'state.json', { schema: 1, current: id, previous: candidate.selected.id,
        highestVersion: manifest.version, highestArtifact: artifact.sha256 });
      return { changed: true, version: manifest.version, previous: state.current };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}

export async function rollbackRuntime({ directory = runtimeDirectory(), policy = defaultPolicy,
  target = `${process.platform}-${process.arch}`, bundled = false } = {}) {
  return withLock(directory, async () => {
    let state;
    try { state = await readState(directory); }
    catch (error) {
      if (!bundled) throw error;
      state = { schema: 1, current: null, previous: null, highestVersion: launcher.version, highestArtifact: null };
    }
    const id = bundled ? null : state.previous;
    const selected = id === null ? { version: launcher.version } : await installedRuntime(directory, id, policy, target);
    await atomicJSON(directory, 'state.json', { ...state, current: id, previous: state.current });
    return { version: selected.version, source: id === null ? 'bundled' : 'managed' };
  });
}
