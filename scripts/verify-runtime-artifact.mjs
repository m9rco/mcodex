#!/usr/bin/env node
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileDigest, extractRuntime } from '../src/runtime-archive.js';
import { healthCheck } from '../src/runtime-update.js';

const directory = path.resolve(process.argv[2] ?? 'runtime-dist');
if (process.argv.length > 4 || process.argv[3] && process.argv[3] !== '--workspace') throw new Error('Use verify-runtime-artifact.mjs DIRECTORY [--workspace].');
const target = `${process.platform}-${process.arch}`;
const artifact = JSON.parse(await readFile(path.join(directory, `${target}.artifact.json`), 'utf8'));
const archive = path.join(directory, new URL(artifact.url).pathname.split('/').at(-1));
if (artifact.target !== target || await fileDigest(archive) !== artifact.sha256) throw new Error('Runtime build artifact checksum mismatch.');
const temporary = await mkdtemp(path.join(tmpdir(), 'mcodex-runtime-acceptance-'));
try {
  const runtime = path.join(temporary, 'runtime'); await mkdir(runtime);
  await extractRuntime(archive, runtime, artifact.files);
  await healthCheck(runtime);
  if (process.argv[3] === '--workspace') {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    execFileSync(process.execPath, [path.join(root, 'scripts/verify-workspace.mjs')], { cwd: root, stdio: 'inherit',
      env: { ...process.env, MCODEX_WORKSPACE_TEST_RUNTIME_ROOT: runtime,
        MCODEX_WORKSPACE_TEST_CODEX_BIN: path.join(runtime, 'node_modules/@openai/codex/bin/codex.js') } });
  }
  console.log(`Runtime ${artifact.version} ${target}: archive, local dependencies and health verified.`);
} finally { await rm(temporary, { recursive: true, force: true }); }
