import { performance } from 'node:perf_hooks';

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
      samples.push({ error: /^HTTP \d{3}$/.test(error.message) ? error.message : 'request failed or timed out' });
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
