import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const CONFIG_NAME = 'config.json';
const TOKEN_NAME = 'server.key';
const MODELS_NAME = 'models.json';
const MAX_CONFIG_BYTES = 8192;
const MAX_TOKEN_BYTES = 4096;
const MAX_MODELS_BYTES = 2 * 1024 * 1024;
export const MODEL_CACHE_MAX_AGE_MS = 60_000;
export const catalogScopePattern = /^v1-[0-9a-f]{64}$/;

function stateError(message, code = 'MCODEX_STATE_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** The wrapper's state directory, independent of Codex's own configuration. */
export function stateDirectory(env = process.env) {
  if (env.MCODEX_CONFIG_DIR?.trim()) {
    return path.resolve(env.MCODEX_CONFIG_DIR);
  }
  const base = env.XDG_CONFIG_HOME?.trim()
    ? path.resolve(env.XDG_CONFIG_HOME)
    : path.join(os.homedir(), '.config');
  return path.join(base, 'mcodex');
}

/** Validate and normalize a public WSS endpoint without embedded credentials. */
export function validateServer(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw stateError('A WSS server URL is required.');
  }
  const input = value.trim();
  if (input.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(input)) {
    throw stateError('The server URL contains invalid characters.');
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    throw stateError('The server must be a valid wss:// URL.');
  }
  if (url.protocol !== 'wss:' || !url.hostname) {
    throw stateError('The server must be a valid wss:// URL.');
  }
  if (url.username || url.password || input.includes('?') || input.includes('#')) {
    throw stateError('Use a WSS URL without credentials, query parameters, or fragments.');
  }
  return url.href;
}

/** Return a canonical connection token; errors never include the supplied value. */
export function validateToken(value) {
  if (typeof value !== 'string') {
    throw stateError('The connection token must be a string.');
  }
  const token = value.trim();
  if (token.length < 32 || token.length > MAX_TOKEN_BYTES || !/^[A-Za-z0-9._~-]+$/u.test(token)) {
    throw stateError('The connection token must contain 32–4096 ASCII letters, digits, or . _ ~ - characters.');
  }
  return token;
}

function validateModel(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw stateError('The saved model name is invalid.');
  }
  return value.trim();
}

function requireOwned(entry, description) {
  if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) {
    throw stateError(`${description} must belong to the current user.`);
  }
}

async function inspectDirectory(directory, { missing = false, privateMode = true } = {}) {
  let entry;
  try {
    entry = await fs.lstat(directory);
  } catch (error) {
    if (error.code === 'ENOENT' && missing) return undefined;
    if (error.code === 'ENOENT') {
      throw stateError('No saved connection. Run mcodex login first.', 'MCODEX_NOT_CONFIGURED');
    }
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw stateError('The mcodex state path must be a directory, not a symbolic link.');
  }
  requireOwned(entry, 'The mcodex state directory');
  if (privateMode && (entry.mode & 0o777) !== 0o700) {
    throw stateError('The mcodex state directory must have permissions 0700. Run mcodex login to repair it.');
  }
  return entry;
}

function inspectFile(entry, description, privateMode) {
  if (entry.isSymbolicLink() || !entry.isFile() || entry.nlink !== 1) {
    throw stateError(`${description} must be a regular file without symbolic or hard links.`);
  }
  requireOwned(entry, description);
  if (privateMode && (entry.mode & 0o777) !== 0o600) {
    throw stateError(`${description} must have permissions 0600. Run mcodex login to repair it.`);
  }
}

async function inspectManagedFile(filename, description, { missing = false, privateMode = true } = {}) {
  try {
    const entry = await fs.lstat(filename);
    inspectFile(entry, description, privateMode);
    return entry;
  } catch (error) {
    if (error.code === 'ENOENT' && missing) return undefined;
    if (error.code === 'ENOENT') {
      throw stateError('The saved connection is incomplete. Run mcodex login again.', 'MCODEX_NOT_CONFIGURED');
    }
    throw error;
  }
}

async function readPrivateFile(filename, description, limit) {
  await inspectManagedFile(filename, description);
  let handle;
  try {
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    const entry = await handle.stat();
    inspectFile(entry, description, true);
    if (entry.size > limit) throw stateError(`${description} is too large.`);
    return await handle.readFile({ encoding: 'utf8' });
  } catch (error) {
    if (error.code === 'ELOOP') throw stateError(`${description} cannot be a symbolic link.`);
    throw error;
  } finally {
    await handle?.close();
  }
}

