import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const agentCompatibility = JSON.parse(readFileSync(new URL('./agent-compatibility.json', import.meta.url), 'utf8'));
const compatibleCatalog = fileURLToPath(new URL('./codex-models.json', import.meta.url));

export function providerArguments({ origin, model, engine }) {
  const values = {
    // The official updater installs a separate global Codex. The exact bundled
    // engine is maintained with mcodex; explicitly selected engines own updates.
    ...(engine?.source === 'bundled' ? { check_for_update_on_startup: false } : {}),
    // Login startup files can cd to HOME after the executor sets its workdir,
    // especially when shell snapshots are disabled or unavailable. Inherit the
    // caller's environment without rerunning login profiles. User -c overrides
    // follow these defaults and can explicitly opt back in.
    allow_login_shell: false,
    // A false V2 feature flag alone does not override the model's V2 metadata.
    // Use the exact upstream catalog with only V2 agent wire formats changed to
    // V1, so local parallel agents use supported function/custom tool history.
    ...(agentCompatibility.engineVersions.includes(engine?.version) ? {
      'features.multi_agent_v2': false,
      model_catalog_json: compatibleCatalog,
    } : {}),
    model_provider: 'mcodex',
    model,
    'model_providers.mcodex.name': 'mcodex gateway',
    'model_providers.mcodex.base_url': `${origin}/v1`,
    'model_providers.mcodex.env_key': 'MCODEX_LOCAL_KEY',
    'model_providers.mcodex.wire_api': 'responses',
    'model_providers.mcodex.requires_openai_auth': false,
    'model_providers.mcodex.supports_websockets': false,
    'model_providers.mcodex.request_max_retries': 0,
    'model_providers.mcodex.stream_max_retries': 0,
    'model_providers.mcodex.stream_idle_timeout_ms': 300000,
  };
  return Object.entries(values).flatMap(([name, value]) => ['-c', `${name}=${JSON.stringify(value)}`]);
}

export function chooseModel(models, requested) {
  const ids = models.map(item => item.id).filter(id => typeof id === 'string' && id.length > 0);
  if (requested) {
    if (!ids.includes(requested)) throw new Error(`Model ${requested} is unavailable on this gateway.`);
    return requested;
  }
  const preferred = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol'];
  const model = preferred.find(id => ids.includes(id)) ?? ids[0];
  if (!model) throw new Error('The gateway returned no available models.');
  return model;
}

// Codex's global repeatable -c flag is replaced, not merged, when a subcommand
// also supplies -c. Hoist user overrides into the same scope as our defaults,
// retaining their order and treating everything after -- as literal arguments.
export function codexArguments(defaults, args) {
  const overrides = [];
  const forwarded = [];
  // These root options consume the next token even when it names a command.
  const valueOptions = new Set(['-m', '--model', '-p', '--profile', '-C', '--cd',
    '-s', '--sandbox', '-a', '--ask-for-approval', '-i', '--image', '--add-dir',
    '--enable', '--disable', '--local-provider', '--remote', '--remote-cwd', '--remote-auth-token-env']);
  let commandSeen = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') {
      forwarded.push(...args.slice(index));
      break;
    }
    if (!commandSeen && valueOptions.has(argument)) {
      forwarded.push(argument);
      if (index + 1 < args.length) forwarded.push(args[++index]);
      continue;
    }
    if (!commandSeen && !argument.startsWith('-')) {
      commandSeen = true;
      // These commands can own a trailing external argv without a -- marker.
      // Its bash -c (or executable --config) belongs to the external program.
      if (argument === 'sandbox' || argument === 'mcp') {
        forwarded.push(...args.slice(index));
        break;
      }
    }
    let value;
    if (argument === '-c' || argument === '--config') {
      value = args[++index];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${argument}.`);
    } else if (argument.startsWith('--config=')) {
      value = argument.slice('--config='.length);
    } else if (argument.startsWith('-c') && !argument.startsWith('--')) {
      value = argument.slice(2).replace(/^=/, '');
    } else {
      forwarded.push(argument);
      continue;
    }
    overrides.push('-c', value);
  }
  return [...defaults, ...overrides, ...forwarded];
}
