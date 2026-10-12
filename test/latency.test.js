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
