#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { defaultPolicy, publicResponse, verifyEnvelope } from '../src/runtime-update.js';

const directory = path.resolve(process.argv[2] ?? 'runtime-dist');
const envelope = JSON.parse(await readFile(path.join(directory, 'channel.json'), 'utf8'));
const manifest = verifyEnvelope(envelope);
for (const [target, artifact] of Object.entries(manifest.artifacts)) {
  const response = await publicResponse(artifact.url, { timeoutMs: 300000 });
  const hash = createHash('sha256'); let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > artifact.size) throw new Error('Public runtime download exceeds its signed size.'); hash.update(chunk); }
  if (size !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new Error('Public runtime differs from the frozen build.');
  console.log(`${target}: immutable public runtime archive verified.`);
}
if (process.argv[3] === '--channel') {
  const response = await publicResponse(defaultPolicy.channelURL, { accept: 'application/json' });
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 450000) throw new Error('Public channel is too large.'); chunks.push(chunk); }
  const remote = JSON.parse(Buffer.concat(chunks)); verifyEnvelope(remote);
  if (JSON.stringify(remote) !== JSON.stringify(envelope)) throw new Error('Public runtime channel does not match the signed release.');
  console.log(`Stable runtime channel ${manifest.version} verified.`);
}
