import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, writeFile, rm, symlink, lstat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { updateRuntime, rollbackRuntime, selectRuntime, checkRuntimeUpdate, verifyEnvelope, publicResponse } from '../src/runtime-update.js';
import { sha256, extractRuntime } from '../src/runtime-archive.js';
import { bootstrap } from '../src/bootstrap.js';
import { signRuntimeRelease } from '../scripts/sign-runtime-release.mjs';

function archive(entries) {
  const chunks = [];
  for (const [name, content, type = '0'] of entries) {
    const bytes = Buffer.from(content), header = Buffer.alloc(512);
    const put = (value, at, size) => header.write(value, at, size, 'ascii');
    put(name, 0, 100); put('0000644\0', 100, 8); put('0000000\0', 108, 8); put('0000000\0', 116, 8);
    put(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12); put('00000000000\0', 136, 12);
    header.fill(32, 148, 156); put(type, 156, 1); put('ustar\0', 257, 6); put('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    put(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcodex-update-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pair = generateKeyPairSync('ed25519');
  const policy = { repository: 'm9rco/mcodex', channelURL: 'https://github.com/m9rco/mcodex/releases/download/runtime-stable/channel.json',
    publicKeys: { fixture: pair.publicKey.export({ type: 'spki', format: 'pem' }) } };
  function release(version = '0.3.1', { badArchive = false, entries, manifestPatch = {} } = {}) {
    const files = {
      'package.json': JSON.stringify({ name: '@m9rco/mcodex-runtime', version, type: 'module' }),
      'src/cli.js': 'export async function main(args) { return 0; }\n',
      'entry.mjs': 'if (process.argv.slice(2).join(" ") !== "doctor --local") process.exitCode = 1;\n',
    };
    const inventory = Object.fromEntries(Object.entries(files).map(([name, data]) => [name, { size: Buffer.byteLength(data), sha256: sha256(data), executable: false }]));
    const data = archive(entries ?? Object.entries(files).map(([name, body]) => [`runtime/${name}`, body]));
    const artifacts = {};
    for (const target of ['linux-x64', 'linux-arm64', 'darwin-arm64']) artifacts[target] = {
      url: `https://github.com/m9rco/mcodex/releases/download/runtime-v${version}/mcodex-runtime-${version}-${target}.tar.gz`,
      size: data.length, sha256: sha256(data), files: inventory,
    };
    const manifest = { schema: 1, launcherApi: 1, version, issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), artifacts, ...manifestPatch };
    const bytes = Buffer.from(JSON.stringify(manifest));
    const envelope = { keyId: 'fixture', payload: bytes.toString('base64'), signature: sign(null, bytes, pair.privateKey).toString('base64') };
    const requests = [];
    const fetchImpl = async (url, options) => {
      requests.push({ url, options });
      if (url === policy.channelURL) return new Response(JSON.stringify(envelope));
      if (Object.values(artifacts).some(a => a.url === url)) return new Response(badArchive ? Buffer.alloc(data.length) : data);
      throw new Error('Unexpected fixture network request');
    };
    return { manifest, envelope, requests, data, options: { directory, policy, fetchImpl } };
  }
  return { directory, policy, release, privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

test('the publisher signs only frozen matching assets with a key trusted by the launcher', async t => {
  const f = await fixture(t), release = f.release();
  for (const [target, a] of Object.entries(release.manifest.artifacts)) {
    await writeFile(path.join(f.directory, new URL(a.url).pathname.split('/').at(-1)), release.data);
    await writeFile(path.join(f.directory, `${target}.artifact.json`), JSON.stringify({ ...a, target, version: '0.3.1', codexVersion: '0.163.0', nativeVersion: '0.4.2' }));
  }
  await signRuntimeRelease(f.directory, { privateKey: f.privateKey, policy: f.policy });
  const envelope = JSON.parse(await readFile(path.join(f.directory, 'channel.json'), 'utf8'));
  assert.equal(verifyEnvelope(envelope, { policy: f.policy }).version, '0.3.1');
  const unrelated = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  await assert.rejects(signRuntimeRelease(f.directory, { privateKey: unrelated, policy: f.policy }), /trust root/);
  await writeFile(path.join(f.directory, new URL(release.manifest.artifacts['linux-x64'].url).pathname.split('/').at(-1)), 'changed');
  await assert.rejects(signRuntimeRelease(f.directory, { privateKey: f.privateKey, policy: f.policy }), /checksum or size/);
});

test('explicit update verifies a self-contained runtime, switches atomically and rollback is offline', async t => {
  const f = await fixture(t), first = f.release(), cwd = process.cwd(), home = process.env.HOME;
  const check = await checkRuntimeUpdate(first.options);
  assert.equal(check.available, true);
  assert.equal(await lstat(path.join(f.directory, 'state.json')).catch(e => e.code), 'ENOENT');
  assert.equal((await updateRuntime(first.options)).version, '0.3.1');
  const selected = await selectRuntime(first.options);
  assert.equal(selected.source, 'managed');
  assert.equal(selected.version, '0.3.1');
  const second = f.release('0.3.2');
  await updateRuntime(second.options);
  assert.equal((await rollbackRuntime(first.options)).version, '0.3.1');
  assert.equal((await rollbackRuntime({ ...first.options, bundled: true })).source, 'bundled');
  assert.equal((await selectRuntime(first.options)).source, 'bundled');
  assert.equal(process.cwd(), cwd); assert.equal(process.env.HOME, home);
  assert(first.requests.every(r => r.options.credentials === 'omit' && !Object.keys(r.options.headers).some(k => k.toLowerCase() === 'authorization')));
});

test('signature, expiry and launcher API are checked before any artifact execution', async t => {
  const f = await fixture(t), good = f.release();
  assert.equal(verifyEnvelope(good.envelope, { policy: f.policy }).version, '0.3.1');
  assert.throws(() => verifyEnvelope({ ...good.envelope, keyId: 'unknown' }, { policy: f.policy }), /unknown signing key/);
  assert.throws(() => verifyEnvelope({ ...good.envelope, payload: Buffer.from('{}').toString('base64') }, { policy: f.policy }), /signature/);
  const old = f.release('0.3.1', { manifestPatch: { issuedAt: '2020-01-01T00:00:00Z', expiresAt: '2020-01-02T00:00:00Z' } });
  assert.throws(() => verifyEnvelope(old.envelope, { policy: f.policy }), /expired/);
  assert.equal(verifyEnvelope(old.envelope, { policy: f.policy, installed: true }).version, '0.3.1');
  await assert.rejects(updateRuntime(f.release('0.3.1', { manifestPatch: { launcherApi: 2 } }).options), /incompatible/);
  assert.equal((await selectRuntime(good.options)).source, 'bundled');
});

test('bad download or failing health check keeps the previous pointer unchanged', async t => {
  const f = await fixture(t), first = f.release(); await updateRuntime(first.options);
  const pointer = await readFile(path.join(f.directory, 'state.json'), 'utf8');
  await assert.rejects(updateRuntime(f.release('0.3.2', { badArchive: true }).options), /checksum/);
  await assert.rejects(updateRuntime({ ...f.release('0.3.2').options, healthCheckImpl: async () => { throw new Error('health fixture'); } }), /health fixture/);
  assert.equal(await readFile(path.join(f.directory, 'state.json'), 'utf8'), pointer);
  assert.equal((await selectRuntime(first.options)).version, '0.3.1');
});

test('channel downgrade and mutable replacement are rejected even after an explicit rollback', async t => {
  const f = await fixture(t); await updateRuntime(f.release('0.3.2').options);
  await rollbackRuntime({ directory: f.directory, policy: f.policy, bundled: true });
  await assert.rejects(checkRuntimeUpdate(f.release('0.3.1').options), /downgrade/);
  const replacement = f.release('0.3.2', { entries: [['runtime/package.json', 'replacement']] });
  await assert.rejects(checkRuntimeUpdate(replacement.options), /replacement/);
});

test('corrupt cached files fall back before invocation, without rewriting state', async t => {
  const f = await fixture(t), release = f.release(); await updateRuntime(release.options);
  const installed = await selectRuntime(release.options);
  const pointer = await readFile(path.join(f.directory, 'state.json'), 'utf8');
  await writeFile(installed.entry, 'throw new Error("corrupt")');
  const warnings = [];
  assert.equal((await selectRuntime({ ...release.options, onWarning: x => warnings.push(x) })).source, 'bundled');
  assert.equal(warnings.length, 1);
  assert.equal(await readFile(path.join(f.directory, 'state.json'), 'utf8'), pointer);
  await updateRuntime(release.options);
  const repaired = await selectRuntime(release.options);
  assert.equal(repaired.source, 'managed');
  assert.notEqual(repaired.id, installed.id);
  assert.equal(await readFile(installed.entry, 'utf8'), 'throw new Error("corrupt")');
});

test('explicit bundled rollback recovers malformed pointer metadata', async t => {
  const f = await fixture(t), release = f.release();
  await writeFile(path.join(f.directory, 'state.json'), '{invalid');
  assert.equal((await selectRuntime(release.options)).source, 'bundled');
  await rollbackRuntime({ ...release.options, bundled: true });
  assert.equal((await selectRuntime(release.options)).source, 'bundled');
});

test('cache symlinks, shared writable cache and concurrent updates cannot change selections', async t => {
  const f = await fixture(t), release = f.release();
  const link = `${f.directory}-link`; await symlink(f.directory, link); t.after(() => rm(link));
  await assert.rejects(updateRuntime({ ...release.options, directory: link }), /links/);
  await writeFile(path.join(f.directory, '.update.lock'), 'fixture');
  await assert.rejects(updateRuntime(release.options), /locked/);
  await rm(path.join(f.directory, '.update.lock'));
  await updateRuntime(release.options);
  assert.equal((await selectRuntime(release.options)).version, '0.3.1');
});

test('an in-progress update keeps readers on the baseline and rejects a second writer', async t => {
  const f = await fixture(t), release = f.release();
  let entered, finish;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const running = updateRuntime({ ...release.options, healthCheckImpl: async () => { entered(); await gate; } });
  await ready;
  assert.equal((await selectRuntime(release.options)).source, 'bundled');
  await assert.rejects(updateRuntime(release.options), /locked/);
  finish(); await running;
  assert.equal((await selectRuntime(release.options)).source, 'managed');
});

test('cancellation before activation releases the lock and leaves the baseline selected', async t => {
  const f = await fixture(t), release = f.release(), controller = new AbortController();
  await assert.rejects(updateRuntime({ ...release.options, signal: controller.signal, healthCheckImpl: async () => { controller.abort(); } }), /abort/i);
  assert.equal((await selectRuntime(release.options)).source, 'bundled');
  assert.equal(await lstat(path.join(f.directory, '.update.lock')).catch(e => e.code), 'ENOENT');
  await updateRuntime(release.options);
});

test('signed archives cannot write traversal paths, links, duplicate entries or oversized output', async t => {
  const f = await fixture(t), expected = f.release().manifest.artifacts[`${process.platform}-${process.arch}`].files;
  for (const entries of [
    [['runtime/../outside', 'bad']],
    [['runtime/src/cli.js', '', '2']],
    [['runtime/src/cli.js', 'x'], ['runtime/src/cli.js', 'x']],
  ]) {
    const file = path.join(f.directory, `bad-${Math.random()}.tar.gz`), destination = `${file}-out`;
    await writeFile(file, archive(entries)); await mkdir(destination);
    await assert.rejects(extractRuntime(file, destination, expected));
  }
  const file = path.join(f.directory, 'large.tar.gz'); await writeFile(file, archive([['runtime/src/cli.js', 'x'.repeat(4096)]]));
  await assert.rejects(extractRuntime(file, path.join(f.directory, 'large'), expected, { maxBytes: 1024 }), /limit/);
  assert.equal(await lstat(path.join(f.directory, 'outside')).catch(e => e.code), 'ENOENT');
});

test('public download redirects cannot forward a request to an untrusted host or HTTP', async () => {
  for (const location of ['https://evil.example/asset', 'http://github.com/asset', 'https://user:secret@github.com/asset']) {
    let calls = 0;
    await assert.rejects(publicResponse('https://github.com/m9rco/mcodex/asset', { fetchImpl: async () => { calls++; return new Response('', { status: 302, headers: { location } }); } }), /origin/);
    assert.equal(calls, 1);
  }
});

test('bootstrap startup stays local and an executed command failure is never retried', async t => {
  const f = await fixture(t), args = ['exec', '-C', '/home/pushaowei', 'task'];
  let calls = 0;
  await assert.rejects(bootstrap(args, { runtimeOptions: { directory: f.directory }, load: async () => ({ main: async received => {
    calls++; assert.deepEqual(received, args); throw new Error('command already executed');
  } }) }), /already executed/);
  assert.equal(calls, 1);
  assert.equal(await lstat(path.join(f.directory, 'state.json')).catch(e => e.code), 'ENOENT');
  const lines = [];
  await bootstrap(['runtime', 'status'], { runtimeOptions: { directory: f.directory }, stdout: x => lines.push(x) });
  assert.match(lines[0], /source: bundled/);
});
