import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withShellEnvironment } from '../src/shell-environment.js';

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'mcodex-shell-test-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  const workspace = path.join(directory, 'workspace');
  const alternate = path.join(workspace, "other workspace's files");
  await Promise.all([home, alternate].map(item => mkdir(item, { recursive: true })));
  for (const cwd of [workspace, alternate]) await writeFile(path.join(cwd, 'marker'), 'workspace-marker\n');
  return { home, workspace, alternate, env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, 'codex') } };
}

test('Bash initialization keeps exports and functions but cannot change the tool cwd', async t => {
  const f = await fixture(t);
  const startup = path.join(f.home, "startup script's file");
  const source = 'export TEST_INIT=initialized\nfixture_function() { printf function-ok; }\ncd "$HOME"\n';
  await writeFile(startup, source);
  let guarded;
  await withShellEnvironment({ ...f.env, BASH_ENV: startup }, async env => {
    guarded = env.BASH_ENV;
    assert.equal(env.HOME, f.home);
    assert.equal(env.CODEX_HOME, f.env.CODEX_HOME);
    assert.equal((await stat(path.dirname(guarded))).mode & 0o777, 0o700);
    assert.equal((await stat(guarded)).mode & 0o777, 0o600);
    for (const cwd of [f.workspace, f.alternate]) {
      const result = spawnSync('bash', ['-c', 'pwd -P; cat marker; printf "%s\\n" "$TEST_INIT"; fixture_function'], { cwd, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${cwd}\nworkspace-marker\ninitialized\nfunction-ok`);
    }
  });
  assert.equal(await readFile(startup, 'utf8'), source);
  await assert.rejects(stat(path.dirname(guarded)), { code: 'ENOENT' });
});

test('Bash startup references expand HOME without evaluating file names as commands', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.home, 'startup file'), 'export TEST_INIT=expanded\ncd "$HOME"\n');
  for (const value of ['$HOME/startup file', '${HOME}/startup file', '~/startup file']) {
    await withShellEnvironment({ ...f.env, BASH_ENV: value }, async env => {
      const result = spawnSync('bash', ['-c', 'pwd -P; printf "%s" "$TEST_INIT"'], { cwd: f.workspace, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${f.workspace}\nexpanded`);
    });
  }
});

test('Zsh initialization preserves its custom ZDOTDIR and the executor-selected cwd', async t => {
  if (spawnSync('/bin/zsh', ['--version']).error?.code === 'ENOENT') return t.skip('Zsh is not installed');
  const f = await fixture(t);
  const original = path.join(f.home, 'zsh configuration');
  await mkdir(original);
  const source = 'export TEST_INIT=zsh-initialized\ncd "$HOME"\n';
  await writeFile(path.join(original, '.zshenv'), source);
  await withShellEnvironment({ ...f.env, ZDOTDIR: original }, async env => {
    for (const cwd of [f.workspace, f.alternate]) {
      const result = spawnSync('/bin/zsh', ['-c', 'pwd -P; cat marker; printf "%s\\n%s" "$TEST_INIT" "$ZDOTDIR"'], { cwd, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${cwd}\nworkspace-marker\nzsh-initialized\n${original}`);
    }
  });
  assert.equal(await readFile(path.join(original, '.zshenv'), 'utf8'), source);
});

test('private startup files are removed when the Codex invocation fails', async t => {
  const f = await fixture(t);
  let directory;
  await assert.rejects(withShellEnvironment(f.env, async env => {
    directory = env.ZDOTDIR;
    throw new Error('synthetic process failure');
  }), /synthetic process failure/);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});
