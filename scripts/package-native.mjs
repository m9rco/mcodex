#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = 'v0.3.2';
const repository = 'm9rco/mlab-gateway-client';
const manifestDigest = 'd831b2463274a860c9e8f655eaf66a4e780eb59c6f60738e3e23548193e352d9';
const targets = [
  { suffix: 'linux-x64', os: 'linux', cpu: 'x64', arch: 'x86_64', transportVersion: '0.3.2', archiveDigest: '76e64c15a03f662ace3ed6175ce69ebd91445fabb45c0b2a46563bd4571c64de' },
  { suffix: 'linux-arm64', os: 'linux', cpu: 'arm64', arch: 'aarch64', transportVersion: '0.3.2', archiveDigest: 'f1d6a541c07e89ff274d4da0470af43e10b78fbd807661e2a5c739ef80efc0da' },
  { suffix: 'darwin-arm64', os: 'darwin', cpu: 'arm64', transportVersion: '0.3.3' },
];

const args = process.argv.slice(2);
const options = { version: '0.1.0', output: join(root, 'packages') };
for (let i = 0; i < args.length; i += 2) {
  const names = { '--version': 'version', '--out-dir': 'output', '--linux-cache': 'cache', '--darwin-binary': 'darwinBinary' };
  const name = names[args[i]];
  if (!name || !args[i + 1]) throw new Error('Usage: node scripts/package-native.mjs [--version 0.1.0] [--out-dir packages] [--linux-cache DIR] [--darwin-binary FILE]');
  options[name] = args[i + 1];
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)) throw new Error('Invalid package version');

const temporary = await mkdtemp(join(tmpdir(), 'mcodex-native-package-'));
const sha256 = data => createHash('sha256').update(data).digest('hex');
const run = (command, argv) => execFileSync(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
try {
  const cache = options.cache ? resolve(options.cache) : join(temporary, 'download');
  if (!options.cache) {
    await mkdir(cache);
    run('gh', ['release', 'download', release, '--repo', repository, '--dir', cache, '--pattern', 'SHA256SUMS', '--pattern', `mlab-gateway-${release}-*-unknown-linux-musl.tar.gz`]);
  }
  const checksumData = await readFile(join(cache, 'SHA256SUMS'));
  if (sha256(checksumData) !== manifestDigest) throw new Error('Release checksum manifest does not match its pinned digest');
  const checksums = new Map(checksumData.toString('utf8').trim().split('\n').map(line => {
    const match = /^([a-f0-9]{64})\s+\*?([^\s]+)$/.exec(line);
    if (!match) throw new Error('Malformed release checksum manifest');
    return [match[2], match[1]];
  }));
  const license = await readFile(join(root, 'LICENSE'));
  const notice = await readFile(join(root, 'NOTICE'));
  for (const target of targets) {
    let binary;
    if (target.os === 'linux') {
      const archiveName = `mlab-gateway-${release}-${target.arch}-unknown-linux-musl.tar.gz`;
      const archive = join(cache, archiveName);
      if (checksums.get(archiveName) !== target.archiveDigest || sha256(await readFile(archive)) !== target.archiveDigest) throw new Error(`Archive checksum mismatch: ${archiveName}`);
      const members = run('tar', ['-tzf', archive]).trim().split('\n');
      if (members.length !== 1 || members[0] !== 'mlab-gateway') throw new Error(`Unexpected archive layout: ${archiveName}`);
      const extracted = join(temporary, target.suffix);
      await mkdir(extracted);
      run('tar', ['-xzf', archive, '-C', extracted, 'mlab-gateway']);
      binary = join(extracted, 'mlab-gateway');
      const header = await readFile(binary);
      const machine = target.cpu === 'x64' ? 62 : 183;
      if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== machine) throw new Error(`Unexpected executable architecture: ${target.suffix}`);
    } else {
      if (!options.darwinBinary) continue;
      binary = resolve(options.darwinBinary);
      const header = await readFile(binary);
      if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c) throw new Error('Expected a macOS ARM64 Mach-O executable');
      if (process.platform === 'darwin' && run(binary, ['--version']).trim() !== `mlab-gateway ${target.transportVersion}`) throw new Error('Unexpected macOS transport version');
    }
    if (!(await stat(binary)).isFile()) throw new Error('Transport binary must be a regular file');
    const directory = resolve(options.output, `mcodex-${target.suffix}`);
    await mkdir(join(directory, 'bin'), { recursive: true });
    await copyFile(binary, join(directory, 'bin', 'mlab-gateway'));
    await chmod(join(directory, 'bin', 'mlab-gateway'), 0o755);
    const binaryDigest = sha256(await readFile(binary));
    const metadata = {
      name: `@m9rco/mcodex-${target.suffix}`,
      version: options.version,
      description: `Precompiled MLab Gateway transport for mcodex (${target.suffix})`,
      license: 'MIT',
      os: [target.os],
      cpu: [target.cpu],
      files: ['bin/mlab-gateway', 'LICENSE', 'NOTICE', 'README.md', 'SHA256SUMS'],
      exports: { './package.json': './package.json', './bin/mlab-gateway': './bin/mlab-gateway' },
      repository: { type: 'git', url: 'git+https://github.com/m9rco/mcodex.git', directory: `packages/mcodex-${target.suffix}` },
      publishConfig: { access: 'public' },
      mcodex: { transportVersion: target.transportVersion, binarySha256: binaryDigest },
    };
    await writeFile(join(directory, 'package.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    await writeFile(join(directory, 'LICENSE'), license);
    await writeFile(join(directory, 'NOTICE'), notice);
    await writeFile(join(directory, 'SHA256SUMS'), `${binaryDigest}  bin/mlab-gateway\n`);
    await writeFile(join(directory, 'README.md'), `# ${metadata.name}\n\nPlatform-specific transport for [mcodex](https://github.com/m9rco/mcodex). npm selects this package automatically. Install \`@m9rco/mcodex\` to use the CLI.\n\nMLab Gateway ${target.transportVersion}; MIT license. The binary SHA-256 is recorded in SHA256SUMS. This package has no installation scripts and contains no user configuration or credentials.\n`);
    console.log(`${metadata.name}@${options.version}: ${binaryDigest}`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
