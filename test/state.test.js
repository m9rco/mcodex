import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { deleteState, loadState, saveState, stateDirectory, validateServer, validateToken } from '../src/state.js';
import { promptText } from '../src/prompt.js';

const token = 'abcdefghijklmnopqrstuvwxyz0123456789_SAFE-Token';
const server = 'wss://gateway.example/mlab-tunnel';

async function fixture(t) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'mcodex-state-test-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  return { parent, directory: path.join(parent, 'state') };
}

test('state location uses wrapper-specific configuration without changing Codex paths', () => {
  assert.equal(stateDirectory({ MCODEX_CONFIG_DIR: '/custom/mcodex', XDG_CONFIG_HOME: '/xdg' }), '/custom/mcodex');
  assert.equal(stateDirectory({ XDG_CONFIG_HOME: '/xdg' }), '/xdg/mcodex');
  assert.equal(stateDirectory({}), path.join(os.homedir(), '.config', 'mcodex'));
});

test('server URL requires WSS and cannot contain embedded credentials or URL secrets', () => {
  assert.equal(validateServer(' wss://GATEWAY.example:443/mlab-tunnel '), server);
  for (const value of [undefined, '', 'https://gateway.example', 'ws://gateway.example', 'not a url', 'wss://user:secret@gateway.example', 'wss://user@gateway.example', `${server}?token=secret`, `${server}?`, `${server}#secret`, `${server}#`, 'wss://gate\nway.example']) {
    assert.throws(() => validateServer(value));
  }
});

test('connection tokens are validated without quoting rejected secrets', () => {
  assert.equal(validateToken(` ${token}\n`), token);
  for (const value of ['short-secret', 's'.repeat(4097), `${token}\nsecond-line`, `${token} secret`, `${token}汉字`, undefined]) {
    assert.throws(() => validateToken(value), (error) => !error.message.includes(String(value)));
  }
});

test('saved state has private permissions and metadata never contains the secret', async (t) => {
  const { directory } = await fixture(t);
  const saved = await saveState(directory, { server, token, model: 'gpt-6.1-sol' });
  assert.deepEqual(await loadState(directory), { server, model: 'gpt-6.1-sol', tokenFile: path.join(directory, 'server.key') });
  assert.equal(saved.tokenFile, path.join(directory, 'server.key'));
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  for (const name of ['config.json', 'server.key']) assert.equal((await fs.stat(path.join(directory, name))).mode & 0o777, 0o600);
  const config = await fs.readFile(path.join(directory, 'config.json'), 'utf8');
  assert.equal(config.includes(token), false);
  assert.deepEqual(JSON.parse(config), { version: 1, server, model: 'gpt-6.1-sol' });
  assert.equal(await fs.readFile(saved.tokenFile, 'utf8'), `${token}\n`);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['config.json', 'server.key']);
});

test('re-login repairs permissions and replaces files without modifying hard-linked targets', async (t) => {
  const { parent, directory } = await fixture(t);
  await saveState(directory, { server, token });
  await fs.chmod(directory, 0o755);
  await fs.chmod(path.join(directory, 'server.key'), 0o644);
  await assert.rejects(loadState(directory), /0700/u);
  await saveState(directory, { server, token, model: 'gpt-6-sol' });
  assert.equal((await loadState(directory)).model, 'gpt-6-sol');
  await fs.link(path.join(directory, 'server.key'), path.join(parent, 'outside.key'));
  await assert.rejects(saveState(directory, { server, token: 'x'.repeat(40) }), /hard links/u);
  assert.equal(await fs.readFile(path.join(parent, 'outside.key'), 'utf8'), `${token}\n`);
});

test('missing or corrupted state gives a setup error rather than accepting unsafe content', async (t) => {
  const { directory } = await fixture(t);
  await assert.rejects(loadState(directory), (error) => error.code === 'MCODEX_NOT_CONFIGURED' && error.message.includes('mcodex login'));
  await saveState(directory, { server, token });
  await fs.writeFile(path.join(directory, 'config.json'), '{invalid');
  await assert.rejects(loadState(directory), /invalid JSON/u);
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ version: 1, server, token }));
  await assert.rejects(loadState(directory), /unsupported fields/u);
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify({ version: 2, server }));
  await assert.rejects(loadState(directory), /unsupported/u);
});

test('state directory and key symlinks are rejected without following their targets', async (t) => {
  const { parent, directory } = await fixture(t);
  const target = path.join(parent, 'target');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, directory);
  await assert.rejects(saveState(directory, { server, token }), /symbolic link/u);
  assert.deepEqual(await fs.readdir(target), []);
  await fs.unlink(directory);
  await saveState(directory, { server, token });
  await fs.unlink(path.join(directory, 'server.key'));
  const outside = path.join(parent, 'outside.key');
  await fs.writeFile(outside, 'unchanged', { mode: 0o600 });
  await fs.symlink(outside, path.join(directory, 'server.key'));
  await assert.rejects(loadState(directory), /symbolic/u);
  await assert.rejects(saveState(directory, { server, token }), /symbolic/u);
  await assert.rejects(deleteState(directory), /symbolic/u);
  assert.equal(await fs.readFile(outside, 'utf8'), 'unchanged');
  assert.equal((await fs.readdir(directory)).includes('config.json'), true);
});

