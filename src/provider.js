export function providerArguments({ origin, model }) {
  const values = {
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