async function atomicWrite(directory, filename, value, stillCurrent) {
  const temporary = path.join(directory, `.${filename}.${randomBytes(16).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(value, { encoding: 'utf8' });
    await handle.sync();
    const written = await handle.stat();
    await handle.close();
    handle = undefined;
    if (stillCurrent && !await stillCurrent()) return false;
    const destination = path.join(directory, filename);
    await fs.rename(temporary, destination);
    if (stillCurrent && !await stillCurrent()) {
      // Logout can run while rename is in progress. Do not leave discovery data
      // behind, and avoid removing a different writer's replacement.
      const current = await fs.lstat(destination).catch(() => null);
      if (current?.dev === written.dev && current?.ino === written.ino) {
        await fs.unlink(destination).catch(() => {});
      }
      return false;
    }
    return true;
  } finally {
    await handle?.close();
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** Read validated metadata, leaving the secret in its private key file. */
export async function loadState(directory) {
  directory = path.resolve(directory);
  await inspectDirectory(directory);
  const tokenFile = path.join(directory, TOKEN_NAME);
  const [configText, token] = await Promise.all([
    readPrivateFile(path.join(directory, CONFIG_NAME), 'The mcodex configuration', MAX_CONFIG_BYTES),
    readPrivateFile(tokenFile, 'The mcodex connection key', MAX_TOKEN_BYTES + 1),
  ]);
  let config;
  try {
    config = JSON.parse(configText);
  } catch {
    throw stateError('The saved configuration is invalid JSON. Run mcodex login again.');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || config.version !== 1) {
    throw stateError('The saved configuration format is unsupported. Run mcodex login again.');
  }
  // Legacy or edited configuration must never become an alternative secret store.
  if (Object.keys(config).some((key) => !['version', 'server', 'model'].includes(key))) {
    throw stateError('The saved configuration contains unsupported fields. Run mcodex login again.');
  }
  validateToken(token);
  return { server: validateServer(config.server), model: validateModel(config.model), tokenFile };
}

/** Store endpoint/model metadata and the connection key in separate private files. */
export async function saveState(directory, { server, token, model }) {
  const config = { version: 1, server: validateServer(server), model: validateModel(model) };
  const canonicalToken = validateToken(token);
  directory = path.resolve(directory);

  const existing = await inspectDirectory(directory, { missing: true, privateMode: false });
  if (!existing) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await inspectDirectory(directory, { privateMode: false });
  }
  await fs.chmod(directory, 0o700);
  await Promise.all([
    inspectManagedFile(path.join(directory, CONFIG_NAME), 'The mcodex configuration', { missing: true, privateMode: false }),
    inspectManagedFile(path.join(directory, TOKEN_NAME), 'The mcodex connection key', { missing: true, privateMode: false }),
  ]);
  await atomicWrite(directory, TOKEN_NAME, `${canonicalToken}\n`);
  await atomicWrite(directory, CONFIG_NAME, `${JSON.stringify(config, null, 2)}\n`);
  // Login explicitly revalidates the catalog; never carry discovery data from
  // a previous account or credential into a new saved connection.
  await fs.unlink(path.join(directory, MODELS_NAME)).catch(() => {});
  return { server: config.server, model: config.model, tokenFile: path.join(directory, TOKEN_NAME) };
}

/** Remove only mcodex's own state files, preserving unrelated directory contents. */
export async function deleteState(directory) {
  directory = path.resolve(directory);
  if (!await inspectDirectory(directory, { missing: true, privateMode: false })) return;
  const filenames = [CONFIG_NAME, TOKEN_NAME].map((name) => path.join(directory, name));
  await Promise.all(filenames.map((filename) => inspectManagedFile(filename, 'The mcodex state file', { missing: true, privateMode: false })));
  await Promise.all(filenames.map((filename) => fs.unlink(filename).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  })));
  // Optional/corrupt cache must never prevent removal of credentials. Unlink
  // removes a link itself, without following or modifying its target.
  await fs.unlink(path.join(directory, MODELS_NAME)).catch(() => {});
  await fs.rmdir(directory).catch((error) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
  });
}

/** Revalidate private file permissions before using a Token for a TLS probe. */
export async function readConnectionToken(state) {
  return validateToken((await readPrivateFile(state.tokenFile, 'The mcodex connection key', MAX_TOKEN_BYTES + 1)).trim());
}

export async function modelCacheIdentity(state) {
  const token = await readConnectionToken(state);
  return createHash('sha256').update(JSON.stringify([validateServer(state.server), token])).digest('hex');
}

function validCatalog(models) {
  return Array.isArray(models) && models.length > 0
    && models.every(model => model && typeof model.id === 'string'
      && model.id.length > 0 && model.id.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(model.id));
}

/** Optional discovery data, never proof of authentication or model access. */
export async function loadModelCache(state, { now = Date.now() } = {}) {
  try {
    const directory = path.dirname(state.tokenFile);
    await inspectDirectory(directory);
    const value = JSON.parse(await readPrivateFile(path.join(directory, MODELS_NAME), 'The mcodex model cache', MAX_MODELS_BYTES));
    if (value?.version !== 1 || !catalogScopePattern.test(value.scope ?? '')
        || !Number.isSafeInteger(value.savedAt) || value.savedAt > now
        || now - value.savedAt >= MODEL_CACHE_MAX_AGE_MS || !validCatalog(value.models)
        || value.identity !== await modelCacheIdentity(state)) return null;
    return value;
  } catch {
    // Corrupt, unsafe or missing optional cache falls back to authenticated
    // discovery. It must never prevent login or become an alternative key file.
    return null;
  }
}

export async function saveModelCache(state, { scope, models, identity }, { now = Date.now() } = {}) {
  try {
    if (!catalogScopePattern.test(scope ?? '') || !validCatalog(models)
        || identity !== await modelCacheIdentity(state)) return false;
    const directory = path.dirname(state.tokenFile);
    // Do not recreate state after logout, or write through an unsafe cache.
    await inspectDirectory(directory);
    await inspectManagedFile(path.join(directory, MODELS_NAME), 'The mcodex model cache', { missing: true });
    const value = JSON.stringify({ version: 1, identity, scope, savedAt: now, models });
    if (Buffer.byteLength(value) > MAX_MODELS_BYTES) return false;
    return await atomicWrite(directory, MODELS_NAME, value + '\n',
      async () => identity === await modelCacheIdentity(state).catch(() => null));
  } catch {
    return false;
  }
}

export async function clearModelCache(state, identity) {
  try {
    const directory = path.dirname(state.tokenFile);
    await inspectDirectory(directory);
    const filename = path.join(directory, MODELS_NAME);
    const value = JSON.parse(await readPrivateFile(filename, 'The mcodex model cache', MAX_MODELS_BYTES));
    if (value.identity === identity) await fs.unlink(filename);
  } catch {
    // Cache invalidation is best effort; a rejected connection can never use it.
  }
}
