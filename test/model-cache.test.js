import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, chmod, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startTunnel } from '../src/tunnel.js';
import { saveState, deleteState, modelCacheIdentity, saveModelCache, loadModelCache, MODEL_CACHE_MAX_AGE_MS } from '../src/state.js';
import { readDiagnostics } from '../src/latency.js';

const binary = fileURLToPath(new URL('fixtures/transport-cache.mjs', import.meta.url));
await chmod(binary, 0o755);
const scope = 'v1-' + 'a'.repeat(64);
const token = 'fixture-cache-token-0123456789-abcdefgh';
const cachedModels = [{ id: 'cached-model' }];

async function fixture(t, mode = 'normal') {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcodex-catalog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await saveState(directory, { server: `wss://test.invalid/${mode}`, token });
  const identity = await modelCacheIdentity(state);
  return { directory, state, identity };
}

async function prime(context, options) {
  assert.equal(await saveModelCache(context.state, { scope, models: cachedModels, identity: context.identity }, options), true);
}

async function waitFor(read, predicate = value => value) {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    const value = await read().catch(() => null);
    if (predicate(value)) return value;
    await delay(10);
  }
  throw new Error('fixture condition not reached');
}
const events = origin => fetch(origin + '/test/events').then(response => response.json());
const release = origin => fetch(origin + '/test/release');
const start = (state, options) => startTunnel(state, { binary, timeoutMs: 5000, allowCachedModels: true, ...options });

test('catalog cache is private, bounded and isolated by endpoint and connection credential', async t => {
  const context = await fixture(t);
  const now = Date.now();
  await prime(context, { now });
  const filename = path.join(context.directory, 'models.json');
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal((await readFile(filename, 'utf8')).includes(token), false);
  assert.deepEqual((await loadModelCache(context.state, { now })).models, cachedModels);
  assert.equal(await loadModelCache(context.state, { now: now + MODEL_CACHE_MAX_AGE_MS }), null);
  assert.equal(await loadModelCache(context.state, { now: now - 1 }), null);
  assert.equal(await loadModelCache({ ...context.state, server: 'wss://different.invalid/normal' }), null);
  await writeFile(context.state.tokenFile, 'other-fixture-token-0123456789-abcdefgh');
  assert.equal(await loadModelCache(context.state), null);
  assert.equal(await saveModelCache(context.state, { scope, models: cachedModels, identity: context.identity }), false);
});

test('unsafe or corrupt optional cache is ignored without modifying a linked target', async t => {
  const context = await fixture(t);
  await prime(context);
  const filename = path.join(context.directory, 'models.json');
  await chmod(filename, 0o644);
  assert.equal(await loadModelCache(context.state), null);
  await unlink(filename);
  const target = path.join(context.directory, 'outside');
  await writeFile(target, 'preserve', { mode: 0o600 });
  await symlink(target, filename);
  assert.equal(await loadModelCache(context.state), null);
  assert.equal(await saveModelCache(context.state, { scope, models: cachedModels, identity: context.identity }), false);
  assert.equal(await readFile(target, 'utf8'), 'preserve');
  await unlink(filename);
  await writeFile(filename, '{broken', { mode: 0o600 });
  assert.equal(await loadModelCache(context.state), null);
});

test('re-login and logout invalidate discovery cache and late refresh cannot recreate logged-out state', async t => {
  const context = await fixture(t);
  await prime(context);
  await saveState(context.directory, { server: context.state.server, token });
  assert.equal(await loadModelCache(context.state), null);
  await prime(context);
  await deleteState(context.directory);
  assert.equal(await saveModelCache(context.state, { scope, models: cachedModels, identity: context.identity }), false);
  await assert.rejects(stat(context.directory), { code: 'ENOENT' });
});

test('authenticated cache hit starts while upstream discovery is blocked, then refreshes in background', async t => {
  const context = await fixture(t, 'blocked');
  await prime(context);
  const tunnel = await start(context.state);
  t.after(() => tunnel.close());
  assert.equal(tunnel.modelsSource, 'cache');
  assert.deepEqual(tunnel.models, cachedModels);
  const pending = await waitFor(() => events(tunnel.origin), value => value?.pending === 1);
  assert.equal(pending.requests, 1);
  await release(tunnel.origin);
  await tunnel.catalogRefresh;
  assert.deepEqual((await loadModelCache(context.state)).models, [{ id: 'gateway-model' }]);
});

test('cold startup waits for a real model catalog even when transport is ready', async t => {
  const context = await fixture(t, 'blocked');
  let settled = false;
  const running = start(context.state).finally(() => { settled = true; });
  t.after(async () => { const tunnel = await running.catch(() => null); await tunnel?.close(); });
  const origin = await waitFor(() => readFile(path.join(context.directory, 'fixture-origin'), 'utf8'));
  await waitFor(() => events(origin), value => value?.pending === 1);
  assert.equal(settled, false);
  await release(origin);
  const tunnel = await running;
  assert.equal(tunnel.modelsSource, 'gateway');
  assert.deepEqual(tunnel.models, [{ id: 'gateway-model' }]);
  await tunnel.catalogRefresh;
  assert.ok(await loadModelCache(context.state));
});

