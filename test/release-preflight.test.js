import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir, writeFile, cp, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNpmRelease, inspectMainArchive } from '../scripts/release-preflight.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('release preflight inspects the real packed baseline and preserves its frozen archive', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcodex-npm-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await prepareNpmRelease({ directory, localOnly: true });
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(result.version, pkg.version); assert(result.readmeBytes > 100);
  assert(result.files.includes('package/src/runtime-policy.json'));
  assert(!result.files.some(name => name.endsWith('.pem') || name.includes('.npmrc')));
  await assert.rejects(prepareNpmRelease({ directory, localOnly: true }), /already exists/);
});

test('missing README is rejected before any publish command can run', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcodex-missing-readme-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'package'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await writeFile(path.join(directory, 'package/package.json'), JSON.stringify(pkg));
  const archive = path.join(directory, 'missing.tgz');
  execFileSync('tar', ['-czf', archive, '-C', directory, 'package/package.json']);
  assert.throws(() => inspectMainArchive(archive, pkg));
});

test('public preflight requests JSON metadata and verifies all native bytes against the lockfile', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mcodex-public-preflight-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, 'source'), directory = path.join(temporary, 'frozen');
  await mkdir(projectRoot);
  for (const name of ['src', 'bin', 'README.md', 'LICENSE', 'NOTICE', 'package.json']) await cp(path.join(root, name), path.join(projectRoot, name), { recursive: true });
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  const packages = new Map();
  for (const suffix of ['linux-x64', 'linux-arm64', 'darwin-arm64']) {
    const name = `@m9rco/mcodex-${suffix}`, bytes = Buffer.from(`frozen archive fixture ${suffix}`), version = lock.packages[`node_modules/${name}`].version;
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    lock.packages[`node_modules/${name}`].integrity = integrity;
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
    const tarball = `https://registry.npmjs.org/${name}/-/fixture.tgz`;
    packages.set(url, { name, version, dist: { integrity, tarball } }); packages.set(tarball, bytes);
  }
  await writeFile(path.join(projectRoot, 'package-lock.json'), JSON.stringify(lock));
  const fetchImpl = async (url, options) => {
    if (url.includes('/@m9rco%2Fmcodex/')) return new Response('{}', { status: 404 });
    const value = packages.get(url); assert(value, `Unexpected URL ${url}`);
    if (Buffer.isBuffer(value)) { assert.equal(options.headers.Accept, 'application/octet-stream'); return new Response(value); }
    assert.equal(options.headers.Accept, 'application/json');
    return new Response(JSON.stringify(value));
  };
  await prepareNpmRelease({ directory, projectRoot, fetchImpl });
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.tgz')).length, 4);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'preflight.json'))).nativeDependenciesVerified, true);
});

test('an existing public launcher version is rejected before packaging', async t => {
  const directory = path.join(tmpdir(), `mcodex-preflight-unwritten-${Date.now()}`);
  await assert.rejects(prepareNpmRelease({ directory, fetchImpl: async () => new Response('{}') }), /already exists/);
});
