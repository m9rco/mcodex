import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLogin } from '../src/cli.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('login accepts non-argv secret sources and refuses ambiguous options', () => {
  assert.deepEqual(parseLogin(['--server', 'wss://example.org/path', '--token-stdin']), { server: 'wss://example.org/path', tokenStdin: true });
  assert.deepEqual(parseLogin(['--no-launch', '--token-file', 'key']), { noLaunch: true, tokenFile: 'key' });
  assert.throws(() => parseLogin(['--token', 'secret']), /Unknown login option/);
  assert.throws(() => parseLogin(['--token-stdin', '--token-file', 'key']), /Choose either/);
  assert.throws(() => parseLogin(['--server']), /Missing value/);
  assert.throws(() => parseLogin(['--model', 'one', '--model', 'two']), /Duplicate option/);
  assert.throws(() => parseLogin(['--no-launch', '--no-launch']), /Duplicate option/);
});

test('termination wakes login while its Token input pipe remains open', async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/mcodex.js', import.meta.url)), 'login', '--server', 'wss://example.org/tunnel', '--token-stdin'], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  child.stdin.write('partial-input');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const killTimer = setTimeout(() => child.kill('SIGTERM'), 300);
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('login failed to exit on SIGTERM')); }, 3000);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timeout); clearTimeout(killTimer); resolve(code); });
  });
  assert.equal(code, 1);
  assert.match(stderr, /Interrupted by SIGTERM/);
  assert.equal(stderr.includes('partial-input'), false);
});
