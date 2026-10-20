import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');

test('historical root installer stays identical to the canonical release installer', async () => {
  const [canonical, compatibility] = await Promise.all([read('scripts/install.sh'), read('install.sh')]);
  assert.equal(compatibility, canonical, 'scripts/install.sh is canonical; copy it to install.sh when releasing so historical raw URLs cannot install an older release');
  for (const name of ['scripts/install.sh', 'install.sh']) execFileSync('sh', ['-n', fileURLToPath(new URL(name, root))]);
});

test('installer pins the same wrapper and native versions as package.json', async () => {
  const [script, manifestText] = await Promise.all([read('scripts/install.sh'), read('package.json')]);
  const manifest = JSON.parse(manifestText);
  const literal = name => {
    const matches = [...script.matchAll(new RegExp(`^${name}=(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$`, 'gm'))];
    assert.equal(matches.length, 1, `${name} must have exactly one explicit release version`);
    return matches[0][1];
  };
  assert.equal(literal('MCODEX_MAIN_VERSION'), manifest.version);
  const versions = Object.entries(manifest.optionalDependencies).filter(([name]) => name.startsWith('@m9rco/mcodex-')).map(([, version]) => version);
  assert.equal(versions.length, 3);
  assert.deepEqual([...new Set(versions)], [literal('MCODEX_NATIVE_VERSION')]);
});
