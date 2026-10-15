import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePing, compareRoutes, formatComparison } from '../src/route-comparison.js';

test('route comparison requires an explicit secure endpoint without embedded credentials', () => {
  assert.deepEqual(parsePing([]), {});
  assert.equal(parsePing(['--compare', 'wss://sg.example.com/mlab-tunnel']).compare, 'wss://sg.example.com/mlab-tunnel');
  assert.throws(() => parsePing(['--compare', 'http://example.com']), /wss/i);
  assert.throws(() => parsePing(['--compare', 'wss://user:secret@example.com']), /credentials/);
  assert.throws(() => parsePing(['extra']), /Usage/);
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
