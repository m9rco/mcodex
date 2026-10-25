import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { proxyWorkerFetch } from '../src/runtime-network.js';

test('download worker honors HTTPS proxy without sending proxy or gateway credentials upstream', {
  skip: !process.allowedNodeEnvironmentFlags.has('--use-env-proxy'),
}, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcodex-proxy-test-'));
  const keyFile = path.join(directory, 'key.pem'), certFile = path.join(directory, 'cert.pem'), config = path.join(directory, 'openssl.cnf');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=github.com\n[ext]\nsubjectAltName=DNS:github.com\nbasicConstraints=critical,CA:TRUE\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-config', config, '-days', '1'], { stdio: 'ignore' });
  const sockets = new Set();
  let upstream, connect;
  const secure = httpsServer({ key: await readFile(keyFile), cert: await readFile(certFile) }, (request, response) => {
    upstream = request.headers;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, body: 'x'.repeat(131072) }));
  });
  const proxy = httpServer();
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (request, socket) => {
    connect = request;
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    secure.emit('connection', socket);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); proxy.close(); secure.close(); });
  const address = `http://fixture-user:fixture-password@127.0.0.1:${proxy.address().port}`;
  const response = await proxyWorkerFetch('https://github.com/mcodex-download-fixture', { headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000), env: { ...process.env, HTTPS_PROXY: address, https_proxy: address, HTTP_PROXY: address, http_proxy: address,
      NO_PROXY: '', no_proxy: '', NODE_EXTRA_CA_CERTS: certFile, MCODEX_LOCAL_KEY: 'fixture-gateway-secret' } });
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.ok, true); assert.equal(body.body.length, 131072);
  assert.equal(connect.url, 'github.com:443');
  assert.equal(connect.headers['proxy-authorization'], `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`);
  assert.equal(upstream.authorization, undefined); assert.equal(upstream['proxy-authorization'], undefined);
  assert.equal(upstream.accept, 'application/json');
});
