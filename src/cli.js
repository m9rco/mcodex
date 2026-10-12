import { measureLatency } from './latency.js';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadState, saveState, deleteState, stateDirectory, validateServer, validateToken } from './state.js';
import { promptText } from './prompt.js';
import { chooseModel } from './provider.js';
import { resolveNative, resolveCodex, startTunnel, runCodex } from './tunnel.js';

export const help = `mcodex 0.1.4 — official Codex with automatic gateway setup

Usage:
  mcodex [Codex arguments]           Start Codex; first run asks for connection settings
  mcodex exec [Codex exec arguments] Run the official Codex non-interactively
  mcodex login [options]             Verify the connection and open Codex in a terminal
  mcodex ping                       Measure five authenticated gateway request latencies
  mcodex doctor                     Check dependencies, connection and available models
  mcodex logout                     Delete mcodex connection settings
  mcodex codex [arguments]           Pass a reserved command through to official Codex

Login options:
  --server <wss://host/path>  Gateway WSS endpoint
  --token-stdin              Read the connection Token from standard input
  --token-file <path>        Read the connection Token from a file
  --model <id>               Select an available default model
  --no-launch                Save the connection without opening Codex

npm install -g @m9rco/mcodex
mcodex

Or configure the connection without opening Codex:
mcodex login --no-launch --server wss://gateway.example/mlab-tunnel

Connection Token is never accepted as a command-line argument.
MCODEX_CONFIG_DIR overrides the mcodex settings directory.
Codex arguments and its existing sandbox/approval settings remain available.
Login opens Codex when both standard input and output are terminals.
`;

export function parseLogin(args) {
  const options = {};
  const names = new Map([['--server', 'server'], ['--token-file', 'tokenFile'], ['--model', 'model']]);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--token-stdin' || flag === '--no-launch') {
      const name = flag === '--token-stdin' ? 'tokenStdin' : 'noLaunch';
      if (options[name]) throw new Error(`Duplicate option ${flag}.`);
      options[name] = true;
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

async function connectWithStatus(state, signal) {
  if (!process.stderr.isTTY) return startTunnel(state, { signal });
  console.error('mcodex: Connecting to the gateway...');
  const progress = setInterval(() => {
    console.error('mcodex: Still connecting to the gateway...');
  }, 5000);
  progress.unref();
  try {
    const tunnel = await startTunnel(state, { signal });
    console.error(`mcodex: Connection verified in ${tunnel.connectionMs.toFixed(0)} ms (includes startup and authentication).`);
    return tunnel;
  } finally {
    clearInterval(progress);
  }
}

async function launchCodex(tunnel, args, model, signal) {
  resolveCodex();
  if (process.stderr.isTTY) console.error('mcodex: Gateway connected. Starting Codex...');
  return runCodex(tunnel, args, { model, signal });
}

async function login(options, directory, signal, codexArgs) {
  const server = validateServer(options.server ?? await promptText('Gateway WSS URL: '));
  const rawToken = options.tokenStdin ? await stdinToken(signal)
    : options.tokenFile ? (await readFile(options.tokenFile, 'utf8')).trim()
    : await promptText('Connection Token (hidden): ', { hidden: true });
  const token = validateToken(rawToken);
  const candidate = await mkdtemp(path.join(tmpdir(), 'mcodex-login-'));
  let tunnel;
  try {
    await saveState(candidate, { server, token, model: options.model });
    tunnel = await connectWithStatus(await loadState(candidate), signal);
    const model = chooseModel(tunnel.models, options.model);
    signal?.throwIfAborted();
    await saveState(directory, { server, token, model });
    console.error(`mcodex: connection verified; ${tunnel.models.length} models, default ${model}.`);
    console.error(`mcodex: connection settings saved to ${directory}.`);
    if (codexArgs !== undefined) return await launchCodex(tunnel, codexArgs, model, signal);
    console.error('mcodex: Setup complete. Run `mcodex` to open Codex.');
    return 0;
  } finally {
    try { await tunnel?.close(); }
    finally { await rm(candidate, { recursive: true, force: true }); }
  }
}

export async function main(args) {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    process.stdout.write(help);
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-V') {
    console.log('mcodex 0.1.4 (official Codex 0.162.1)');
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
      const options = parseLogin(args.slice(1));
      const launch = !options.noLaunch && process.stdin.isTTY && process.stdout.isTTY;
      return await login(options, directory, controller.signal, launch ? [] : undefined);
    }
    let state;
    try { state = await loadState(directory); }
    catch (error) {
      if (error.code !== 'MCODEX_NOT_CONFIGURED' || ['doctor', 'ping'].includes(args[0]) || !process.stdin.isTTY) throw error;
      console.error('mcodex: First-time setup. Codex will start after the connection is configured.');
      return await login({}, directory, controller.signal, args[0] === 'codex' ? args.slice(1) : args);
    }
    if (['doctor', 'ping'].includes(args[0]) && args.length !== 1) throw new Error(`mcodex ${args[0]} takes no arguments.`);
    await resolveNative();
    if (args[0] !== 'ping') resolveCodex();
    tunnel = await connectWithStatus(state, controller.signal);
    if (args[0] === 'ping') {
      console.log(`mcodex: ${new URL(state.server).host}; authenticated requests over WSS (includes relay and gateway processing).`);
      console.log(`Connection setup: ${tunnel.connectionMs.toFixed(0)} ms`);
      const result = await measureLatency(tunnel, { signal: controller.signal });
      result.samples.forEach((sample, i) => console.log(`${i + 1}: ${sample.ms === undefined ? sample.error : sample.ms.toFixed(1) + ' ms'}`));
      console.log(`Failed requests: ${result.failed}/${result.samples.length}`);
      if (result.average !== null) console.log(`min/avg/max: ${result.min.toFixed(1)}/${result.average.toFixed(1)}/${result.max.toFixed(1)} ms`);
      return result.failed ? 1 : 0;
    }
    if (args[0] === 'doctor') {
      if (args.length !== 1) throw new Error('mcodex doctor takes no arguments.');
      console.log(`mcodex: Node ${process.version}; native transport and official Codex installed.`);
      console.log(`mcodex: authenticated WSS connection OK; ${tunnel.models.length} models; connection setup ${tunnel.connectionMs.toFixed(0)} ms.`);
      console.log(tunnel.models.map(item => item.id).join('\n'));
      return 0;
    }
    if (args[0] === 'codex') args = args.slice(1);
    const model = chooseModel(tunnel.models, state.model);
    return await launchCodex(tunnel, args, model, controller.signal);
  } finally {
    await tunnel?.close();
    signals.forEach((signal, i) => process.removeListener(signal, handlers[i]));
  }
}
