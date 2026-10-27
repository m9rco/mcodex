import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const restore = (name, env) => Object.hasOwn(env, name)
  ? `export ${name}=${quote(env[name])}` : `unset ${name}`;

function startupPath(value, env) {
  // Resolve ordinary startup-file references without evaluating shell code.
  const expanded = (value.startsWith('~/') && env.HOME ? env.HOME + value.slice(1) : value)
    .replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
      (_match, braced, plain) => env[braced ?? plain] ?? '');
  // `.` must not search PATH for a different startup file.
  return expanded.startsWith('/') ? expanded : `./${expanded}`;
}

// Non-login shells still read BASH_ENV/ENV and .zshenv. Preserve their exports,
// functions and options, then restore the cwd supplied by Codex for THIS tool
// invocation. A session-wide cd would break --cd and model-selected workdirs.
function startup({ kind, env, prefix }) {
  const cwd = `${prefix}_cwd`;
  const keep = `${prefix}_keep`;
  const zsh = kind === 'zsh';
  const lines = [
    `${cwd}=$(command pwd -P) || exit $?`,
    `${keep}=1`,
    ...(zsh ? [
      `if [[ -o login ]]; then ${keep}=0; fi`,
      restore('ZDOTDIR', env),
      'if [[ -r "${ZDOTDIR-$HOME}/.zshenv" ]]; then builtin source "${ZDOTDIR-$HOME}/.zshenv"; fi',
    ] : [
      // Explicit login-shell opt-in retains the original startup semantics.
      ...(kind === 'bash' ? [`if shopt -q login_shell; then ${keep}=0; fi`] : []),
      restore('BASH_ENV', env),
      restore('ENV', env),
      ...(env[kind === 'bash' ? 'BASH_ENV' : 'ENV']
        ? [`. ${quote(startupPath(env[kind === 'bash' ? 'BASH_ENV' : 'ENV'], env))}`] : []),
    ]),
    `if [ "$${keep}" = 1 ]; then ${zsh ? 'builtin cd -q' : 'command cd'} -- "$${cwd}" || exit $?; fi`,
    `unset ${cwd} ${keep}`,
    '',
  ];
  return lines.join('\n');
}

export async function withShellEnvironment(env, run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcodex-shell-'));
  try {
    await chmod(directory, 0o700);
    const prefix = `__mcodex_${randomBytes(8).toString('hex')}`;
    const bash = path.join(directory, 'bash-env');
    const posix = path.join(directory, 'sh-env');
    await Promise.all([
      writeFile(bash, startup({ kind: 'bash', env, prefix }), { flag: 'wx', mode: 0o600 }),
      writeFile(posix, startup({ kind: 'sh', env, prefix }), { flag: 'wx', mode: 0o600 }),
      writeFile(path.join(directory, '.zshenv'), startup({ kind: 'zsh', env, prefix }), { flag: 'wx', mode: 0o600 }),
    ]);
    return await run({ ...env, BASH_ENV: bash, ...(Object.hasOwn(env, 'ENV') ? { ENV: posix } : {}), ZDOTDIR: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
