import { probeRelay, formatRelayPath } from './relay-path.js';
import { performance } from 'node:perf_hooks';
import { catalogScopePattern } from './state.js';

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const connectionFailures = {
  tunnel_connection_limit: 'Gateway connection limit reached. Close unused mcodex sessions, then reconnect.',
  tunnel_frame_budget_exhausted: 'Gateway tunnel buffer budget is busy. Wait for other sessions to finish, then reconnect.',
  connection_timeout: 'The WSS connection timed out. Check the endpoint, gateway availability and network routing.',
  connection_io_error: 'The WSS connection could not be established. Check DNS and network routing.',
  tls_error: 'WSS TLS validation failed. Check the endpoint certificate and relay TLS configuration.',
  handshake_rejected: 'Gateway rejected the WSS handshake. Check the endpoint, connection Token and relay configuration.',
  handshake_invalid: 'The WSS handshake was invalid. Install a compatible transport and verify the relay configuration.',
  connection_closed: 'The WSS connection was closed. Submitted generation requests are not replayed.',
  read_io_error: 'The WSS connection failed while reading. Check the relay and network; submitted requests are not replayed.',
  frame_invalid: 'The gateway sent an invalid tunnel frame. Check transport and gateway compatibility.',
  response_protocol_error: 'The gateway response violated the tunnel protocol. Check transport and gateway compatibility.',
  write_timeout: 'The WSS write deadline expired. Check network backpressure and relay health; submitted requests are not replayed.',
  write_io_error: 'The WSS connection failed while writing. Check the relay and network; submitted requests are not replayed.',
  heartbeat_timeout: 'The WSS heartbeat timed out. Check gateway load and relay or network health.',
  control_queue_unavailable: 'The tunnel control queue is unavailable. Check gateway load and reconnect after other sessions finish.',
  connection_aborted: 'The WSS connection was aborted. Submitted generation requests are not replayed.',
};
const failureStages = new Set(['connect', 'handshake', 'read', 'write', 'heartbeat', 'protocol']);

// Only stable codes are printable: the native process may encounter arbitrary
// upstream bodies, endpoint names and credential-bearing diagnostic metadata.
export function parseConnectionFailure(value) {
  if (!value || !failureStages.has(value.stage) || !Object.hasOwn(connectionFailures, value.code)) return null;
  const result = { stage: value.stage, code: value.code };
  if (Number.isSafeInteger(value.status) && value.status >= 100 && value.status <= 599) result.status = value.status;
  if (Number.isSafeInteger(value.retry_after_seconds) && value.retry_after_seconds >= 0 && value.retry_after_seconds <= 86400) result.retry_after_seconds = value.retry_after_seconds;
  return result;
}

export function formatConnectionFailure(value) {
  const failure = parseConnectionFailure(value);
  if (!failure) return null;
  const status = failure.status ? `; HTTP ${failure.status}` : '';
  const retry = failure.retry_after_seconds === undefined ? '' : `; retry after ${failure.retry_after_seconds} s`;
  return `${connectionFailures[failure.code]} [${failure.stage}/${failure.code}${status}${retry}]`;
}

async function boundedJson(response) {
  if (!response.body) throw new Error('Invalid diagnostics schema');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 32768) throw new Error('Diagnostics response exceeded its limit');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid diagnostics schema'); }
}

function transportLimits(value, connected) {
  if (!connected || !value || !['mlab-tunnel-v1', 'mlab-tunnel-v2'].includes(value.protocol)) return null;
  const names = ['effective_max_body_bytes', 'configured_max_body_bytes', 'request_body_budget_bytes'];
  if (!names.every(name => Number.isSafeInteger(value[name]) && value[name] > 0)) return null;
  if (value.effective_max_body_bytes > value.configured_max_body_bytes || value.configured_max_body_bytes > 32 * 1024 * 1024
      || value.request_body_budget_bytes > 1024 * 1024 * 1024
      || (value.protocol === 'mlab-tunnel-v1' && value.effective_max_body_bytes > 1024 * 1024)) return null;
  const result = { protocol: value.protocol, ...Object.fromEntries(names.map(name => [name, value[name]])) };
  if (typeof value.server_version === 'string' && value.server_version.length <= 64 && versionPattern.test(value.server_version)) result.server_version = value.server_version;
  return result;
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
export async function readDiagnostics(tunnel, { signal, request = fetch, timeoutMs = 3000 } = {}) {
  const response = await request(`${tunnel.origin}/diagnostics`, {
    headers: { Authorization: `Bearer ${tunnel.key}` },
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return { available: false, reason: 'native diagnostics unavailable; update native transport' };
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Diagnostics HTTP ${response.status}`);
  }
  const value = await boundedJson(response);
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
    catalog_scope: value.connected && catalogScopePattern.test(value.catalog_scope ?? '') ? value.catalog_scope : null,
    tunnel: { metric: 'websocket_ping_round_trip', rtt: measured }, hops: [],
    transport: transportLimits(value.transport, value.connected),
    last_connection_error: value.connected ? null : parseConnectionFailure(value.last_connection_error),
    hop_status: 'relay_observations_unavailable' };
}

// Used while the model catalog is not yet reachable. Failure observations are
// advisory; missing diagnostics from a legacy transport must remain compatible.
export async function readConnectionFailure(origin, key, { signal, timeoutMs = 1000, request = fetch } = {}) {
  try {
    const value = await readDiagnostics({ origin, key }, { signal, timeoutMs, request });
    return value.last_connection_error ?? null;
  } catch (error) {
    signal?.throwIfAborted();
    return null;
  }
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
    lines.push(`WSS heartbeat RTT: ${rtt.latest_ms.toFixed(1)} ms; age ${(rtt.age_ms / 1000).toFixed(1)} s${stats} (includes relays).`);
  } else lines.push('WSS heartbeat RTT: no current observation.');
  if (!value.hops?.length) lines.push('Per-hop latency: unavailable; relay-side observations required.');
  const transport = transportLimits(value.transport, value.connected);
  if (transport) {
    const mib = bytes => (bytes / (1024 * 1024)).toFixed(1);
    lines.push(`Transport: protocol ${transport.protocol === 'mlab-tunnel-v2' ? 'v2' : 'v1'}; request-body cap ${mib(transport.effective_max_body_bytes)} MiB (${transport.effective_max_body_bytes} bytes); configured ${mib(transport.configured_max_body_bytes)} MiB; buffer budget ${mib(transport.request_body_budget_bytes)} MiB.`);
    lines.push(`Gateway version: ${transport.server_version ?? 'unavailable (older gateway)'}; observed through the authenticated WSS handshake.`);
    if (transport.protocol === 'mlab-tunnel-v1') lines.push('Legacy v1 fallback: request bodies remain capped at 1 MiB; update both the mcodex native transport and gateway for larger contexts.');
    else if (transport.effective_max_body_bytes <= 1024 * 1024) lines.push('Low request-body limit: at most 1 MiB is configured; check both client and gateway max_body_bytes. This is separate from the model token window.');
  } else lines.push('Transport protocol/body limits: unavailable (older native transport, disconnected or invalid observation).');
  if (!value.connected) {
    const failure = formatConnectionFailure(value.last_connection_error);
    if (failure) lines.push(failure);
  }
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
