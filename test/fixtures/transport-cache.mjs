#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

if (process.argv.includes('--version')) {
  console.log('mlab-gateway 0.4.2');
  process.exit(0);
}
const filename = process.argv[process.argv.indexOf('--config') + 1];
const config = Object.fromEntries(readFileSync(filename, 'utf8').trim().split('\n').map(line => {
  const at = line.indexOf(' = ');
  return [line.slice(0, at), JSON.parse(line.slice(at + 3))];
}));
const key = readFileSync(config.api_key_file, 'utf8').trim();
const mode = new URL(config.server_url).pathname.slice(1);
const scope = 'v1-' + (mode === 'changed' ? 'b' : 'a').repeat(64);
const pending = new Set();
let requests = 0;
let ready = mode !== 'not-ready';
let released = !['blocked', 'not-ready'].includes(mode);
const catalog = response => {
  response.writeHead(mode === 'revoked' ? 401 : 200, {
    'content-type': 'application/json',
    ...(mode === 'legacy' ? {} : { 'x-mlab-catalog-scope': mode === 'mismatch' ? 'v1-' + 'b'.repeat(64) : scope }),
  });
  response.end(JSON.stringify({ data: mode === 'empty' ? [] : [{ id: 'gateway-model' }] }));
};
const server = http.createServer((request, response) => {
  // Test controls deliberately use no production credentials.
  if (request.url === '/test/events') return response.end(JSON.stringify({ requests, pending: pending.size, ready }));
  if (request.url === '/test/ready') { ready = true; return response.end(); }
  if (request.url === '/test/release') {
    released = true;
    for (const item of pending) catalog(item);
    pending.clear();
    return response.end();
  }
  if (request.headers.authorization !== `Bearer ${key}`) {
    response.writeHead(401); return response.end();
  }
  if (request.url === '/diagnostics') {
    if (mode === 'diagnostics-blocked') return;
    if (mode === 'legacy') { response.writeHead(404); return response.end(); }
    response.setHeader('content-type', 'application/json');
    return response.end(JSON.stringify({
      schema_version: 1, connected: ready && mode !== 'rejected', hops: [],
      catalog_scope: scope,
      last_connection_error: mode === 'rejected' ? { stage: 'handshake', code: 'handshake_rejected', status: 401 } : null,
    }));
  }
  if (request.url === '/v1/models') {
    requests++;
    if (mode === 'rejected') { response.writeHead(401); return response.end(); }
    if (!released) {
      pending.add(response);
      response.on('close', () => pending.delete(response));
    } else catalog(response);
    return;
  }
  response.writeHead(404); response.end();
});
server.listen(0, '127.0.0.1', () => {
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(path.join(path.dirname(config.server_key_file), 'fixture-origin'), origin);
  console.log(`listen=127.0.0.1:${server.address().port}`);
});
process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
