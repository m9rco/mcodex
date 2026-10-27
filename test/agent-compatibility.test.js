import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { providerArguments, codexArguments } from '../src/provider.js';

const metadata = JSON.parse(await readFile(new URL('../src/agent-compatibility.json', import.meta.url), 'utf8'));
const catalogFile = new URL('../src/codex-models.json', import.meta.url);
const catalog = JSON.parse(await readFile(catalogFile, 'utf8'));
const options = { origin: 'http://127.0.0.1:4321', model: 'gpt-6.1-sol' };
const values = args => Object.fromEntries(args.filter((_, index) => index % 2).map(value => {
  const index = value.indexOf('=');
  return [value.slice(0, index), JSON.parse(value.slice(index + 1))];
}));

test('compatibility catalog preserves all upstream metadata except declared V2 wire formats', () => {
  const original = structuredClone(catalog);
  const changed = new Set(metadata.overrides);
  assert.equal(changed.size, metadata.overrides.length);
  for (const model of original.models) {
    if (changed.delete(model.slug)) {
      assert.equal(model.multi_agent_version, 'v1');
      model.multi_agent_version = 'v2';
    } else assert.notEqual(model.multi_agent_version, 'v2');
  }
  assert.equal(changed.size, 0, 'every declared override must exist');
  assert.equal(createHash('sha256').update(JSON.stringify(original)).digest('hex'), metadata.sourceSemanticSha256,
    'prompts, context windows, capabilities and unrelated metadata must match upstream');
});

test('exact tested engines select compatible model metadata and override saved V2 settings', () => {
  for (const version of metadata.engineVersions) {
    const config = values(providerArguments({ ...options, engine: { version, source: 'bundled' } }));
    assert.equal(config['features.multi_agent_v2'], false);
    assert.equal(config.model_catalog_json, fileURLToPath(catalogFile));
    assert.equal(config.model, options.model);
    assert.equal(config['features.multi_agent'], undefined, 'do not enable agents against user preference');
  }
});

test('the release engine has an explicitly verified compatibility catalog', async () => {
  const release = JSON.parse(await readFile(new URL('../scripts/runtime-release.json', import.meta.url), 'utf8'));
  const engine = JSON.parse(await readFile(new URL('../src/engine-compatibility.json', import.meta.url), 'utf8'));
  assert.ok(metadata.engineVersions.includes(release.codexVersion), 'new bundled engines require agent acceptance and matching metadata');
  for (const version of metadata.engineVersions) assert.ok(engine.tested_versions.includes(version));
});

test('unknown external engines do not receive metadata from a different engine version', () => {
  for (const engine of [undefined, { version: '9.0.0', source: 'external' }]) {
    const config = values(providerArguments({ ...options, engine }));
    assert.equal(config.model_catalog_json, undefined);
    assert.equal(config['features.multi_agent_v2'], undefined);
  }
});

test('explicit catalog overrides remain ordered after subscription defaults', () => {
  const defaults = providerArguments({ ...options, engine: { version: '0.163.0', source: 'bundled' } });
  const args = codexArguments(defaults, ['exec', '-c', 'model_catalog_json="/custom/catalog.json"', 'prompt']);
  const configs = args.filter((argument, index) => index > 0 && args[index - 1] === '-c');
  assert.match(configs.at(-1), /^model_catalog_json="\/custom\/catalog.json"$/);
  assert.ok(configs.some(config => config.startsWith('model_catalog_json=') && config.includes('codex-models.json')));
});
