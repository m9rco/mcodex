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

test('tracked native package metadata matches wrapper pins and frozen release digests', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const native = JSON.parse(await read('scripts/native-release.json'));
  const notice = await read('NOTICE');
  for (const suffix of ['linux-x64', 'linux-arm64', 'darwin-arm64']) {
    const directory = `packages/mcodex-${suffix}`;
    const metadata = JSON.parse(await read(`${directory}/package.json`));
    assert.equal(metadata.name, `@m9rco/mcodex-${suffix}`);
    assert.equal(metadata.version, manifest.optionalDependencies[metadata.name]);
    assert.equal(metadata.mcodex.transportVersion, native.release.slice(1));
    assert.match(metadata.mcodex.binarySha256, /^[a-f0-9]{64}$/);
    assert.equal(await read(`${directory}/SHA256SUMS`), `${metadata.mcodex.binarySha256}  bin/mlab-gateway\n`);
    assert.equal(await read(`${directory}/NOTICE`), notice);
    if (suffix === 'darwin-arm64') assert.equal(metadata.mcodex.binarySha256, native.darwinDigest);
  }
});
