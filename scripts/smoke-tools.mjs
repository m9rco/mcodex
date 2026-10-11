#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Requires a configured mcodex connection and consumes a real model task.
const directory = await mkdtemp(path.join(tmpdir(), 'mcodex-smoke-'));
await chmod(directory, 0o700);
const marker = `MCODEX_LOCAL_TOOL_OK_${randomBytes(12).toString('hex')}`;
await writeFile(path.join(directory, 'fixture.txt'), marker + '\n', { mode: 0o600 });
let child;
try {
  const cli = fileURLToPath(new URL('../bin/mcodex.js', import.meta.url));
  child = spawn(process.execPath, [cli, 'exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '--json', 'Read fixture.txt using the local terminal tool. Reply only with its exact contents.'], {
    cwd: directory, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let timedOut = false;
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.resume();
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 120000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  }).finally(() => clearTimeout(timer));
  const events = output.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const tool = events.some(event => event.type === 'item.completed' && event.item?.type === 'command_execution' && event.item.exit_code === 0 && event.item.aggregated_output?.includes(marker));
  const answer = events.some(event => event.item?.type === 'agent_message' && event.item.text?.trim() === marker);
  if (code !== 0 || !tool || !answer) throw new Error(`Real Codex local-tool verification failed${timedOut ? ' (timeout)' : ''}; inspect gateway connectivity and local sandbox availability.`);
  console.log('Real gateway, Codex, local file tool and final answer: PASS');
} finally {
  if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await rm(directory, { recursive: true, force: true });
}
