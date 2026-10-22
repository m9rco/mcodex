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

test('installer pins the exact independently published GitHub release', async () => {
  const [script, releaseText] = await Promise.all([read('scripts/install.sh'), read('scripts/github-release.json')]);
  const release = JSON.parse(releaseText);
  const literal = name => {
    const matches = [...script.matchAll(new RegExp(`^${name}=(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)$`, 'gm'))];
    assert.equal(matches.length, 1, `${name} must have exactly one explicit release version`);
    return matches[0][1];
  };
  assert.equal(literal('MCODEX_MAIN_VERSION'), release.mainVersion);
  assert.equal(literal('MCODEX_NATIVE_VERSION'), release.nativeVersion);
  assert.equal(release.release, `v${release.mainVersion}`);
  assert.deepEqual(script.split('\n').filter(line => line.startsWith('MCODEX_RELEASE_URL=')),
    [`MCODEX_RELEASE_URL=https://github.com/${release.repository}/releases/download/v\${MCODEX_MAIN_VERSION}`]);
});

test('tracked native package metadata matches wrapper pins and frozen release digests', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const native = JSON.parse(await read('scripts/native-release.json'));
  const notice = await read('NOTICE');
  const suffixes = ['linux-x64', 'linux-arm64', 'darwin-arm64'];
  assert.deepEqual(Object.keys(manifest.optionalDependencies).filter(name => name.startsWith('@m9rco/mcodex-')).sort(),
    suffixes.map(suffix => `@m9rco/mcodex-${suffix}`).sort());
  for (const suffix of suffixes) {
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