test('cached catalog cannot declare readiness before authenticated connection; close cancels refresh', async t => {
  const context = await fixture(t, 'not-ready');
  await prime(context);
  let settled = false;
  const running = start(context.state).finally(() => { settled = true; });
  t.after(async () => { const tunnel = await running.catch(() => null); await tunnel?.close(); });
  const origin = await waitFor(() => readFile(path.join(context.directory, 'fixture-origin'), 'utf8'));
  assert.equal(settled, false);
  assert.equal((await events(origin)).requests, 0);
  await fetch(origin + '/test/ready');
  const tunnel = await running;
  assert.equal(tunnel.modelsSource, 'cache');
  await waitFor(() => events(origin), value => value?.pending === 1);
  await tunnel.close();
  assert.ok(tunnel.child.exitCode !== null || tunnel.child.signalCode !== null);
  await assert.rejects(stat(tunnel.directory), { code: 'ENOENT' });
});

test('authentication rejection cannot be hidden by cached models and invalidates them', async t => {
  const context = await fixture(t, 'rejected');
  await prime(context);
  await assert.rejects(start(context.state), error => error.code === 'MCODEX_CONNECTION_REJECTED');
  assert.equal(await loadModelCache(context.state), null);
});

for (const mode of ['changed', 'legacy']) {
  test(`${mode} scope requires authenticated directory discovery instead of cached launch`, async t => {
    const context = await fixture(t, mode);
    await prime(context);
    const tunnel = await start(context.state);
    t.after(() => tunnel.close());
    assert.equal(tunnel.modelsSource, 'gateway');
    assert.deepEqual(tunnel.models, [{ id: 'gateway-model' }]);
  });
}

test('a requested model absent from cache requires directory discovery', async t => {
  const context = await fixture(t);
  await prime(context);
  const tunnel = await start({ ...context.state, model: 'gateway-model' });
  t.after(() => tunnel.close());
  assert.equal(tunnel.modelsSource, 'gateway');
});

test('mismatched HTTP and handshake scopes are never persisted', async t => {
  const context = await fixture(t, 'mismatch');
  const tunnel = await start(context.state);
  t.after(() => tunnel.close());
  assert.equal(tunnel.modelsSource, 'gateway');
  await tunnel.catalogRefresh;
  assert.equal(await loadModelCache(context.state), null);
});

test('logout removes credentials even when optional cache is an unsafe symlink', async t => {
  const context = await fixture(t);
  const outside = path.join(context.directory, 'keep');
  await writeFile(outside, 'untouched');
  await symlink(outside, path.join(context.directory, 'models.json'));
  await deleteState(context.directory);
  await assert.rejects(stat(context.state.tokenFile), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(context.directory, 'config.json')), { code: 'ENOENT' });
  assert.equal(await readFile(outside, 'utf8'), 'untouched');
});

test('explicit uncached verification also clears cache after authorization failure', async t => {
  const context = await fixture(t, 'rejected');
  await prime(context);
  await assert.rejects(start(context.state, { allowCachedModels: false }), error => error.code === 'MCODEX_AUTH_FAILED');
  assert.equal(await loadModelCache(context.state), null);
});

test('cold discovery returns before optional scope diagnostics finish', async t => {
  const context = await fixture(t, 'diagnostics-blocked');
  const tunnel = await start(context.state);
  t.after(() => tunnel.close());
  assert.equal(tunnel.modelsSource, 'gateway');
  let refreshDone = false;
  tunnel.catalogRefresh.then(() => { refreshDone = true; });
  await Promise.resolve();
  assert.equal(refreshDone, false);
  await tunnel.close();
  assert.equal(refreshDone, true);
});

test('background directory authorization failure removes the cache', async t => {
  const context = await fixture(t, 'revoked');
  await prime(context);
  const tunnel = await start(context.state);
  t.after(() => tunnel.close());
  await tunnel.catalogRefresh;
  assert.equal(await loadModelCache(context.state), null);
});

test('a verified empty catalog removes old models instead of preserving them as stale', async t => {
  const context = await fixture(t, 'empty');
  await prime(context);
  const tunnel = await start(context.state);
  t.after(() => tunnel.close());
  await tunnel.catalogRefresh;
  assert.equal(await loadModelCache(context.state), null);
});

test('diagnostics only expose well-formed catalog scope on an active connection', async () => {
  const body = { schema_version: 1, connected: true, hops: [], catalog_scope: scope };
  const read = value => readDiagnostics({ origin: 'http://127.0.0.1:1', key: 'test' }, { request: async () => Response.json(value) });
  assert.equal((await read(body)).catalog_scope, scope);
  assert.equal((await read({ ...body, connected: false })).catalog_scope, null);
  for (const value of [null, 'secret-looking-arbitrary-value', 'v1-' + 'A'.repeat(64), scope + 'x']) {
    assert.equal((await read({ ...body, catalog_scope: value })).catalog_scope, null);
  }
});
