import { parsePing, compareRoutes, formatComparison } from './route-comparison.js';
import { measureLatency, collectTelemetry, formatTelemetry } from './latency.js';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadState, saveState, deleteState, stateDirectory, validateServer, validateToken } from './state.js';
import { promptText } from './prompt.js';
import { chooseModel } from './provider.js';
import { resolveNative, inspectNative, startTunnel, runCodex } from './tunnel.js';
import { wrapperVersion, resolveEngine, formatEngine, checkEngineUpdate } from './engine.js';

export const help = `mcodex ${wrapperVersion} — official Codex with automatic gateway setup

Usage:
  mcodex [Codex arguments]           Start Codex; first run asks for connection settings
  mcodex exec [Codex exec arguments] Run the official Codex non-interactively
  mcodex login [options]             Verify the connection and open Codex in a terminal
  mcodex ping [<WSS URL>] [options] Measure a saved or specified gateway; optionally compare two connections
  mcodex doctor                     Check dependencies, connection and available models
  mcodex doctor --local             Check local versions without connecting to a gateway
  mcodex engine status              Show the actual Codex version and selected executable
  mcodex engine check               Read the official npm version; does not install or switch
  mcodex runtime status             Show launcher/runtime versions and cache location
  mcodex update --check              Check the signed stable runtime channel
  mcodex update                      Install and activate a verified runtime without npm
  mcodex rollback [--bundled]         Select the previous runtime or the npm baseline
  mcodex logout                     Delete mcodex connection settings
  mcodex codex [arguments]           Pass a reserved command through to official Codex

Login options:
  --server <wss://host/path>  Gateway WSS endpoint
  --token-stdin              Read the connection Token from standard input
  --token-file <path>        Read the connection Token from a file
  --model <id>               Select an available default model
  --no-launch                Save the connection without opening Codex

Ping options:
  --server <wss://host/path>  Measure this endpoint without changing saved settings
  --compare <wss://host/path> Compare two independent connections, including the same endpoint

Ping uses your saved connection Token; endpoint overrides are temporary.

npm install -g @m9rco/mcodex
mcodex

Or configure the connection without opening Codex:
mcodex login --no-launch --server wss://gateway.example/mlab-tunnel

Connection Token is never accepted as a command-line argument.
MCODEX_CONFIG_DIR overrides the mcodex settings directory.
MCODEX_CODEX_BIN explicitly selects a separate Codex executable or JS launcher.
Unset MCODEX_CODEX_BIN to return to the tested bundled engine.
MCODEX_NATIVE_BIN explicitly selects a native transport; unset it to use the matched bundled package.
Codex arguments and its existing sandbox/approval settings remain available.
Codex starts in the calling directory; use --cd <path> to select another workspace.
Shell commands default to non-login mode to avoid login profiles changing directories.
Use -c allow_login_shell=true to explicitly restore login-shell behavior.
Login opens Codex when both standard input and output are terminals.
`;

function formatWorkspace() {
  return [
    `Launch directory: ${JSON.stringify(process.cwd())}`,
    `HOME: ${JSON.stringify(process.env.HOME ?? '(unset)')}`,
    `CODEX_HOME: ${JSON.stringify(process.env.CODEX_HOME ?? '(default under user home)')}`,
    'Shell default: non-login (allow_login_shell=false); explicit -c overrides apply.',
    'The launch directory is independent of HOME. --cd and resumed-session directory choices are handled by Codex.',
  ];
}

function formatNative(native, { path: showPath = false } = {}) {
  if (!native) return ['Native transport version: unavailable.'];
  const lines = [`Native transport: mlab-gateway ${native.version}; source: ${native.source}; package: ${native.packageVersion ?? 'external'}; bundled match: ${native.matchesExpected === true ? 'verified' : 'not verified'}.`];
  if (showPath) lines.push(`Native path: ${native.path}`);
  const [major, minor] = native.version.split('.').map(Number);
  if (major === 0 && minor < 4) lines.push('Legacy native transport: request bodies remain capped at 1 MiB even with a newer gateway. Install the current mcodex release on this client.');
  else if (native.source === 'external') lines.push('Explicit external native transport selected; compatibility is not guaranteed by the bundled release. Unset MCODEX_NATIVE_BIN to return to the matched transport.');
  return lines;
}

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

