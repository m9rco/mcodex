#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import http from 'node:http';

const configFile = process.argv[process.argv.indexOf('--config') + 1];
const config = Object.fromEntries(readFileSync(configFile, 'utf8').trim().split('\n').map(line => {
  const at = line.indexOf(' = ');
  return [line.slice(0, at), JSON.parse(line.slice(at + 3))];
}));
const key = readFileSync(config.api_key_file, 'utf8').trim();
if (config.server_url.includes('exit.invalid')) process.exit(17);
const server = http.createServer((request, response) => {
  const authenticated = request.headers.authorization === `Bearer ${key}`;
  response.writeHead(authenticated && !config.server_url.includes('denied.invalid') ? 200 : 401, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ data: [{ id: 'test-model' }] }));
});
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  process.stdout.write('INFO client listening over an authenticated persistent tunnel; ');
  setTimeout(() => process.stdout.write(`listen=127.0.0.1:${port}\n`), 20);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
