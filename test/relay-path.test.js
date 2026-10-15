import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { saveState } from '../src/state.js';
import { parseRelayObservation, parseRelayObservations, probeRelay, formatRelayPath } from '../src/relay-path.js';

const valid = { 'x-mlab-probe-version': '1', 'x-mlab-probe-node': 'hk.example.com', 'x-mlab-probe-next': 'sg.example.com', 'x-mlab-upstream-seconds': '0.035' };
test('relay telemetry preserves units and provenance without inventing RTT', () => {
  const hop = parseRelayObservation(valid);
  assert.equal(hop.ms, 35);
  assert.equal(hop.metric, 'downstream_header_ms');
  for (const seconds of ['0.1, 0.2', '-', 'Infinity', '-1', '1e2', '31']) assert.equal(parseRelayObservation({ ...valid, 'x-mlab-upstream-seconds': seconds }), null);
  assert.equal(parseRelayObservation({ ...valid, 'x-mlab-probe-node': '\x1b[31m' }), null);
});
test('multiple relay observations must form a bounded contiguous chain', () => {
  const headers = { 'x-mlab-probe-version': '1', 'x-mlab-hop-1': 'hk;sg;0.035', 'x-mlab-hop-2': 'sg;egress;0.010' };
  assert.equal(parseRelayObservations(headers).length, 2);
  assert.equal(parseRelayObservations({ ...headers, 'x-mlab-hop-1': 'hk;sg;0.035;0.009' })[0].connect_ms, 9);
  assert.deepEqual(parseRelayObservations({ ...headers, 'x-mlab-hop-2': 'wrong;egress;0.01' }), []);
  assert.deepEqual(parseRelayObservations({ 'x-mlab-probe-version': '1', 'x-mlab-hop-2': 'sg;egress;0.01' }), []);
  assert.deepEqual(parseRelayObservations({ ...headers, 'x-mlab-hop-9': 'x;y;0' }), []);
  assert.deepEqual(parseRelayObservations({ ...headers, 'x-mlab-hop-0': 'x;y;0' }), []);
  assert.deepEqual(parseRelayObservations({ ...headers, 'x-mlab-hop-01': 'x;y;0' }), []);
  assert.deepEqual(parseRelayObservations({ ...headers, 'x-mlab-hop-2': 'sg;hk;0.010' }), []);
  assert.deepEqual(parseRelayObservations({ ...headers, 'x-mlab-hop-1': 'hk;sg;0.035;0.040' }), []);
  assert.equal(parseRelayObservation({ ...valid, 'x-mlab-upstream-seconds': '0.000' }).ms, 0, 'a measured value below nginx timer resolution stays distinct from missing');
});

test('probe uses only configured TLS origin, private Token and bounded read-only path', async t => {
  const directory = await mkdtemp('/tmp/mcodex-hop-test-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const token = 'dummy-relay-token-12345678901234567890';
  const state = await saveState(directory, { server: 'wss://hk.example.com:443/mlab-tunnel', token });
  const result = await probeRelay(state, { request: (url, options, callback) => {
    assert.equal(url.href, 'https://hk.example.com/mlab-probe');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.agent, false);
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const socket = new EventEmitter();
      req.emit('socket', socket);
      socket.emit('lookup'); socket.emit('connect'); socket.emit('secureConnect');
      const response = new EventEmitter();
      response.statusCode = 200; response.headers = valid;
      callback(response);
      response.emit('data', Buffer.from('{"status":"ok"}')); response.emit('end');
    });
    return req;
  } });
  assert.equal(result.hops.length, 3);
  assert.equal(result.hops[2].ms, 35);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.match(formatRelayPath(result)[3], /hk.example.com → sg.example.com/);
  assert.match(formatRelayPath(result)[0], /cumulative, not additive/);
});

test('probe never follows redirects or reports credentials in transport errors', async t => {
  const directory = await mkdtemp('/tmp/mcodex-hop-error-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await saveState(directory, { server: 'wss://hk.example.com/mlab-tunnel', token: 'dummy-private-relay-token-123456789012' });
  let calls = 0;
  const request = (_url, _options, callback) => {
    calls++;
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 302;
      response.headers = { location: 'https://attacker.example' };
      callback(response); response.emit('end');
    });
    return req;
  };
  await assert.rejects(probeRelay(state, { request }), /HTTP 302/);
  assert.equal(calls, 1);
  await assert.rejects(probeRelay(state, { request: () => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => req.emit('error', new Error('dummy-private-relay-token-123456789012')));
    return req;
  } }), error => !error.message.includes('dummy-private') && /failed/.test(error.message));
});

test('probe rejects oversized responses and honors cancellation before sending', async t => {
  const directory = await mkdtemp('/tmp/mcodex-hop-bound-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const state = await saveState(directory, { server: 'wss://hk.example.com/mlab-tunnel', token: 'dummy-private-relay-token-123456789012' });
  await assert.rejects(probeRelay(state, { request: (_url, _options, callback) => {
    const req = new EventEmitter();
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 200; response.headers = valid;
      response.destroy = error => response.emit('error', error);
      callback(response); response.emit('data', Buffer.alloc(8193));
    });
    return req;
  } }), /failed/);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(probeRelay(state, { signal: controller.signal, request: () => { throw new Error('must not send'); } }), /cancelled/);
});
