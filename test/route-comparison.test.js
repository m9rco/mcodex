import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePing, compareRoutes, formatComparison } from '../src/route-comparison.js';

test('ping accepts temporary target and baseline overrides, with optional comparison', () => {
  assert.deepEqual(parsePing([]), {});
  assert.equal(parsePing(['--compare', 'wss://sg.example.com/mlab-tunnel']).compare, 'wss://sg.example.com/mlab-tunnel');
  assert.deepEqual(parsePing(['wss://hk.example.com/tunnel']), { server: 'wss://hk.example.com/tunnel' });
  assert.deepEqual(parsePing(['--server', 'wss://hk.example.com/tunnel']), { server: 'wss://hk.example.com/tunnel' });
  assert.deepEqual(parsePing(['--compare', 'wss://sg.example.com/tunnel', '--server', 'wss://hk.example.com/tunnel']),
    { server: 'wss://hk.example.com/tunnel', compare: 'wss://sg.example.com/tunnel' });
  assert.deepEqual(parsePing(['wss://hk.example.com/tunnel', '--compare', 'wss://sg.example.com/tunnel']),
    { server: 'wss://hk.example.com/tunnel', compare: 'wss://sg.example.com/tunnel' });
});

test('ping rejects invalid URLs and ambiguous arguments without echoing supplied values', () => {
  assert.throws(() => parsePing(['--compare', 'http://example.com']), /wss/i);
  assert.throws(() => parsePing(['--compare', 'wss://user:secret@example.com']), /credentials/);
  for (const args of [['--server'], ['--compare'], ['--server', 'wss://a.example', 'wss://b.example'],
    ['wss://a.example', '--server', 'wss://b.example'], ['--compare', 'wss://a.example', '--compare', 'wss://b.example'],
    ['--unknown-fixture-secret'], ['wss://example.com?token=fixture-secret'], ['--server', 'wss://example.com#fixture-secret']]) {
    assert.throws(() => parsePing(args), error => !error.message.includes('fixture-secret'));
  }
});

test('paired probes alternate order and report comparable warm-path latency', async () => {
  const current = { id: 'hk' }; const candidate = { id: 'sg' }; const order = [];
  const result = await compareRoutes(current, candidate, { count: 4, probe: async (route, options) => {
    assert.equal(options.count, 1); order.push(route.id);
    return { samples: [{ ms: route.id === 'hk' ? 100 : 50 }] };
  } });
  assert.deepEqual(order, ['hk', 'sg', 'sg', 'hk', 'hk', 'sg', 'sg', 'hk']);
  assert.equal(result.current.average, 100);
  assert.match(formatComparison(result)[2], /50.0 ms faster/);
});

test('failed route samples do not produce a recommendation', async () => {
  const result = await compareRoutes({}, {}, { count: 1, probe: async () => ({ samples: [{ error: 'timeout' }] }) });
  assert.equal(result.current.average, null);
  assert.match(formatComparison(result)[2], /no route recommendation/);
});

test('same endpoint compares two connections and reports variation, with hosts and setup times', async () => {
  const result = await compareRoutes({ id: 1 }, { id: 2 }, { count: 2, probe: async route => ({ samples: [{ ms: route.id === 1 ? 100 : 75 }] }) });
  const lines = formatComparison(result, { currentServer: 'wss://sg.example.com/tunnel', candidateServer: 'wss://sg.example.com/tunnel',
    currentSetupMs: 3511, candidateSetupMs: 6460 });
  assert.match(lines[0], /^Baseline sg\.example\.com: setup 3511 ms; 100\.0 ms average; min\/max 100\.0\/100\.0 ms; failed 0\/2$/);
  assert.match(lines[1], /^Comparison sg\.example\.com: setup 6460 ms; 75\.0 ms average/);
  assert.match(lines[2], /Same endpoint, two independent connections: the second is 25\.0 ms faster.*connection variation/);
  assert.equal(lines.some(line => /changing routes/.test(line)), false);
});

test('cancellation stops paired probes before issuing any more requests', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(compareRoutes({}, {}, { count: 5, signal: controller.signal, probe: async () => {
    calls++;
    controller.abort(new Error('fixture cancelled'));
    return { samples: [{ ms: 10 }] };
  } }), /fixture cancelled/);
  // Cancellation may occur during a finished probe, but must not send the
  // second member of its pair after that signal has been observed.
  assert.equal(calls, 1);
});
