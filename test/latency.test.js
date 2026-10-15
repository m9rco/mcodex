import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { measureLatency } from '../src/latency.js';

const tunnel = { origin: 'http://127.0.0.1:1234', key: 'dummy-local-key' };

test('latency probes use authenticated read-only catalog requests and count failures', async () => {
  let calls = 0;
  const result = await measureLatency(tunnel, { count: 3, request: async (url, options) => {
    assert.equal(url, `${tunnel.origin}/v1/models`);
    assert.equal(options.headers.Authorization, `Bearer ${tunnel.key}`);
    calls++;
    if (calls === 2) return new Response('{}', { status: 503 });
    return { ok: true, arrayBuffer: async () => { await delay(20); return new ArrayBuffer(0); } };
  } });
  assert.equal(calls, 3);
  assert.equal(result.failed, 1);
  assert.equal(result.samples[1].error, 'HTTP 503');
  assert.ok(result.min >= 15, 'measure complete responses, not just headers');
  assert.ok(result.average >= result.min && result.average <= result.max);
});

test('all failed requests produce no misleading latency and redact raw errors', async () => {
  const result = await measureLatency(tunnel, { count: 2, request: async () => { throw new Error(tunnel.key); } });
  assert.equal(result.failed, 2);
  assert.equal(result.average, null);
  assert.equal(JSON.stringify(result).includes(tunnel.key), false);
});

test('interrupting a probe stops the remaining requests', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(measureLatency(tunnel, { signal: controller.signal, request: async () => {
    calls++;
    controller.abort(new Error('interrupted'));
    throw controller.signal.reason;
  } }), /interrupted/);
  assert.equal(calls, 1);
});

test('optional diagnostics preserve old native transport compatibility', async () => {
  const { readDiagnostics, formatDiagnostics } = await import('../src/latency.js');
  const result = await readDiagnostics(tunnel, { request: async () => new Response('', { status: 404 }) });
  assert.equal(result.available, false);
  assert.match(formatDiagnostics(result)[0], /older native transport/);
});

test('diagnostics distinguish actual RTT from absent hop observations', async () => {
  const { readDiagnostics, formatDiagnostics } = await import('../src/latency.js');
  const result = await readDiagnostics(tunnel, { request: async () => Response.json({ schema_version: 1, connected: true, tunnel: { rtt: { latest_ms: 23.5, age_ms: 1000 } }, hops: [] }) });
  assert.match(formatDiagnostics(result)[0], /23.5 ms/);
  assert.match(formatDiagnostics(result)[1], /unavailable/);
  assert.match(formatDiagnostics({ ...result, connected: false })[0], /no current observation/);
  await assert.rejects(readDiagnostics(tunnel, { request: async () => Response.json({schema_version: 9}) }), /Invalid diagnostics/);
});

test('unified telemetry does not let optional probe failure invalidate a WSS link', async () => {
  const { collectTelemetry, formatTelemetry } = await import('../src/latency.js');
  const snapshot = await collectTelemetry(tunnel, {}, {
    diagnostics: async () => ({ available: true, connected: true, tunnel: { rtt: { latest_ms: 10, age_ms: 0 } }, hops: [] }),
    relay: async () => { throw new Error('private upstream details'); },
  });
  assert.equal(snapshot.path.available, false);
  assert.match(formatTelemetry(snapshot)[0], /10.0 ms/);
  assert.equal(JSON.stringify(snapshot).includes('private upstream'), false);
});

test('unified telemetry preserves cancellation', async () => {
  const { collectTelemetry } = await import('../src/latency.js');
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(collectTelemetry(tunnel, {}, { signal: controller.signal, diagnostics: async () => { throw new Error('cancelled'); }, relay: async () => { throw new Error('cancelled'); } }), /cancelled/);
});

test('diagnostic snapshots exclude unknown metadata and clear disconnected RTT', async () => {
  const { readDiagnostics, formatDiagnostics } = await import('../src/latency.js');
  const body = { schema_version: 1, connected: true, secret: 'fixture-secret', tunnel: {
    secret: 'fixture-secret', rtt: { latest_ms: 12, age_ms: 0, min_ms: 10, average_ms: 11, max_ms: 12, samples: 2, secret: 'fixture-secret' },
  }, hops: [] };
  const result = await readDiagnostics(tunnel, { request: async () => Response.json(body) });
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.match(formatDiagnostics(result)[0], /samples 2; min\/avg\/max 10.0\/11.0\/12.0/);
  const disconnected = await readDiagnostics(tunnel, { request: async () => Response.json({ ...body, connected: false }) });
  assert.equal(disconnected.tunnel.rtt, null);
  assert.match(formatDiagnostics(disconnected)[0], /no current observation/);
});

test('synchronous optional collectors are isolated and failure is not mislabeled as old transport', async () => {
  const { collectTelemetry, formatTelemetry } = await import('../src/latency.js');
  const snapshot = await collectTelemetry(tunnel, {}, { diagnostics() { throw new Error('fixture secret'); }, relay() { throw new Error('fixture secret'); } });
  assert.equal(snapshot.diagnostics.available, false);
  assert.equal(snapshot.path.available, false);
  assert.equal(JSON.stringify(snapshot).includes('fixture secret'), false);
  assert.match(formatTelemetry(snapshot)[0], /probe failed/);
  assert.match(formatTelemetry(snapshot)[1], /probe failed/);
});
