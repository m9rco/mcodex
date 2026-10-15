import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { validateServer, readConnectionToken } from './state.js';

const MAX_RESPONSE_BYTES = 8192;
const SAFE_NODE = /^[a-zA-Z0-9.-]{1,128}$/;

export function parseRelayObservation(headers) {
  if (headers['x-mlab-probe-version'] !== '1') return null;
  const from = headers['x-mlab-probe-node'];
  const to = headers['x-mlab-probe-next'];
  const seconds = headers['x-mlab-upstream-seconds'];
  // Reject comma-separated retries, infinities and unknown values. A zero from
  // nginx is below its 1 ms timer resolution; it is not a missing observation.
  if (!SAFE_NODE.test(from ?? '') || !SAFE_NODE.test(to ?? '') || from === to || typeof seconds !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(seconds)) return null;
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms) || ms < 0 || ms > 30000) return null;
  return { from, to, metric: 'downstream_header_ms', ms, source: from, samples: 1, timer_resolution_ms: 1, includes: 'time to downstream health response headers; includes all later relays and TCP/TLS' };
}

export function parseRelayObservations(headers) {
  const hops = [];
  if (Object.keys(headers).some(name => /^x-mlab-hop-\d+$/.test(name) && !/^x-mlab-hop-[1-8]$/.test(name))) return [];
  for (let index = 1; index <= 8; index++) {
    const value = headers[`x-mlab-hop-${index}`];
    if (value === undefined) {
      // A broken chain cannot be represented as complete observations.
      if (Object.keys(headers).some(name => /^x-mlab-hop-\d+$/.test(name) && Number(name.slice(11)) > index)) return [];
      break;
    }
    if (typeof value !== 'string') return [];
    const parts = value.split(';');
    if (![3, 4].includes(parts.length)) return [];
    const hop = parseRelayObservation({ 'x-mlab-probe-version': headers['x-mlab-probe-version'], 'x-mlab-probe-node': parts[0], 'x-mlab-probe-next': parts[1], 'x-mlab-upstream-seconds': parts[2] });
    if (!hop || (hops.length && hops.at(-1).to !== hop.from) || hops.some(previous => previous.from === hop.to)) return [];
    if (parts.length === 4) {
      const connect = parseRelayObservation({ 'x-mlab-probe-version': '1', 'x-mlab-probe-node': parts[0], 'x-mlab-probe-next': parts[1], 'x-mlab-upstream-seconds': parts[3] });
      if (!connect || connect.ms > hop.ms + 1) return [];
      hop.connect_ms = connect.ms;
    }
    hops.push(hop);
  }
  if (headers['x-mlab-hop-9'] !== undefined) return [];
  if (!hops.length) {
    const legacy = parseRelayObservation(headers);
    if (legacy) hops.push(legacy);
  }
  return hops;
}

// HTTPS only, configured origin only, no redirects, no arbitrary target address.
// The same connection Token is sent only to the already configured TLS peer.
export async function probeRelay(state, { signal, timeoutMs = 3000, request = https.request } = {}) {
  const endpoint = new URL(validateServer(state.server));
  endpoint.protocol = 'https:';
  endpoint.pathname = '/mlab-probe';
  const token = await readConnectionToken(state);
  signal?.throwIfAborted();
  const started = performance.now();
  return new Promise((resolve, reject) => {
    let tcpStart = started;
    let tcpMs = null;
    let tlsMs = null;
    const abort = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    let req;
    try { req = request(endpoint, {
      method: 'GET', headers: { Authorization: `Bearer ${token}` },
      signal: abort, agent: false, rejectUnauthorized: true,
    }, response => {
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) response.destroy(new Error('Probe response too large'));
      });
      response.on('error', () => reject(new Error('Relay probe failed')));
      response.on('end', () => {
        if (response.statusCode === 404) return resolve({ available: false, reason: 'probe_not_deployed' });
        if (response.statusCode !== 200) return reject(new Error(`Relay probe HTTP ${response.statusCode}`));
        const parsedHops = parseRelayObservations(response.headers);
        const upstreamHops = parsedHops[0]?.from === endpoint.hostname ? parsedHops : [];
        resolve({
          available: true, schema_version: 1,
          endpoint: endpoint.host, received_at: new Date().toISOString(), request_ms: performance.now() - started,
          hops: [
            { from: 'client', to: endpoint.hostname, metric: 'tcp_connect_ms', ms: tcpMs, source: 'client', includes: 'TCP handshake after DNS' },
            { from: 'client', to: endpoint.hostname, metric: 'tls_setup_ms', ms: tlsMs, source: 'client', includes: 'TLS handshake after TCP' },
            ...upstreamHops,
          ],
          hop_status: upstreamHops.length ? 'observed' : 'upstream_observation_unavailable',
        });
      });
    }); } catch { reject(new Error('Relay probe failed')); return; }
    req.on('socket', socket => {
      socket.once('lookup', () => { tcpStart = performance.now(); });
      socket.once('connect', () => { tcpMs = performance.now() - tcpStart; });
      socket.once('secureConnect', () => { tlsMs = performance.now() - tcpStart - (tcpMs ?? 0); });
    });
    req.on('error', () => reject(new Error('Relay probe failed or timed out')));
    req.end();
  });
}

export function formatRelayPath(value) {
  if (!value?.available) return [value?.reason === 'probe_not_deployed'
    ? 'Per-hop probe unavailable (not deployed at this endpoint).' : 'Per-hop probe unavailable (probe failed).'];
  const lines = value.hops.flatMap(hop => [
    `${hop.from} → ${hop.to}: ${hop.ms === null ? 'unavailable' : hop.ms.toFixed(1) + ' ms'} [${hop.metric}; ${hop.includes}]`,
    ...(hop.connect_ms === undefined ? [] : [`${hop.from} → ${hop.to}: ${hop.connect_ms.toFixed(1)} ms [adjacent TCP/TLS setup; nginx 1 ms resolution]`]),
  ]);
  const age = Math.max(0, Date.now() - Date.parse(value.received_at));
  lines.unshift(`Per-hop probe: 1 sample; age ${(age / 1000).toFixed(1)} s; total ${value.request_ms.toFixed(1)} ms. Independent cold probe; downstream times are cumulative, not additive.`);
  if (value.hop_status === 'upstream_observation_unavailable') lines.push('Relay → gateway timing: unavailable; no verified observation supplied.');
  return lines;
}
