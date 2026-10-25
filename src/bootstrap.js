import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { selectRuntime, checkRuntimeUpdate, updateRuntime, rollbackRuntime, runtimeDirectory } from './runtime-update.js';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

export async function bootstrap(args, { runtimeOptions = {}, stdout = console.log, stderr = console.error, load = url => import(url) } = {}) {
  if (args[0] === 'runtime') {
    if (args.length !== 2 || args[1] !== 'status') throw new Error('Use mcodex runtime status.');
    const selected = await selectRuntime({ ...runtimeOptions, onWarning: stderr });
    stdout(`Launcher ${manifest.version}; runtime ${selected.version}; source: ${selected.source}.`);
    stdout(`Runtime cache: ${runtimeOptions.directory ?? runtimeDirectory()}`);
    return 0;
  }
  if (args[0] === 'update') {
    if (args.length > 2 || args.length === 2 && args[1] !== '--check') throw new Error('Use mcodex update or mcodex update --check.');
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    try {
      if (args[1] === '--check') {
        const result = await checkRuntimeUpdate({ ...runtimeOptions, signal: controller.signal });
        stdout(`Runtime ${result.selected.version}; stable ${result.manifest.version}; ${result.available ? 'update available' : 'up to date'}.`);
      } else {
        stdout('Checking the signed runtime channel; the active version changes only after verification and a local health check.');
        const result = await updateRuntime({ ...runtimeOptions, signal: controller.signal });
        stdout(`Runtime ${result.version}; ${result.changed ? 'installed and activated' : 'already up to date'}.`);
      }
      return 0;
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  }
  if (args[0] === 'rollback') {
    if (args.length > 2 || args.length === 2 && args[1] !== '--bundled') throw new Error('Use mcodex rollback or mcodex rollback --bundled.');
    const result = await rollbackRuntime({ ...runtimeOptions, bundled: args[1] === '--bundled' });
    stdout(`Runtime ${result.version}; source: ${result.source}; rollback complete.`);
    return 0;
  }
  let selected = await selectRuntime({ ...runtimeOptions, onWarning: message => stderr(`mcodex: ${message}`) });
  let runtime;
  try { runtime = await load(pathToFileURL(selected.entry).href); }
  catch (error) {
    if (selected.source === 'bundled') throw error;
    stderr('mcodex: Runtime could not be loaded; using the bundled baseline.');
    runtime = await load(new URL('./cli.js', import.meta.url).href);
    selected = { source: 'bundled', version: manifest.version };
  }
  if (['--version', '-V', 'doctor', 'engine'].includes(args[0])) stdout(`Launcher ${manifest.version}; runtime ${selected.version}; source: ${selected.source}.`);
  // Never retry an executed command: it may already have changed files or sent
  // a generation request. Fallback above applies only before main is invoked.
  return runtime.main(args);
}
