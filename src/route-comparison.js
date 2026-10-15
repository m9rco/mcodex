import { validateServer } from './state.js';

export function parsePing(args) {
  const options = {};
  const usage = () => new Error('Usage: mcodex ping [<WSS URL> | --server <WSS URL>] [--compare <WSS URL>]');
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--server' || flag === '--compare') {
      const name = flag === '--server' ? 'server' : 'compare';
      if (options[name] !== undefined) throw new Error(`Duplicate ${flag} option.`);
      const value = args[++i];
      if (!value || value.startsWith('--')) throw usage();
      options[name] = validateServer(value);
    } else {
      if (flag.startsWith('-') || options.server !== undefined) throw usage();
      options.server = validateServer(flag);
    }
  }
  return options;
}

// Compare established tunnel requests, not unequal cold-start handshakes.
// The user explicitly selects the second TLS endpoint; reuse its configured key.
export async function compareRoutes(current, candidate, { probe, signal, count = 5 } = {}) {
  const baseline = [];
  const alternative = [];
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted();
    // Alternate order to reduce warm-up/order bias. Keep timing independent.
    const order = i % 2 ? [[candidate, alternative], [current, baseline]] : [[current, baseline], [candidate, alternative]];
    for (const [tunnel, samples] of order) {
      signal?.throwIfAborted();
      const result = await probe(tunnel, { count: 1, signal });
      samples.push(result.samples[0]);
    }
  }
  const summarize = samples => {
    const values = samples.filter(sample => sample.ms !== undefined).map(sample => sample.ms);
    return { samples, failed: samples.length - values.length,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      average: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
  };
  return { current: summarize(baseline), candidate: summarize(alternative) };
}

export function formatComparison(result, { currentServer, candidateServer, currentSetupMs, candidateSetupMs } = {}) {
  const host = server => server ? new URL(server).host : 'unknown endpoint';
  const line = (label, server, setupMs, value) => {
    const setup = Number.isFinite(setupMs) ? `${setupMs.toFixed(0)} ms` : 'unavailable';
    const stats = value.average === null ? 'latency unavailable'
      : `${value.average.toFixed(1)} ms average; min/max ${value.min.toFixed(1)}/${value.max.toFixed(1)} ms`;
    return `${label} ${host(server)}: setup ${setup}; ${stats}; failed ${value.failed}/${value.samples.length}`;
  };
  const lines = [line('Baseline', currentServer, currentSetupMs, result.current), line('Comparison', candidateServer, candidateSetupMs, result.candidate)];
  const sameEndpoint = currentServer !== undefined && currentServer === candidateServer;
  if (!result.current.failed && !result.candidate.failed && result.current.average !== null && result.candidate.average !== null) {
    const delta = result.current.average - result.candidate.average;
    if (sameEndpoint) {
      lines.push(`Same endpoint, two independent connections: the second is ${Math.abs(delta).toFixed(1)} ms ${delta >= 0 ? 'faster' : 'slower'} in this sample. This measures connection variation.`);
    } else {
      lines.push(`Compared route is ${Math.abs(delta).toFixed(1)} ms ${delta >= 0 ? 'faster' : 'slower'} in this sample. Repeat at busy periods before changing routes.`);
    }
  } else lines.push('Incomplete samples: no route recommendation.');
  return lines;
}