test('private key permissions and malformed tokens cannot be consumed silently', async (t) => {
  const { directory } = await fixture(t);
  await saveState(directory, { server, token });
  await fs.chmod(path.join(directory, 'server.key'), 0o644);
  await assert.rejects(loadState(directory), /0600/u);
  await fs.chmod(path.join(directory, 'server.key'), 0o600);
  await fs.writeFile(path.join(directory, 'server.key'), 'short');
  await assert.rejects(loadState(directory), /32–4096/u);
  await fs.writeFile(path.join(directory, 'server.key'), 'x'.repeat(4098));
  await assert.rejects(loadState(directory), /too large/u);
});

test('logout removes only managed files, preserves unrelated content, and is idempotent', async (t) => {
  const { directory } = await fixture(t);
  await deleteState(directory);
  await saveState(directory, { server, token });
  await fs.writeFile(path.join(directory, 'user-notes.txt'), 'keep');
  await deleteState(directory);
  assert.deepEqual(await fs.readdir(directory), ['user-notes.txt']);
  assert.equal(await fs.readFile(path.join(directory, 'user-notes.txt'), 'utf8'), 'keep');
  await deleteState(directory);
  await fs.unlink(path.join(directory, 'user-notes.txt'));
  await deleteState(directory);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

function replaceTerminal(t, { tty = true } = {}) {
  const descriptors = { stdin: Object.getOwnPropertyDescriptor(process, 'stdin'), stderr: Object.getOwnPropertyDescriptor(process, 'stderr') };
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = tty;
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; };
  output.isTTY = tty;
  let displayed = '';
  output.on('data', (value) => { displayed += value.toString(); });
  Object.defineProperty(process, 'stdin', { configurable: true, value: input });
  Object.defineProperty(process, 'stderr', { configurable: true, value: output });
  t.after(() => {
    Object.defineProperty(process, 'stdin', descriptors.stdin);
    Object.defineProperty(process, 'stderr', descriptors.stderr);
    input.destroy();
    output.destroy();
  });
  return { input, output, displayed: () => displayed };
}

test('hidden terminal prompts handle editing without echoing the connection token', async (t) => {
  const terminal = replaceTerminal(t);
  terminal.input.pause();
  const answer = promptText('Connection token:', { hidden: true });
  assert.equal(terminal.input.isRaw, true);
  terminal.input.write(`${token}X\u007f\r`);
  assert.equal(await answer, token);
  assert.equal(terminal.displayed(), 'Connection token: \n');
  assert.equal(terminal.input.isRaw, false);
  assert.equal(terminal.input.isPaused(), true);
  assert.equal(terminal.input.listenerCount('data'), 0);
});

test('cancelled hidden prompts restore terminal mode and do not reveal partial secrets', async (t) => {
  const terminal = replaceTerminal(t);
  const answer = promptText('Connection token:', { hidden: true });
  terminal.input.write(`${token}\u0003`);
  await assert.rejects(answer, (error) => error.code === 'ABORT_ERR');
  assert.equal(terminal.input.isRaw, false);
  assert.equal(terminal.displayed().includes(token), false);
  assert.equal(terminal.input.listenerCount('data'), 0);
});

test('hidden input EOF restores terminal mode and rejects instead of hanging', async (t) => {
  const terminal = replaceTerminal(t);
  const answer = promptText('Connection token:', { hidden: true });
  terminal.input.end(token);
  await assert.rejects(answer, /Input ended/u);
  assert.equal(terminal.input.isRaw, false);
  assert.equal(terminal.displayed().includes(token), false);
});

test('SIGTERM wakes hidden prompts, restores terminal mode, and carries the exit signal', async (t) => {
  const terminal = replaceTerminal(t);
  const listenersBefore = process.listenerCount('SIGTERM');
  const answer = promptText('Connection token:', { hidden: true });
  terminal.input.write(token);
  process.emit('SIGTERM');
  await assert.rejects(answer, (error) => error.code === 'ABORT_ERR' && error.signal === 'SIGTERM');
  assert.equal(terminal.input.isRaw, false);
  assert.equal(terminal.displayed().includes(token), false);
  assert.equal(process.listenerCount('SIGTERM'), listenersBefore);
});

test('plain terminal prompts also reject EOF instead of leaving setup pending', async (t) => {
  const terminal = replaceTerminal(t);
  const answer = promptText('Server:');
  terminal.input.end();
  await assert.rejects(answer, /Input ended/u);
});

test('noninteractive prompts explain secure token input options', async (t) => {
  replaceTerminal(t, { tty: false });
  await assert.rejects(promptText('Connection token:', { hidden: true }), /--token-stdin or --token-file/u);
  await assert.rejects(promptText('Server:'), /--server/u);
});
