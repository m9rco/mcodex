#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { createHash, createPublicKey } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicResponse, defaultPolicy } from '../src/runtime-update.js';
import { safePath } from '../src/runtime-archive.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const tarText = (archive, name) => execFileSync('tar', ['-xOf', archive, `package/${name}`], { encoding: 'utf8', maxBuffer: 1024 * 1024 });

export function inspectMainArchive(archive, expected) {
  const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split('\n');
  if (!names.length || names.some(name => !name.startsWith('package/') || !safePath(name) ||
      /(^|\/)(?:node_modules|\.npmrc|\.env|server\.key|config\.json|.*\.(?:pem|key))($|\/)/i.test(name))) throw new Error('Unexpected or sensitive file in npm archive.');
  const entries = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 1024 * 1024 }).trim().split('\n');
  if (entries.some(line => !line.startsWith('-'))) throw new Error('npm archives cannot contain links or special files.');
  const pkg = JSON.parse(tarText(archive, 'package.json'));
  if (pkg.name !== '@m9rco/mcodex' || pkg.version !== expected.version || JSON.stringify(pkg.dependencies) !== JSON.stringify(expected.dependencies) ||
      JSON.stringify(pkg.optionalDependencies) !== JSON.stringify(expected.optionalDependencies)) throw new Error('Frozen npm manifest does not match the release.');
  const readme = tarText(archive, 'README.md');
  if (!readme.trim() || !readme.includes('npm install -g @m9rco/mcodex')) throw new Error('npm README is absent or missing installation instructions.');
  for (const name of ['bin/mcodex.js', 'src/bootstrap.js', 'src/runtime-update.js', 'src/runtime-archive.js', 'src/runtime-policy.json', 'src/cli.js', 'src/engine-compatibility.json']) {
    if (!names.includes(`package/${name}`)) throw new Error('The npm baseline or launcher is incomplete.');
  }
  const compatibility = JSON.parse(tarText(archive, 'src/engine-compatibility.json'));
  if (!compatibility.tested_versions?.includes(pkg.dependencies['@openai/codex'])) throw new Error('The baseline Codex version is not in the tested compatibility manifest.');
  const policy = JSON.parse(tarText(archive, 'src/runtime-policy.json'));
  if (policy.schema !== 1 || policy.repository !== defaultPolicy.repository || policy.channelURL !== defaultPolicy.channelURL || !Object.keys(policy.publicKeys ?? {}).length ||
      Object.values(policy.publicKeys).some(key => createPublicKey(key).asymmetricKeyType !== 'ed25519')) throw new Error('Runtime verification keys are missing or invalid in the npm launcher.');
  return { name: pkg.name, version: pkg.version, files: names, readmeBytes: Buffer.byteLength(readme) };
}

async function boundedBody(response, limit) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; if (bytes > limit) throw new Error('Public release response exceeded its limit.'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export async function prepareNpmRelease({ directory, localOnly = false, expectedVersion, projectRoot = root, fetchImpl = fetch } = {}) {
  if (!directory) throw new Error('Choose an empty frozen release directory with --directory.');
  directory = path.resolve(directory);
  const manifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  if (manifest.version !== lock.version || manifest.version !== lock.packages[''].version || expectedVersion && expectedVersion !== manifest.version) throw new Error('Release version does not match the tag or lockfile.');
  if (!localOnly) {
    const published = await publicResponse(`https://registry.npmjs.org/@m9rco%2Fmcodex/${manifest.version}`, { fetchImpl, allowNotFound: true, accept: 'application/json' });
    await published.body?.cancel();
    if (published.status !== 404) throw new Error('This npm launcher version already exists; do not republish it for runtime or documentation changes.');
  }
  await mkdir(directory, { recursive: true });
  const filename = `m9rco-mcodex-${manifest.version}.tgz`;
  if (await lstat(path.join(directory, filename)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('Frozen archive already exists; use a fresh release directory.');
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', directory], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  if (result.length !== 1 || result[0].filename !== filename) throw new Error('Unexpected npm pack output.');
  const archive = path.join(directory, filename), summary = inspectMainArchive(archive, manifest);
  const bytes = await readFile(archive);
  if (integrity(bytes) !== result[0].integrity) throw new Error('Frozen npm archive changed after packing.');
  if (!localOnly) {
    for (const suffix of ['linux-x64', 'linux-arm64', 'darwin-arm64']) {
      const name = `@m9rco/mcodex-${suffix}`, version = manifest.optionalDependencies[name];
      const metadata = JSON.parse(await boundedBody(await publicResponse(`https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`, { fetchImpl, accept: 'application/json' }), 131072));
      const locked = lock.packages[`node_modules/${name}`];
      if (metadata.name !== name || metadata.version !== version || metadata.dist?.integrity !== locked?.integrity) throw new Error('Published native dependency differs from the reviewed lockfile.');
      const url = new URL(metadata.dist.tarball);
      if (url.origin !== 'https://registry.npmjs.org' || url.username || url.password || url.search || url.hash) throw new Error('Unexpected native npm download origin.');
      const data = await boundedBody(await publicResponse(url.href, { fetchImpl }), 64 * 1024 * 1024);
      if (integrity(data) !== metadata.dist.integrity) throw new Error('Published native archive checksum mismatch.');
      await writeFile(path.join(directory, `m9rco-mcodex-${suffix}-${version}.tgz`), data, { flag: 'wx' });
    }
  }
  await writeFile(path.join(directory, 'preflight.json'), JSON.stringify({ ...summary, integrity: integrity(bytes),
    nativeDependenciesVerified: !localOnly, publishCommand: `npm publish ${filename} --access public --provenance` }, null, 2) + '\n');
  return { ...summary, directory, integrity: integrity(bytes) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = {};
  for (let i = 2; i < process.argv.length; i++) {
    const flag = process.argv[i];
    if (flag === '--local-only') { options.localOnly = true; continue; }
    const name = { '--directory': 'directory', '--expected-version': 'expectedVersion' }[flag];
    if (!name || !process.argv[++i]) throw new Error('Use release-preflight.mjs --directory DIR [--expected-version VERSION] [--local-only].');
    options[name] = process.argv[i];
  }
  const result = await prepareNpmRelease(options);
  console.log(`Frozen ${result.name}@${result.version}; README ${result.readmeBytes} bytes; ${result.integrity}`);
}
