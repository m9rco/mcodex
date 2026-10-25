import { createReadStream } from 'node:fs';
import { open, mkdir, chmod, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import path from 'node:path';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const safePath = value => typeof value === 'string' && value.length <= 240 &&
  /^[A-Za-z0-9@_.+/-]+$/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');

export async function fileDigest(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export async function inventory(directory) {
  const files = {};
  async function walk(relative = '') {
    for (const name of (await readdir(path.join(directory, relative))).sort()) {
      const key = relative ? `${relative}/${name}` : name;
      if (!safePath(key)) throw new Error('Runtime contains an unsupported filename.');
      const filename = path.join(directory, key);
      const entry = await lstat(filename);
      if (entry.isDirectory()) await walk(key);
      else if (entry.isFile() && entry.nlink === 1) files[key] = { size: entry.size, sha256: await fileDigest(filename), executable: Boolean(entry.mode & 0o111) };
      else throw new Error('Runtime files must be regular files, without links.');
    }
  }
  await walk();
  return files;
}

export async function verifyTree(directory, expected) {
  const actual = await inventory(directory);
  if (JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(Object.keys(expected).sort())) throw new Error('Runtime file inventory differs from its signed manifest.');
  for (const name of Object.keys(expected)) {
    const a = actual[name], b = expected[name];
    if (a.size !== b.size || a.sha256 !== b.sha256 || a.executable !== b.executable) throw new Error('Runtime file integrity verification failed.');
  }
}

// Only our deliberately simple ustar format is accepted. No external tar command,
// PAX paths, links, devices, absolute paths or directory traversal are executed.
export async function extractRuntime(archive, destination, expected, { maxBytes = 768 * 1024 * 1024 } = {}) {
  const source = createReadStream(archive), stream = createGunzip();
  source.on('error', error => stream.destroy(error));
  source.pipe(stream);
  let buffer = Buffer.alloc(0), file, remaining = 0, padding = 0, expanded = 0, zeros = 0;
  const seen = new Set();
  const text = value => value.toString('utf8').replace(/\0.*$/s, '');
  const octal = value => {
    const input = text(value).trim();
    if (!/^[0-7]+$/.test(input)) throw new Error('Unsupported runtime archive number.');
    const number = Number.parseInt(input, 8);
    if (!Number.isSafeInteger(number)) throw new Error('Runtime archive entry is too large.');
    return number;
  };
  try {
    for await (const chunk of stream) {
      expanded += chunk.length;
      if (expanded > maxBytes) throw new Error('Expanded runtime archive exceeds its limit.');
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      while (buffer.length) {
        if (remaining) {
          const size = Math.min(remaining, buffer.length), bytes = buffer.subarray(0, size);
          await file.handle.writeFile(bytes);
          file.hash.update(bytes);
          remaining -= size;
          buffer = buffer.subarray(size);
          if (!remaining) {
            await file.handle.close();
            file.handle = undefined;
            if (file.hash.digest('hex') !== expected[file.name].sha256) throw new Error('Runtime archive file checksum mismatch.');
            await chmod(file.filename, expected[file.name].executable ? 0o755 : 0o644);
            file = undefined;
          }
          continue;
        }
        if (padding) {
          const size = Math.min(padding, buffer.length);
          padding -= size;
          buffer = buffer.subarray(size);
          continue;
        }
        if (buffer.length < 512) break;
        const header = buffer.subarray(0, 512);
        buffer = buffer.subarray(512);
        if (header.every(byte => byte === 0)) { zeros++; continue; }
        if (zeros) throw new Error('Unexpected data after runtime archive end.');
        const checksum = octal(header.subarray(148, 156));
        let sum = 0;
        for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
        if (sum !== checksum || text(header.subarray(257, 263)) !== 'ustar') throw new Error('Invalid runtime ustar header.');
        const prefix = text(header.subarray(345, 500));
        const full = `${prefix ? `${prefix}/` : ''}${text(header.subarray(0, 100))}`.replace(/\/$/, '');
        if (full === 'runtime' && header[156] === 53) continue;
        if (!full.startsWith('runtime/') || !safePath(full)) throw new Error('Unsafe runtime archive path.');
        const name = full.slice(8), filename = path.join(destination, name), type = header[156];
        if (seen.has(name)) throw new Error('Duplicate runtime archive path.');
        seen.add(name);
        const size = octal(header.subarray(124, 136));
        if (type === 53) {
          if (size) throw new Error('Invalid runtime directory entry.');
          await mkdir(filename, { recursive: true, mode: 0o700 });
          continue;
        }
        if (type !== 0 && type !== 48) throw new Error('Runtime archive links and special entries are forbidden.');
        const metadata = expected[name];
        if (!metadata || size !== metadata.size) throw new Error('Unexpected runtime archive file.');
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        const handle = await open(filename, 'wx', 0o600);
        file = { handle, filename, name, hash: createHash('sha256') };
        remaining = size;
        padding = (512 - size % 512) % 512;
        if (!size) {
          await handle.close();
          file.handle = undefined;
          if (sha256(Buffer.alloc(0)) !== metadata.sha256) throw new Error('Runtime archive file checksum mismatch.');
          await chmod(filename, metadata.executable ? 0o755 : 0o644);
          file = undefined;
        }
      }
    }
    if (file || remaining || padding || zeros < 2 || buffer.some(byte => byte !== 0)) throw new Error('Truncated runtime archive.');
    await verifyTree(destination, expected);
  } finally {
    stream.destroy();
    source.destroy();
    await file?.handle?.close();
  }
}
