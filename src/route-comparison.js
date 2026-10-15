import { validateServer } from './state.js';

export function parsePing(args) {
  if (!args.length) return {};
  if (args.length !== 2 || args[0] !== '--compare') throw new Error('Usage: mcodex ping [--compare <wss://host/path>]');
  return { compare: validateServer(args[1]) };
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
      const result = await probe(tunnel, { count: 1, signal });
      samples.push(result.samples[0]);
    }
  }
  const summarize = samples => {
    const values = samples.filter(sample => sample.ms !== undefined).map(sample => sample.ms);
    return { samples, failed: samples.length - values.length, average: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
  };
  return { current: summarize(baseline), candidate: summarize(alternative) };
}

export function formatComparison(result) {
  const line = (label, value) => `${label}: ${value.average === null ? 'unavailable' : value.average.toFixed(1) + ' ms average'}; failed ${value.failed}/${value.samples.length}`;
  const lines = [line('Configured route', result.current), line('Compared route', result.candidate)];
  if (!result.current.failed && !result.candidate.failed && result.current.average !== null && result.candidate.average !== null) {
    const delta = result.current.average - result.candidate.average;
    lines.push(`Compared route is ${Math.abs(delta).toFixed(1)} ms ${delta >= 0 ? 'faster' : 'slower'} in this sample. Repeat at busy periods before changing routes.`);
  } else lines.push('Incomplete samples: no route recommendation.');
  return lines;
}
