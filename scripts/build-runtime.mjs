#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile, readdir, rm, lstat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inventory, fileDigest, sha256 } from '../src/runtime-archive.js';
import { publicResponse, healthCheck, compareVersions } from '../src/runtime-update.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeEntry = `import { main } from './src/cli.js';\ntry { process.exitCode = await main(process.argv.slice(2)); } catch (error) { console.error('mcodex: ' + error.message); process.exitCode = 1; }\n`;

async function copyTree(source, destination) {
  await cp(source, destination, { recursive: true, filter: async filename => {
    if (path.basename(filename) === '.bin') return false;
    if ((await lstat(filename)).isSymbolicLink()) throw new Error('Runtime build inputs cannot contain symbolic links.');
    return true;
  } });
}

export async function buildRuntime({ output, dependenciesDir, nativeDirectory, config, target = `${process.platform}-${process.arch}`, projectRoot = root } = {}) {
  config ??= JSON.parse(await readFile(path.join(projectRoot, 'scripts/runtime-release.json'), 'utf8'));
  compareVersions(config.version, '0.0.0');
  compareVersions(config.codexVersion, '0.0.0');
  compareVersions(config.nativeVersion, '0.0.0');
  if (target !== `${process.platform}-${process.arch}` || !['linux-x64', 'linux-arm64', 'darwin-arm64'].includes(target)) throw new Error('Build each runtime on its matching platform runner.');
  const compatibility = JSON.parse(await readFile(path.join(projectRoot, 'src/engine-compatibility.json'), 'utf8'));
  if (!compatibility.tested_versions.includes(config.codexVersion)) throw new Error('Runtime Codex version has not passed compatibility acceptance.');
  const temporary = await mkdtemp(path.join(tmpdir(), 'mcodex-runtime-build-'));
  output = path.resolve(output ?? path.join(projectRoot, 'runtime-dist'));
  const nativeName = `@m9rco/mcodex-${target}`;
  try {
    const runtime = path.join(temporary, 'runtime');
    await mkdir(path.join(runtime, 'src'), { recursive: true });
    const excluded = new Set(['bootstrap.js', 'runtime-update.js', 'runtime-archive.js', 'runtime-network.js', 'runtime-policy.json']);
    for (const name of await readdir(path.join(projectRoot, 'src'))) {
      if (!excluded.has(name)) await copyTree(path.join(projectRoot, 'src', name), path.join(runtime, 'src', name));
    }
    for (const name of ['LICENSE', 'NOTICE']) await cp(path.join(projectRoot, name), path.join(runtime, name));
    await writeFile(path.join(runtime, 'entry.mjs'), runtimeEntry);
    await mkdir(path.join(runtime, 'bin'));
    await writeFile(path.join(runtime, 'bin/mcodex.js'), runtimeEntry.replace("'./src/cli.js'", "'../src/cli.js'"), { mode: 0o755 });
    const pkg = { name: '@m9rco/mcodex-runtime', version: config.version, private: true, type: 'module',
      engines: { node: '>=22' }, license: 'MIT', dependencies: { '@openai/codex': config.codexVersion } };
    await writeFile(path.join(runtime, 'package.json'), JSON.stringify(pkg, null, 2));
    const source = config.nativeSources?.[target];
    if (nativeDirectory && source) throw new Error('Choose either a native directory or a pinned native release source.');
    if (dependenciesDir) {
      await copyTree(path.join(dependenciesDir, '@openai'), path.join(runtime, 'node_modules', '@openai'));
      if (!nativeDirectory && !source) await copyTree(path.join(dependenciesDir, nativeName), path.join(runtime, 'node_modules', nativeName));
    } else {
      const args = ['install', '--prefix', runtime, '--registry=https://registry.npmjs.org', '--ignore-scripts', '--no-audit', '--no-fund', '--userconfig=/dev/null',
        `@openai/codex@${config.codexVersion}`];
      if (!nativeDirectory && !source) args.push(`${nativeName}@${config.nativePackageVersion}`);
      execFileSync('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
      await rm(path.join(runtime, 'node_modules', '.bin'), { recursive: true, force: true });
      await rm(path.join(runtime, 'node_modules', '.package-lock.json'), { force: true });
      await rm(path.join(runtime, 'package-lock.json'), { force: true });
    }
    const nativeRoot = path.join(runtime, 'node_modules', nativeName);
    if (nativeDirectory) await copyTree(path.resolve(nativeDirectory), nativeRoot);
    if (source) {
      if (!/^[a-f0-9]{64}$/.test(source.sha256) || !source.url?.startsWith('https://github.com/m9rco/mlab-gateway-client/releases/download/')) throw new Error('Native runtime source must use a pinned gateway GitHub release.');
      const response = await publicResponse(source.url);
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new Error('Native build asset is too large.'); chunks.push(chunk); }
      let binary = Buffer.concat(chunks);
      if (sha256(binary) !== source.sha256) throw new Error('Native build source checksum mismatch.');
      if (source.archiveMember !== undefined) {
        if (source.archiveMember !== 'mlab-gateway') throw new Error('Unsupported native archive member.');
        const archive = path.join(temporary, 'native.tar.gz'); await writeFile(archive, binary);
        if (execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim() !== 'mlab-gateway' ||
            !execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).startsWith('-')) throw new Error('Invalid native build archive.');
        binary = execFileSync('tar', ['-xOf', archive, 'mlab-gateway'], { maxBuffer: 64 * 1024 * 1024 });
      }
      await mkdir(path.join(nativeRoot, 'bin'), { recursive: true });
      await writeFile(path.join(nativeRoot, 'bin/mlab-gateway'), binary, { mode: 0o755 });
      await writeFile(path.join(nativeRoot, 'package.json'), JSON.stringify({ name: nativeName, version: config.nativePackageVersion,
        mcodex: { transportVersion: config.nativeVersion, binarySha256: sha256(binary) } }));
    }
    const codex = JSON.parse(await readFile(path.join(runtime, 'node_modules/@openai/codex/package.json'), 'utf8'));
    const native = JSON.parse(await readFile(path.join(nativeRoot, 'package.json'), 'utf8'));
    if (codex.version !== config.codexVersion || native.name !== nativeName || native.version !== config.nativePackageVersion ||
        native.mcodex?.transportVersion !== config.nativeVersion || native.mcodex.binarySha256 !== await fileDigest(path.join(nativeRoot, 'bin/mlab-gateway'))) throw new Error('Runtime dependencies do not match the selected release.');
    pkg.optionalDependencies = { [nativeName]: native.version };
    await writeFile(path.join(runtime, 'package.json'), JSON.stringify(pkg, null, 2));
    await chmod(path.join(nativeRoot, 'bin/mlab-gateway'), 0o755);
    await healthCheck(runtime);
    const files = await inventory(runtime);
    await mkdir(output, { recursive: true });
    const filename = `mcodex-runtime-${config.version}-${target}.tar.gz`, archive = path.join(output, filename);
    // ustar avoids implementation-specific extended paths; all source names are
    // validated by inventory before invoking tar. macOS resource forks are off.
    execFileSync('tar', ['--format=ustar', '-czf', archive, '-C', temporary, 'runtime'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    const artifact = { target, version: config.version, codexVersion: config.codexVersion, nativeVersion: config.nativeVersion,
      url: `https://github.com/m9rco/mcodex/releases/download/runtime-v${config.version}/${filename}`,
      size: (await lstat(archive)).size, sha256: await fileDigest(archive), files };
    await writeFile(path.join(output, `${target}.artifact.json`), `${JSON.stringify(artifact, null, 2)}\n`);
    return { filename, ...artifact };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = {};
  const names = { '--output': 'output', '--dependencies-dir': 'dependenciesDir', '--native-directory': 'nativeDirectory' };
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!names[process.argv[i]] || !process.argv[i + 1]) throw new Error('Use build-runtime.mjs [--output DIR] [--dependencies-dir NODE_MODULES] [--native-directory DIR].');
    options[names[process.argv[i]]] = process.argv[i + 1];
  }
  const result = await buildRuntime(options);
  console.log(`${result.filename}: ${result.sha256}`);
}
