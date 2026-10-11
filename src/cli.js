import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadState, saveState, deleteState, stateDirectory, validateServer, validateToken } from './state.js';
import { promptText } from './prompt.js';
import { chooseModel } from './provider.js';
import { resolveNative, resolveCodex, startTunnel, runCodex } from './tunnel.js';

export const help = `mcodex 0.1.0 — official Codex with automatic gateway setup

Usage:
  mcodex [Codex arguments]           Start Codex; first run asks for connection settings
  mcodex exec [Codex exec arguments] Run the official Codex non-interactively
  mcodex login [options]             Save and verify a gateway connection
  mcodex doctor                     Check dependencies, connection and available models
  mcodex logout                     Delete mcodex connection settings
  mcodex codex [arguments]           Pass a reserved command through to official Codex

Login options:
  --server <wss://host/path>  Gateway WSS endpoint
  --token-stdin              Read the connection Token from standard input
  --token-file <path>        Read the connection Token from a file
  --model <id>               Select an available default model

npm install -g mcodex
mcodex login --server wss://gateway.example/mlab-tunnel
mcodex

Connection Token is never accepted as a command-line argument.
MCODEX_CONFIG_DIR overrides the mcodex settings directory.
Codex arguments and its existing sandbox/approval settings remain available.
`;

export function parseLogin(args) {
  const options = {};
  const names = new Map([['--server', 'server'], ['--token-file', 'tokenFile'], ['--model', 'model']]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--token-stdin') {
      if (options.tokenStdin) throw new Error(`Duplicate option ${flag}.`);
      options.tokenStdin = true;
    } else if (names.has(flag)) {
      const name = names.get(flag);
      if (options[name] !== undefined) throw new Error(`Duplicate option ${flag}.`);
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
      options[name] = value;
    } else throw new Error(`Unknown login option ${flag}. Run mcodex --help.`);
  }
  if (options.tokenStdin && options.tokenFile) throw new Error('Choose either --token-stdin or --token-file.');
  return options;
}

async function stdinToken(signal) {
  signal?.throwIfAborted();
  const onAbort = () => process.stdin.destroy(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let value = '';
  try {
    for await (const chunk of process.stdin) {
      value += chunk.toString();
      if (value.length > 4096) throw new Error('Connection Token input is too long.');
    }
    return value.trim();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function login(options, directory, signal) {
  const server = validateServer(options.server ?? await promptText('Gateway WSS URL: '));
  const rawToken = options.tokenStdin ? await stdinToken(signal)
    : options.tokenFile ? (await readFile(options.tokenFile, 'utf8')).trim()
    : await promptText('Connection Token (hidden): ', { hidden: true });
  const token = validateToken(rawToken);
  const candidate = await mkdtemp(path.join(tmpdir(), 'mcodex-login-'));
  let tunnel;
  try {
    await saveState(candidate, { server, token, model: options.model });
    tunnel = await startTunnel(await loadState(candidate), { signal });
    const model = chooseModel(tunnel.models, options.model);
    signal?.throwIfAborted();
    await saveState(directory, { server, token, model });
    console.error(`mcodex: connection verified; ${tunnel.models.length} models, default ${model}.`);
    console.error(`mcodex: connection settings saved to ${directory}.`);
  } finally {
    await tunnel?.close();
    await rm(candidate, { recursive: true, force: true });
  }
}

export async function main(args) {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    process.stdout.write(help);
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-V') {
    console.log('mcodex 0.1.0 (official Codex 0.162.1)');
    return 0;
  }
  const directory = stateDirectory();
  if (args[0] === 'logout') {
    if (args.length !== 1) throw new Error('mcodex logout takes no arguments.');
    await deleteState(directory);
    console.error('mcodex: saved connection removed.');
    return 0;
  }
  const controller = new AbortController();
  const signals = ['SIGINT', 'SIGTERM'];
  const handlers = signals.map(signal => {
    const handler = () => controller.abort(Object.assign(new Error(`Interrupted by ${signal}.`), { signal }));
    process.on(signal, handler);
    return handler;
  });
  let tunnel;
  try {
    if (args[0] === 'login') {
      await login(parseLogin(args.slice(1)), directory, controller.signal);
      return 0;
    }
    let state;
    try { state = await loadState(directory); }
    catch (error) {
      if (error.code !== 'MCODEX_NOT_CONFIGURED' || args[0] === 'doctor' || !process.stdin.isTTY) throw error;
      await login({}, directory, controller.signal);
      state = await loadState(directory);
    }
    await resolveNative();
    resolveCodex();
    tunnel = await startTunnel(state, { signal: controller.signal });
    if (args[0] === 'doctor') {
      if (args.length !== 1) throw new Error('mcodex doctor takes no arguments.');
      console.log(`mcodex: Node ${process.version}; native transport and official Codex installed.`);
      console.log(`mcodex: authenticated WSS connection OK; ${tunnel.models.length} models.`);
      console.log(tunnel.models.map(item => item.id).join('\n'));
      return 0;
    }
    if (args[0] === 'codex') args = args.slice(1);
    return await runCodex(tunnel, args, { model: chooseModel(tunnel.models, state.model), signal: controller.signal });
  } finally {
    await tunnel?.close();
    signals.forEach((signal, i) => process.removeListener(signal, handlers[i]));
  }
}
