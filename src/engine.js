import { spawn } from 'node:child_process';
import { constants, readFileSync } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const compatibility = JSON.parse(readFileSync(new URL('./engine-compatibility.json', import.meta.url), 'utf8'));
const wrapperEntry = fileURLToPath(new URL('../bin/mcodex.js', import.meta.url));
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const wrapperVersion = manifest.version;
export const bundledVersion = manifest.dependencies['@openai/codex'];
export const testedVersions = Object.freeze([...compatibility.tested_versions]);

export function bundledCodexEntry() {
  try { return require.resolve('@openai/codex/bin/codex.js'); }
  catch { throw new Error('The bundled official Codex CLI is missing. Reinstall mcodex.'); }
}

export function engineCommand(filename) {
  return /\.(?:[cm]?js)$/i.test(filename)
    ? { command: process.execPath, prefix: [filename] }
    : { command: filename, prefix: [] };
}

// Version inspection must not inherit a previous facade key. Clearing the
// selector also prevents an accidentally selected mcodex wrapper recursing.
function inspectionEnvironment(env) {
  const result = { ...env };
  delete result.MCODEX_LOCAL_KEY;
  delete result.MCODEX_CODEX_BIN;
  return result;
}

export async function commandVersion(command, args, { env = process.env, signal, timeoutMs = 5000 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: inspectionEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let bytes = 0;
    let failure;
    const stop = message => {
      failure ??= new Error(message);
      // The npm launcher can spawn a native Codex binary. Kill the inspection
      // process group so a timed-out launcher never leaves that child behind.
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => stop('Codex version inspection timed out.'), timeoutMs);
    const abort = () => stop('Codex version inspection was cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    const collect = (chunk, stdout) => {
      bytes += chunk.length;
      if (bytes > 65536) return stop('Codex version output exceeded its limit.');
      if (stdout) output += chunk.toString();
    };
    child.stdout.on('data', chunk => collect(chunk, true));
    child.stderr.on('data', chunk => collect(chunk, false));
    child.once('error', () => { failure ??= new Error('Unable to execute the selected Codex engine.'); });
    child.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(signal.reason ?? new Error('Codex version inspection was cancelled.'));
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error('The selected Codex engine failed its version check.'));
      resolve(output.trim());
    });
    if (signal?.aborted) abort();
  });
}

export async function resolveEngine({ env = process.env, signal, timeoutMs, bundledEntry = bundledCodexEntry } = {}) {
  const external = env.MCODEX_CODEX_BIN;
  if (external !== undefined && (typeof external !== 'string' || !external.trim())) {
    throw new Error('MCODEX_CODEX_BIN must name a Codex executable or JavaScript launcher. Unset it to use the bundled engine.');
  }
  const selected = external === undefined ? bundledEntry() : path.resolve(external);
  let filename;
  let details;
  try {
    filename = await realpath(selected);
    details = await stat(filename);
    await access(filename, /\.(?:[cm]?js)$/i.test(filename) ? constants.R_OK : constants.X_OK);
  } catch {
    throw new Error('The selected Codex engine is missing or cannot be executed. Unset MCODEX_CODEX_BIN to use the bundled engine.');
  }
  if (!details.isFile() || filename === await realpath(wrapperEntry)) {
    throw new Error('MCODEX_CODEX_BIN must point to Codex itself, not mcodex or a directory.');
  }
  const invocation = engineCommand(filename);
  // Native shims such as Volta use the invocation name to select Codex.
  // Validate their real target, but preserve the explicitly selected name.
  if (invocation.prefix.length === 0) invocation.command = selected;
  const output = await commandVersion(invocation.command, [...invocation.prefix, '--version'], { env, signal, timeoutMs });
  const match = output.match(/^codex-cli (\S+)\s*$/);
  if (!match || !versionPattern.test(match[1])) {
    throw new Error('The selected executable did not identify itself as the official Codex CLI.');
  }
  const version = match[1];
  if (external === undefined && version !== bundledVersion) {
    throw new Error('The bundled Codex executable does not match the package dependency. Reinstall mcodex.');
  }
  return { ...invocation, path: filename, version, source: external === undefined ? 'bundled' : 'external', tested: testedVersions.includes(version) };
}

export function formatEngine(engine) {
  return [
    `mcodex ${wrapperVersion}; bundled default Codex ${bundledVersion}.`,
    `Codex ${engine.version}; source: ${engine.source}; compatibility: ${engine.tested ? 'tested' : 'not yet tested'}.`,
    `Codex path: ${engine.path}`,
    ...(engine.prefix.length === 0 && engine.command !== engine.path ? [`Codex launcher path: ${engine.command}`] : []),
    ...(engine.tested ? [] : ['Warning: this explicitly selected Codex version has not passed the mcodex compatibility suite. Unset MCODEX_CODEX_BIN to use the bundled engine.']),
  ];
}

export async function checkEngineUpdate({ fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl('https://registry.npmjs.org/@openai%2fcodex/latest', {
    redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]),
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Unable to check the official Codex npm registry.'); }
  if (!response.body) throw new Error('The official Codex registry returned invalid metadata.');
  let text = '';
  for await (const chunk of response.body) {
    if (Buffer.byteLength(text) + chunk.length > 131072) {
      await response.body.cancel().catch(() => {});
      throw new Error('Official Codex registry response exceeded its limit.');
    }
    text += Buffer.from(chunk).toString();
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('The official Codex registry returned invalid metadata.'); }
  if (data.name !== '@openai/codex' || !versionPattern.test(data.version ?? '')) throw new Error('The official Codex registry returned invalid metadata.');
  return { version: data.version, tested: testedVersions.includes(data.version) };
}
