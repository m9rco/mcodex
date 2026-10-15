#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const names = ['@m9rco/mcodex', '@m9rco/mcodex-linux-x64', '@m9rco/mcodex-linux-arm64', '@m9rco/mcodex-darwin-arm64'];
const digest = data => `sha512-${createHash('sha512').update(data).digest('base64')}`;

export async function loadRelease(directory) {
  const packages = new Map();
  for (const filename of (await readdir(directory)).filter(name => name.endsWith('.tgz')).sort()) {
    const archive = resolve(directory, filename);
    const { stdout } = await run('tar', ['-xOf', archive, 'package/package.json'], { maxBuffer: 1024 * 1024 });
    const manifest = JSON.parse(stdout);
    if (!names.includes(manifest.name)) throw new Error(`Unexpected release package: ${filename}`);
    if (packages.has(manifest.name)) throw new Error(`Duplicate release package: ${manifest.name}`);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error(`Invalid version: ${manifest.name}`);
    packages.set(manifest.name, { name: manifest.name, version: manifest.version, integrity: digest(await readFile(archive)), manifest });
  }
  if (packages.size !== names.length) throw new Error('The directory must contain the main package and all three native tarballs');
  const main = packages.get(names[0]);
  for (const name of names.slice(1)) {
    if (main.manifest.optionalDependencies?.[name] !== packages.get(name).version) throw new Error(`Native version does not match the frozen main package: ${name}`);
  }
  return names.map(name => packages.get(name));
}

// This only reads anonymous registry endpoints. A publish receipt is not proof of availability.
export async function verifyPublished(packages, {
  registry = 'https://registry.npmjs.org/', timeoutMs = 300_000, intervalMs = 5000, onProgress = () => {},
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('Timeout and interval must be positive');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const downloaded = new Set();
  let pending = packages.map(({ name, version }) => `${name}@${version}`);
  const fetchPublic = url => fetch(url, { redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { 'Cache-Control': 'no-cache' } });
  try {
    while (!controller.signal.aborted) {
      const results = await Promise.all(packages.map(async expected => {
        const label = `${expected.name}@${expected.version}`;
        const endpoint = new URL(encodeURIComponent(expected.name), registry);
        endpoint.searchParams.set('verification', String(Date.now()));
        let response;
        try { response = await fetchPublic(endpoint); } catch { return `${label}: registry unavailable`; }
        if (!response.ok) return `${label}: metadata HTTP ${response.status}`;
        let packument;
        try { packument = await response.json(); } catch { return `${label}: invalid metadata`; }
        const metadata = packument.versions?.[expected.version];
        if (!metadata) return `${label}: version not public`;
        if (metadata.name !== expected.name || metadata.version !== expected.version || metadata.dist?.integrity !== expected.integrity) throw new Error(`${label}: metadata integrity mismatch`);
        if (packument['dist-tags']?.latest !== expected.version) return `${label}: latest tag not updated`;
        if (downloaded.has(label)) return null;
        let tarball;
        try { tarball = new URL(metadata.dist.tarball); } catch { throw new Error(`${label}: invalid tarball URL`); }
        // Avoid sending a verification request to an unexpected origin or a URL containing credentials.
        if (tarball.origin !== new URL(registry).origin || tarball.username || tarball.password) throw new Error(`${label}: unexpected tarball origin`);
        tarball.searchParams.set('verification', String(Date.now()));
        let download;
        try { download = await fetchPublic(tarball); } catch { return `${label}: tarball unavailable`; }
        if (!download.ok) return `${label}: tarball HTTP ${download.status}`;
        let data;
        try { data = Buffer.from(await download.arrayBuffer()); } catch { return `${label}: incomplete tarball`; }
        if (digest(data) !== expected.integrity) throw new Error(`${label}: downloaded artifact differs from frozen tarball`);
        downloaded.add(label);
        return null;
      }));
      if (controller.signal.aborted) break;
      pending = results.filter(Boolean);
      if (!pending.length) return packages.map(({ name, version }) => `${name}@${version}: public metadata, latest tag and frozen archive verified`);
      onProgress(pending);
      try { await sleep(intervalMs, undefined, { signal: controller.signal }); } catch { break; }
    }
    throw new Error(`Public release verification timed out: ${pending.join('; ')}`);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function main() {
  const options = { directory: resolve('release'), timeoutMs: 300_000, intervalMs: 5000 };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value) throw new Error('Usage: node scripts/verify-published.mjs --directory DIR [--timeout-seconds 300] [--interval-seconds 5]');
    if (args[i] === '--directory') options.directory = resolve(value);
    else if (args[i] === '--timeout-seconds') options.timeoutMs = Number(value) * 1000;
    else if (args[i] === '--interval-seconds') options.intervalMs = Number(value) * 1000;
    else throw new Error(`Unknown option: ${args[i]}`);
  }
  const packages = await loadRelease(options.directory);
  const results = await verifyPublished(packages, { ...options, onProgress: pending => console.error(`Waiting for npm validation/availability: ${pending.join('; ')}`) });
  for (const result of results) console.log(result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
