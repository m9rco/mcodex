import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

const worker = `
import { readFileSync, writeFileSync, closeSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const response = await fetch(input.url, { headers: input.headers, redirect: 'manual', credentials: 'omit' });
  writeFileSync(3, JSON.stringify({ status: response.status, headers: Object.fromEntries(response.headers) }));
  closeSync(3);
  if (response.body) await pipeline(Readable.fromWeb(response.body), process.stdout);
} catch { process.exitCode = 1; }
`;

export function hasHTTPProxy(env = process.env) {
  return Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
}

// Isolate Node's built-in environment-proxy dispatcher to download requests.
// Changing the parent global dispatcher could proxy local gateway probes too.
export async function proxyWorkerFetch(url, { headers = {}, signal, env = process.env } = {}) {
  signal?.throwIfAborted();
  if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) throw new Error('Proxy downloads require a Node.js build with --use-env-proxy support. Use a current Node 22 or newer.');
  const childEnv = { ...env };
  delete childEnv.NODE_OPTIONS; delete childEnv.NODE_PATH; delete childEnv.MCODEX_LOCAL_KEY;
  childEnv.HTTP_PROXY ??= childEnv.http_proxy;
  childEnv.HTTPS_PROXY ??= childEnv.https_proxy;
  childEnv.NO_PROXY ??= childEnv.no_proxy;
  const child = spawn(process.execPath, ['--use-env-proxy', '--input-type=module', '-e', worker], { env: childEnv, stdio: ['pipe', 'pipe', 'ignore', 'pipe'] });
  const stop = () => child.kill('SIGKILL');
  signal?.addEventListener('abort', stop, { once: true });
  const response = new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    child.stdio[3].on('data', chunk => {
      size += chunk.length;
      if (size > 65536) { stop(); reject(new Error('Public download headers exceeded their limit.')); }
      else chunks.push(chunk);
    });
    child.stdio[3].once('end', () => {
      try {
        signal?.throwIfAborted();
        const metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const body = [204, 205, 304].includes(metadata.status) ? null : Readable.toWeb(child.stdout);
        resolve(new Response(body, metadata));
      } catch { stop(); reject(new Error('Public proxy download failed before receiving a response.')); }
    });
    child.once('error', () => reject(new Error('Unable to start the public download worker.')));
    child.stdin.on('error', () => {});
    child.once('close', code => {
      signal?.removeEventListener('abort', stop);
      if (code !== 0) reject(new Error('Public proxy download did not complete.'));
    });
  });
  child.stdin.end(JSON.stringify({ url, headers }));
  if (signal?.aborted) stop();
  return response;
}
