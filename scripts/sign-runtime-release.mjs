#!/usr/bin/env node
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultPolicy, verifyEnvelope } from '../src/runtime-update.js';
import { fileDigest } from '../src/runtime-archive.js';

export async function signRuntimeRelease(directory, { privateKey, now = Date.now(), policy = defaultPolicy } = {}) {
  if (!privateKey) throw new Error('Provide the runtime signing key through protected input.');
  const key = createPrivateKey(privateKey), publicKey = createPublicKey(key).export({ type: 'spki', format: 'pem' });
  const keyId = Object.keys(policy.publicKeys).find(id => policy.publicKeys[id] === publicKey);
  if (!keyId || key.asymmetricKeyType !== 'ed25519') throw new Error('Runtime signing key does not match the launcher trust root.');
  const artifacts = {}, versions = new Set(), codexVersions = new Set(), nativeVersions = new Set();
  for (const target of ['linux-x64', 'linux-arm64', 'darwin-arm64']) {
    const artifact = JSON.parse(await readFile(path.join(directory, `${target}.artifact.json`), 'utf8'));
    const archive = path.join(directory, new URL(artifact.url).pathname.split('/').at(-1));
    if (artifact.target !== target || (await lstat(archive)).size !== artifact.size || await fileDigest(archive) !== artifact.sha256) throw new Error('Frozen runtime artifact checksum or size mismatch.');
    versions.add(artifact.version); codexVersions.add(artifact.codexVersion); nativeVersions.add(artifact.nativeVersion);
    artifacts[target] = { url: artifact.url, size: artifact.size, sha256: artifact.sha256, files: artifact.files };
  }
  if (versions.size !== 1 || codexVersions.size !== 1 || nativeVersions.size !== 1) throw new Error('All runtime platforms must belong to the same tested release.');
  const manifest = { schema: 1, launcherApi: 1, version: [...versions][0], issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 90 * 86400000).toISOString(), artifacts };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const envelope = { keyId, payload: bytes.toString('base64'), signature: sign(null, bytes, key).toString('base64') };
  verifyEnvelope(envelope, { policy, now });
  await writeFile(path.join(directory, 'channel.json'), `${JSON.stringify(envelope)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('Use sign-runtime-release.mjs ARTIFACT_DIRECTORY.');
  const manifest = await signRuntimeRelease(path.resolve(process.argv[2]), { privateKey: process.env.MCODEX_RUNTIME_SIGNING_KEY });
  console.log(`Signed runtime ${manifest.version} for all three platforms.`);
}