async function connectWithStatus(state, signal, { telemetry = false, allowCachedModels = false } = {}) {
  if (!process.stderr.isTTY) return startTunnel(state, { signal, allowCachedModels });
  console.error('mcodex: Connecting to the gateway...');
  const progress = setInterval(() => {
    console.error('mcodex: Still connecting to the gateway...');
  }, 5000);
  progress.unref();
  try {
    const tunnel = await startTunnel(state, { signal, allowCachedModels });
    console.error(`mcodex: Connection verified in ${tunnel.connectionMs.toFixed(0)} ms (includes startup and authentication).`);
    formatNative(tunnel.native).forEach(line => console.error(`mcodex: ${line}`));
    try {
      if (!telemetry) return tunnel;
      tunnel.telemetrySnapshot = await collectTelemetry(tunnel, state, { signal });
      formatTelemetry(tunnel.telemetrySnapshot).forEach(line => console.error(`mcodex: ${line}`));
    } catch (error) {
      if (signal?.aborted) {
        await tunnel.close();
        throw error;
      }
      // Optional observations never invalidate an authenticated Codex link.
      console.error('mcodex: Optional latency telemetry unavailable; continuing to Codex.');
    }
    return tunnel;
  } finally {
    clearInterval(progress);
  }
}

async function launchCodex(tunnel, args, model, signal, engine) {
  engine ??= await resolveEngine({ signal });
  if (!engine.tested) console.error(`mcodex: Warning: explicitly selected Codex ${engine.version} has not passed the compatibility suite; unset MCODEX_CODEX_BIN to use the bundled engine.`);
  if (process.stderr.isTTY) {
    formatEngine(engine).forEach(line => console.error(`mcodex: ${line}`));
    console.error(`mcodex: Launch directory: ${JSON.stringify(process.cwd())}; Codex --cd/resume choices still apply.`);
    console.error('mcodex: Gateway connected. Starting Codex...');
  }
  return runCodex(tunnel, args, { model, signal, engine });
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

function processCancellation() {
  const controller = new AbortController();
  const signals = ['SIGINT', 'SIGTERM'];
  const handlers = signals.map(signal => {
    const handler = () => controller.abort(Object.assign(new Error(`Interrupted by ${signal}.`), { signal }));
    process.on(signal, handler);
    return handler;
  });
  return { controller, cleanup: () => signals.forEach((signal, i) => process.removeListener(signal, handlers[i])) };
}

async function localCommand(action) {
  const { controller, cleanup } = processCancellation();
  try { return await action(controller.signal); }
  finally { cleanup(); }
}

export async function main(args) {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    process.stdout.write(help);
    return 0;
  }
  if (args[0] === '--version' || args[0] === '-V') {
    return localCommand(async signal => {
      formatEngine(await resolveEngine({ signal })).forEach(line => console.log(line));
      return 0;
    });
  }
  if (args[0] === 'engine') {
    if (args.length !== 2 || !['status', 'check'].includes(args[1])) throw new Error('Use mcodex engine status or mcodex engine check.');
    return localCommand(async signal => {
      const engine = await resolveEngine({ signal });
      formatEngine(engine).forEach(line => console.log(line));
      if (args[1] === 'check') {
        const latest = await checkEngineUpdate({ signal });
        console.log(`Official npm stable: Codex ${latest.version}; compatibility: ${latest.tested ? 'tested' : 'not yet tested'}.`);
        console.log('Read-only check: no package or engine selection was changed.');
      }
      return 0;
    });
  }
  if (args[0] === 'doctor' && args[1] === '--local' && args.length === 2) {
    return localCommand(async signal => {
      // Cold binaries need extra startup time; two probes leave room under the launcher's 30-second health budget.
      const versionInspection = { signal, timeoutMs: 10000 };
      formatWorkspace().forEach(line => console.log(line));
      formatEngine(await resolveEngine(versionInspection)).forEach(line => console.log(line));
      formatNative(await inspectNative(versionInspection), { path: true }).forEach(line => console.log(line));
      console.log(`Node ${process.version}; local checks only; no gateway connection.`);
      return 0;
    });
  }
  const directory = stateDirectory();
  if (args[0] === 'logout') {
    if (args.length !== 1) throw new Error('mcodex logout takes no arguments.');
    await deleteState(directory);
    console.error('mcodex: saved connection removed.');
    return 0;
  }
  const { controller, cleanup } = processCancellation();
  let tunnel;
  try {
    if (args[0] === 'login') {
      const options = parseLogin(args.slice(1));
      const launch = !options.noLaunch && process.stdin.isTTY && process.stdout.isTTY;
      return await login(options, directory, controller.signal, launch ? [] : undefined);
    }
    const ping = args[0] === 'ping' ? parsePing(args.slice(1)) : undefined;
    let state;
    try { state = await loadState(directory); }
    catch (error) {
      if (error.code !== 'MCODEX_NOT_CONFIGURED' || ['doctor', 'ping'].includes(args[0]) || !process.stdin.isTTY) throw error;
      console.error('mcodex: First-time setup. Codex will start after the connection is configured.');
      return await login({}, directory, controller.signal, args[0] === 'codex' ? args.slice(1) : args);
    }
    if (ping?.server) state = { ...state, server: ping.server };
    if (args[0] === 'doctor' && args.length !== 1) throw new Error('mcodex doctor takes no arguments.');
    await resolveNative();
    const engine = args[0] === 'ping' ? undefined : await resolveEngine({ signal: controller.signal });
    tunnel = await connectWithStatus(state, controller.signal, {
      telemetry: args[0] === 'doctor',
      allowCachedModels: !['doctor', 'ping'].includes(args[0]),
    });
    if (args[0] === 'ping') {
      if (ping.compare) {
        let candidate;
        try {
          console.log(`mcodex: Comparing ${new URL(state.server).host} and ${new URL(ping.compare).host}: two independent connections, 5 alternating paired probes; same saved connection Token.`);
          const candidateState = { ...state, server: ping.compare };
          candidate = await startTunnel(candidateState, { signal: controller.signal });
          const comparison = await compareRoutes(tunnel, candidate, { probe: measureLatency, signal: controller.signal });
          formatComparison(comparison, { currentServer: state.server, candidateServer: ping.compare,
            currentSetupMs: tunnel.connectionMs, candidateSetupMs: candidate.connectionMs }).forEach(line => console.log(line));
          const snapshots = await Promise.all([
            collectTelemetry(tunnel, state, { signal: controller.signal }),
            collectTelemetry(candidate, candidateState, { signal: controller.signal }),
          ]);
          for (const [index, label] of ['Baseline', 'Comparison'].entries()) {
            const host = new URL(index === 0 ? state.server : ping.compare).host;
            formatTelemetry(snapshots[index]).forEach(line => console.log(`${label} ${host}: ${line}`));
          }
          return comparison.current.failed || comparison.candidate.failed ? 1 : 0;
        } finally {
          await candidate?.close();
        }
      }
      console.log(`mcodex: ${new URL(state.server).host}; authenticated requests over WSS (includes relay and gateway processing).`);
      console.log(`Connection setup: ${tunnel.connectionMs.toFixed(0)} ms`);
      const result = await measureLatency(tunnel, { signal: controller.signal });
      result.samples.forEach((sample, i) => console.log(`${i + 1}: ${sample.ms === undefined ? sample.error : sample.ms.toFixed(1) + ' ms'}`));
      console.log(`Failed requests: ${result.failed}/${result.samples.length}`);
      if (result.average !== null) console.log(`min/avg/max: ${result.min.toFixed(1)}/${result.average.toFixed(1)}/${result.max.toFixed(1)} ms`);
      const snapshot = await collectTelemetry(tunnel, state, { signal: controller.signal });
      formatTelemetry(snapshot).forEach(line => console.log(line));
      return result.failed ? 1 : 0;
    }
    if (args[0] === 'doctor') {
      if (args.length !== 1) throw new Error('mcodex doctor takes no arguments.');
      formatWorkspace().forEach(line => console.log(line));
      console.log(`mcodex: Node ${process.version}; native transport and official Codex installed.`);
      formatEngine(engine).forEach(line => console.log(line));
      formatNative(tunnel.native, { path: true }).forEach(line => console.log(line));
      console.log(`mcodex: authenticated WSS connection OK; ${tunnel.models.length} models; connection setup ${tunnel.connectionMs.toFixed(0)} ms.`);
      const snapshot = tunnel.telemetrySnapshot ?? await collectTelemetry(tunnel, state, { signal: controller.signal });
      formatTelemetry(snapshot).forEach(line => console.log(line));
      console.log('Limit diagnosis: 413 is a transport request-body limit; 400 context_length_exceeded is the model token window; 429 may be a local memory/concurrency limit or upstream quota (check its code); 503 indicates connection/availability failure. These limits are independent.');
      console.log(tunnel.models.map(item => item.id).join('\n'));
      return 0;
    }
    if (args[0] === 'codex') args = args.slice(1);
    const model = chooseModel(tunnel.models, state.model);
    return await launchCodex(tunnel, args, model, controller.signal, engine);
  } finally {
    try { await tunnel?.close(); }
    finally { cleanup(); }
  }
}
