import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { verifyPublished } from '../scripts/verify-published.mjs';

async function registryFixture(t, { availableAfter = 0, wrongArtifact = false } = {}) {
  const artifact = Buffer.from('frozen reviewed tarball fixture');
  const expected = { name: '@m9rco/mcodex-linux-x64', version: '0.1.1', integrity: `sha512-${createHash('sha512').update(artifact).digest('base64')}` };
  let metadataReads = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url, registry).pathname;
    if (path === '/artifact.tgz') { response.end(wrongArtifact ? 'different archive' : artifact); return; }
    metadataReads++;
    const available = metadataReads > availableAfter;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ 'dist-tags': { latest: available ? expected.version : '0.1.0' }, versions: available ? {
      [expected.version]: { name: expected.name, version: expected.version, dist: { integrity: expected.integrity, tarball: `${registry}artifact.tgz` } },
    } : {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const registry = `http://127.0.0.1:${server.address().port}/`;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { expected, registry, reads: () => metadataReads };
}

test('public verifier waits until an unavailable version and its artifact become public', async t => {
  const fixture = await registryFixture(t, { availableAfter: 1 });
  const pending = [];
  const results = await verifyPublished([fixture.expected], { registry: fixture.registry, timeoutMs: 2000, intervalMs: 10, onProgress: items => pending.push(items) });
  assert.equal(fixture.reads(), 2);
  assert.equal(pending.length, 1);
  assert.match(pending[0][0], /version not public/);
  assert.match(results[0], /frozen archive verified/);
});

test('public verifier fails rather than accepting a mismatched downloaded artifact', async t => {
  const fixture = await registryFixture(t, { wrongArtifact: true });
  await assert.rejects(verifyPublished([fixture.expected], { registry: fixture.registry, timeoutMs: 2000, intervalMs: 10 }), /downloaded artifact differs/);
  assert.equal(fixture.reads(), 1);
});

test('public verifier bounds waiting for a version that never becomes available', async t => {
  const fixture = await registryFixture(t, { availableAfter: Infinity });
  await assert.rejects(verifyPublished([fixture.expected], { registry: fixture.registry, timeoutMs: 80, intervalMs: 10 }), /verification timed out/);
});
