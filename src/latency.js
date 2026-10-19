import { probeRelay, formatRelayPath } from './relay-path.js';
import { performance } from 'node:perf_hooks';

function transportLimits(value, connected) {
  if (!connected || !value || !['mlab-tunnel-v1', 'mlab-tunnel-v2'].includes(value.protocol)) return null;
  const names = ['effective_max_body_bytes', 'configured_max_body_bytes', 'request_body_budget_bytes'];
  if (!names.every(name => Number.isSafeInteger(value[name]) && value[name] > 0)) return null;
  if (value.effective_max_body_bytes > value.configured_max_body_bytes || value.configured_max_body_bytes > 32 * 1024 * 1024
      || value.request_body_budget_bytes > 1024 * 1024 * 1024
      || (value.protocol === 'mlab-tunnel-v1' && value.effective_max_body_bytes > 1024 * 1024)) return null;
  return { protocol: value.protocol, ...Object.fromEntries(names.map(name => [name, value[name]])) };
}

// Measure an authenticated, read-only request over the established WSS tunnel.
// This includes gateway processing, not just the client-to-relay network RTT.
export async function measureLatency(tunnel, { count = 5, timeoutMs = 3000, signal, request = fetch } = {}) {
  const samples = [];
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted();
    const start = performance.now();
    try {
      const response = await request(`${tunnel.origin}/v1/models`, {
        headers: { Authorization: `Bearer ${tunnel.key}` },
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      samples.push({ ms: performance.now() - start });
    } catch (error) {
      signal?.throwIfAborted();
      // Never report raw transport errors that might contain credentials.
      samples.push({ error: /^HTTP \d{3}$/.test(error?.message) ? error.message : 'request failed or timed out' });
    }
  }
  const values = samples.filter(sample => sample.ms !== undefined).map(sample => sample.ms);
  return {
    samples,
    failed: count - values.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    average: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
  };
}

// Optional native diagnostics: old transports remain compatible and never turn
// missing observations into fabricated zero-latency hops.
export async function readDiagnostics(tunnel, { signal, request = fetch } = {}) {
  const response = await request(`${tunnel.origin}/diagnostics`, {
    headers: { Authorization: `Bearer ${tunnel.key}` },
    signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return { available: false, reason: 'native diagnostics unavailable; update native transport' };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Diagnostics HTTP ${response.status}`);
  }
  const value = await response.json();
  if (!value || value.schema_version !== 1 || typeof value.connected !== 'boolean' || !Array.isArray(value.hops) || value.hops.length > 8) {
    throw new Error('Invalid diagnostics schema');
  }
  // Keep the public snapshot limited to known measurements. Native responses
  // must never become a second configuration store or echo arbitrary metadata.
  const rtt = value.tunnel?.rtt;
  const measured = rtt && value.connected ? Object.fromEntries(
    ['samples', 'latest_ms', 'min_ms', 'average_ms', 'max_ms', 'age_ms'].map(name => [name,
      typeof rtt[name] === 'number' && Number.isFinite(rtt[name]) && rtt[name] >= 0 ? rtt[name] : null]),
  ) : null;
  return { available: true, schema_version: 1, connected: value.connected,
    tunnel: { metric: 'websocket_ping_round_trip', rtt: measured }, hops: [],
    transport: transportLimits(value.transport, value.connected),
    hop_status: 'relay_observations_unavailable' };
}

export function formatDiagnostics(value) {
  if (!value?.available) return [value?.reason?.startsWith('native diagnostics unavailable')
    ? 'Tunnel telemetry unavailable (older native transport).' : 'Tunnel telemetry unavailable (probe failed).'];
  const lines = [];
  const rtt = value.tunnel?.rtt;
  const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  if (value.connected && number(rtt?.latest_ms) && number(rtt?.age_ms)) {
    const stats = number(rtt.samples) && rtt.samples > 0 && ['min_ms', 'average_ms', 'max_ms'].every(name => number(rtt[name]))
      ? `; samples ${rtt.samples}; min/avg/max ${rtt.min_ms.toFixed(1)}/${rtt.average_ms.toFixed(1)}/${rtt.max_ms.toFixed(1)} ms` : '';
    lines.push(`WSS heartbeat RTT: ${rtt.latest_ms.toFixed(1)} ms; age ${(rtt.age_ms / 1000).toFixed(1)} s${stats} (includes all relays and control queue).`);
  } else lines.push('WSS heartbeat RTT: no current observation.');
  if (!value.hops?.length) lines.push('Per-hop latency: unavailable; relay-side observations required.');
  const transport = transportLimits(value.transport, value.connected);
  if (transport) {
    const mib = bytes => (bytes / (1024 * 1024)).toFixed(1);
    lines.push(`Transport: protocol ${transport.protocol === 'mlab-tunnel-v2' ? 'v2' : 'v1'}; request-body cap ${mib(transport.effective_max_body_bytes)} MiB (${transport.effective_max_body_bytes} bytes); configured ${mib(transport.configured_max_body_bytes)} MiB; buffer budget ${mib(transport.request_body_budget_bytes)} MiB.`);
    if (transport.protocol === 'mlab-tunnel-v1') lines.push('Legacy v1 fallback: request bodies remain capped at 1 MiB; update the gateway for larger contexts.');
  } else lines.push('Transport protocol/body limits: unavailable (older native transport, disconnected or invalid observation).');
  return lines;
}

// A single wrapper snapshot joins native WSS observations and independent relay
// probes. Neither unavailable source invalidates the established inference link.
export async function collectTelemetry(tunnel, state, { signal, diagnostics = readDiagnostics, relay = probeRelay } = {}) {
  signal?.throwIfAborted();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => diagnostics(tunnel, { signal })),
    Promise.resolve().then(() => relay(state, { signal })),
  ]);
  signal?.throwIfAborted();
  return {
    schema_version: 1,
    observed_at: new Date().toISOString(),
    diagnostics: results[0].status === 'fulfilled' ? results[0].value : { available: false },
    path: results[1].status === 'fulfilled' ? results[1].value : { available: false },
  };
}

export function formatTelemetry(snapshot) {
  let lines = formatDiagnostics(snapshot.diagnostics);
  if (snapshot.path.available) lines = lines.filter(line => !line.startsWith('Per-hop latency:'));
  return [...lines, ...formatRelayPath(snapshot.path)];
}
