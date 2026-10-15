#!/bin/sh
set -eu

command -v node >/dev/null 2>&1 || { echo 'Install Node.js 22 or newer first.' >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo 'npm is required.' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo 'curl is required.' >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("Node.js 22 or newer is required."); process.exit(1); }'

MCODEX_INSTALL_TARGET=$(node -p 'process.platform + "-" + process.arch')
case "$MCODEX_INSTALL_TARGET" in
  linux-x64|linux-arm64|darwin-arm64) ;;
  *) echo "Unsupported platform: $MCODEX_INSTALL_TARGET" >&2; exit 1 ;;
esac

umask 077
MCODEX_DOWNLOAD_DIR=$(mktemp -d "${TMPDIR:-/tmp}/mcodex-install.XXXXXX")
trap 'node -e '\''require("node:fs").rmSync(process.argv[1], {recursive:true,force:true})'\'' "$MCODEX_DOWNLOAD_DIR"' EXIT HUP INT TERM
MCODEX_MAIN_VERSION=0.1.5
MCODEX_NATIVE_VERSION=0.1.1
MCODEX_RELEASE_URL=https://github.com/m9rco/mcodex/releases/download/v${MCODEX_MAIN_VERSION}
MCODEX_MAIN_ARCHIVE=m9rco-mcodex-${MCODEX_MAIN_VERSION}.tgz
MCODEX_NATIVE_ARCHIVE=m9rco-mcodex-${MCODEX_INSTALL_TARGET}-${MCODEX_NATIVE_VERSION}.tgz

for MCODEX_ASSET in SHA256SUMS "$MCODEX_NATIVE_ARCHIVE" "$MCODEX_MAIN_ARCHIVE"; do
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 "$MCODEX_RELEASE_URL/$MCODEX_ASSET" --output "$MCODEX_DOWNLOAD_DIR/$MCODEX_ASSET"
done

node --input-type=module - "$MCODEX_DOWNLOAD_DIR" "$MCODEX_NATIVE_ARCHIVE" "$MCODEX_MAIN_ARCHIVE" <<'JS'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const [directory, nativeName, mainName] = process.argv.slice(2);
const lines = readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split('\n');
for (const name of [nativeName, mainName]) {
  const matches = lines.filter(line => line.slice(66) === name && /^[a-f0-9]{64}  /.test(line));
  if (matches.length !== 1) throw new Error(`Missing or ambiguous checksum for ${name}`);
  const digest = createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex');
  if (digest !== matches[0].slice(0, 64)) throw new Error(`Checksum mismatch for ${name}`);
}
JS

MCODEX_GLOBAL_ROOT=$(npm root -g)
MCODEX_GLOBAL_PREFIX=$(npm prefix -g)
MCODEX_REMOVE_LEGACY=$(node --input-type=module - "$MCODEX_GLOBAL_ROOT" "$MCODEX_GLOBAL_PREFIX" <<'JS'
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
const [modules, prefix] = process.argv.slice(2);
const legacy = path.join(modules, 'mcodex');
let remove = false;
try {
  const manifest = JSON.parse(readFileSync(path.join(legacy, 'package.json'), 'utf8'));
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  const ours = manifest.name === 'mcodex' && manifest.version === '0.1.0'
    && repository === 'git+https://github.com/m9rco/mcodex.git'
    && manifest.bin?.mcodex === 'bin/mcodex.js';
  if (ours) {
    const executable = path.join(prefix, 'bin', 'mcodex');
    try { remove = realpathSync(executable) === realpathSync(path.join(legacy, 'bin/mcodex.js')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
process.stdout.write(remove ? 'yes' : 'no');
JS
)
if [ "$MCODEX_REMOVE_LEGACY" = yes ]; then
  echo 'Replacing the legacy mcodex package; saved connection settings are retained.'
  npm uninstall -g mcodex
fi

npm install -g "$MCODEX_DOWNLOAD_DIR/$MCODEX_NATIVE_ARCHIVE" "$MCODEX_DOWNLOAD_DIR/$MCODEX_MAIN_ARCHIVE"
mcodex --version
echo 'Installed. Run mcodex login or mcodex to configure your gateway and start Codex.'
