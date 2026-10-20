#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import http from 'node:http';

if (process.argv.length === 3 && process.argv[2] === '--version') {
  console.log('mlab-gateway 0.4.2');
  process.exit(0);
}

const configFile = process.argv[process.argv.indexOf('--config') + 1];
const config = Object.fromEntries(readFileSync(configFile, 'utf8').trim().split('\n').map(line => {
  const at = line.indexOf(' = ');
  return [line.slice(0, at), JSON.parse(line.slice(at + 3))];
}));
const key = readFileSync(config.api_key_file, 'utf8').trim();
if (config.server_url.includes('exit.invalid')) process.exit(17);
const server = http.createServer((request, response) => {
  const authenticated = request.headers.authorization === `Bearer ${key}`;
  const overloaded = config.server_url.includes('overloaded.invalid');
  const rejected = config.server_url.includes('rejected.invalid');
  if (authenticated && (overloaded || rejected)) {
    response.writeHead(request.url === '/diagnostics' ? 200 : 503, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url === '/diagnostics'
      ? { schema_version: 1, connected: false, hops: [], last_connection_error: {
        stage: 'handshake', code: overloaded ? 'tunnel_connection_limit' : 'handshake_rejected',
        status: overloaded ? 429 : 404, ...(overloaded ? { retry_after_seconds: 1 } : {}),
        message: 'fixture-sensitive-untrusted-native-message',
      } }
      : { error: { message: 'fixture-sensitive-untrusted-native-message' } }));
    return;
  }
  response.writeHead(authenticated && !config.server_url.includes('denied.invalid') ? 200 : 401, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  process.stdout.write('INFO client listening over an authenticated persistent tunnel; ');
  setTimeout(() => process.stdout.write(`listen=127.0.0.1:${port}\n`), 20);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
