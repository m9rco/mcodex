import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const stateUrl = new URL('../src/state.js', import.meta.url).href;

// Run the filesystem hook in a separate process so it cannot affect parallel
// tests or another cache writer in the test runner itself.
async function exerciseRace(mode, moduleUrl) {
  const assert = (await import('node:assert/strict')).default;
  const fs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { mkdtemp, stat, readdir, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { saveState, loadState, deleteState, modelCacheIdentity, saveModelCache, readConnectionToken } = await import(moduleUrl);

  const directory = await mkdtemp(path.join(tmpdir(), 'mcodex-cache-race-'));
  const originalRename = fs.promises.rename;
  const token = 'fixture-race-token-0123456789-abcdefgh';
  const replacementToken = 'fixture-rotated-token-0123456789-abcdefgh';
  let releaseRename;
  let reachedRename;
  let timeout;
  let saving;
  const gate = new Promise(resolve => { releaseRename = resolve; });
  const reached = new Promise(resolve => { reachedRename = resolve; });

  try {
    const state = await saveState(directory, { server: 'wss://test.invalid/cache-race', token });
    const identity = await modelCacheIdentity(state);
    const cacheFile = path.join(directory, 'models.json');
    fs.promises.rename = async (source, destination) => {
      if (destination === cacheFile) {
        // The writer has already created, synced and checked its temporary
        // file. Let the credential change happen before the rename completes.
        reachedRename();
        await gate;
      }
      return originalRename(source, destination);
    };
    syncBuiltinESMExports();

    saving = saveModelCache(state, {
      scope: 'v1-' + 'a'.repeat(64), identity, models: [{ id: 'old-account-model' }],
    });
    await Promise.race([
      reached,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Cache writer did not reach rename')), 3000);
      }),
    ]);
    clearTimeout(timeout);

    if (mode === 'logout') {
      await deleteState(directory);
    } else {
      assert.equal(mode, 'rotate-token');
      await saveState(directory, { server: state.server, token: replacementToken });
    }
    releaseRename();

    assert.equal(await saving, false, 'A write started under old credentials must be rejected');
    await assert.rejects(stat(cacheFile), { code: 'ENOENT' }, 'The old catalog must not survive the credential change');
    assert.equal((await readdir(directory).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })).some(name => name.startsWith('.models.json.')), false, 'The interrupted writer must remove its temporary file');

    if (mode === 'logout') {
      await assert.rejects(stat(state.tokenFile), { code: 'ENOENT' });
      await assert.rejects(stat(path.join(directory, 'config.json')), { code: 'ENOENT' });
    } else {
      const current = await loadState(directory);
      assert.equal(await readConnectionToken(current), replacementToken);
      assert.notEqual(await modelCacheIdentity(current), identity);
    }
    console.log('ok');
  } finally {
    clearTimeout(timeout);
    releaseRename();
    await saving?.catch(() => {});
    fs.promises.rename = originalRename;
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const [mode, title] of [
  ['logout', 'logout during cache rename leaves no catalog or credentials'],
  ['rotate-token', 'Token rotation during cache rename preserves the new credentials and removes the old catalog'],
]) {
  test(title, { timeout: 10_000 }, async () => {
    const source = `await (${exerciseRace.toString()})(${JSON.stringify(mode)}, ${JSON.stringify(stateUrl)});`;
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', source], { timeout: 8000 });
    assert.equal(stdout.trim(), 'ok');
  });
}
