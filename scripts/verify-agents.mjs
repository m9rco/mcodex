// Exercise real local parallel agents against a loopback Responses fixture.
// No production gateway, credentials or model inference is used.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundledCodexEntry, commandVersion, engineCommand } from '../src/engine.js';

const runtimeRoot = process.env.MCODEX_AGENT_TEST_RUNTIME_ROOT && path.resolve(process.env.MCODEX_AGENT_TEST_RUNTIME_ROOT);
const { runCodex } = await import(runtimeRoot ? pathToFileURL(path.join(runtimeRoot, 'src/tunnel.js')).href : new URL('../src/tunnel.js', import.meta.url).href);
const selectedEngine = path.resolve(process.env.MCODEX_AGENT_TEST_CODEX_BIN || (runtimeRoot ? path.join(runtimeRoot, 'node_modules/@openai/codex/bin/codex.js') : bundledCodexEntry()));
const originalEnv = { ...process.env };
const originalCwd = process.cwd();
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'mcodex-agents-')));
const key = 'offline-parallel-agent-fixture';
const markers = ['AGENT_FIXTURE_RESULT_ONE', 'AGENT_FIXTURE_RESULT_TWO'];
const allowed = new Set(['message', 'additional_tools', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output', 'web_search_call', 'compaction', 'context_compaction', 'item_reference', 'tool_call', 'tool_call_output']);
const code = `const spawn = ALL_TOOLS.find(t => t.name === 'multi_agent_v1__spawn_agent');
const wait = ALL_TOOLS.find(t => t.name === 'multi_agent_v1__wait_agent');
if (!spawn || !wait) throw new Error('Compatible local agent tools are missing');
const agents = await Promise.all(${JSON.stringify(markers)}.map(message => tools[spawn.name]({message, agent_type: 'default'})));
text(await Promise.all(agents.map(agent => tools[wait.name]({targets: [agent.agent_id], timeout_ms: 10000}))));`;
let active;
function toolsIn(payload) {
  const flatten = (tools, namespace) => tools.flatMap(tool => tool.type === 'namespace' ? flatten(tool.tools, tool.name) : [{ ...tool, namespace }]);
  return flatten([...(payload.tools ?? []), ...(payload.input ?? []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools)]);
}
function emit(response, items, id) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const event = (type, body) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
  event('response.created', { response: { id, status: 'in_progress', output: [] } });
  items.forEach((item, output_index) => {
    event('response.output_item.added', { output_index, item });
    event('response.output_item.done', { output_index, item });
  });
  event('response.completed', { response: { id, status: 'completed', output: items, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
  response.end();
}
function final(response, text, id) {
  emit(response, [{ id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], id);
}
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/responses', 'all agents must keep the mcodex provider');
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    assert.ok(++active.requests <= 8, 'agent fixture must finish without replays');
    const unsupported = payload.input.map(item => item.type ?? 'message').filter(type => !allowed.has(type));
    if (unsupported.length) {
      active.unsupported.push(...unsupported);
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Unsupported subscription input item', code: 'subscription_sharing_unsupported_capability', param: 'input', type: 'invalid_request_error' } }));
      return;
    }
    const outputs = payload.input.filter(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type));
    const id = `response_${active.requests}`;
    if (outputs.length) {
      active.parentOutput = JSON.stringify(outputs);
      final(response, 'PARALLEL_AGENT_FIXTURE_COMPLETE', id);
      return;
    }
    const userText = JSON.stringify(payload.input.filter(item => item.role === 'user'));
    const marker = markers.find(marker => userText.includes(marker));
    if (marker) {
      active.children.push({ response, marker, id });
      // Neither child completes before both requests arrive: this proves overlap.
      if (active.children.length === 2) for (const child of active.children) final(child.response, child.marker, child.id);
      return;
    }
    const tools = toolsIn(payload);
    const spawn = tools.find(tool => tool.name === 'spawn_agent');
    if (spawn?.parameters?.properties?.task_name) {
      // Reproduce the unsupported V2 path on an unpatched runtime as well.
      emit(response, markers.map((message, index) => ({ id: `fc_${index}_${id}`, type: 'function_call', call_id: `call_${index}_${id}`,
        name: spawn.name, namespace: spawn.namespace, status: 'completed', arguments: JSON.stringify({ task_name: `fixture_${index}`, message, fork_turns: 'none' }) })), id);
    } else {
      const exec = tools.find(tool => tool.name === 'exec' && tool.type === 'custom');
      assert.ok(exec, 'model must expose its ordinary programmatic tool calling surface');
      emit(response, [{ id: `ctc_${id}`, type: 'custom_tool_call', call_id: `call_${id}`, name: exec.name, namespace: exec.namespace, input: code, status: 'completed' }], id);
    }
  } catch (error) {
    active.error ??= error;
    if (!response.headersSent) response.writeHead(500);
    response.end();
    active.controller.abort(error);
  }
});
server.on('upgrade', (_request, socket) => { socket.destroy(); active.controller.abort(new Error('Unexpected WebSocket provider fallback')); });

try {
  const engine = engineCommand(selectedEngine);
  const version = (await commandVersion(engine.command, [...engine.prefix, '--version'])).replace(/^codex-cli /, '');
  console.log(`Parallel agent acceptance engine: ${version}`);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  active = { requests: 0, children: [], unsupported: [], parentOutput: '', controller };
  const home = path.join(directory, 'home');
  await mkdir(home);
  // A user's enabled V2 setting must be superseded by subscription defaults.
  await writeFile(path.join(home, 'config.toml'), '[features.multi_agent_v2]\nenabled = true\n');
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, { PATH: originalEnv.PATH, LANG: 'en_US.UTF-8', HOME: home, CODEX_HOME: home,
    OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/unexpected`, OPENAI_API_KEY: key });
  process.chdir(directory);
  const timeout = setTimeout(() => controller.abort(new Error('Parallel agent acceptance timed out')), 45000);
  try {
    const status = await runCodex({ origin: `http://127.0.0.1:${server.address().port}`, key,
      child: Object.assign(new EventEmitter(), { exitCode: null, signalCode: null }) },
    ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '--dangerously-bypass-approvals-and-sandbox', 'Use two parallel local agents and report both results.'],
    { model: 'gpt-6.1-sol', engine: { ...engine, version, source: 'external' }, signal: controller.signal });
    if (active.error) throw active.error;
    assert.equal(status, 0);
    assert.deepEqual(active.unsupported, [], 'subscription requests must not contain V2 agent_message items');
    assert.equal(active.children.length, 2, 'two real child requests must overlap');
    for (const marker of markers) assert.ok(active.parentOutput.includes(marker), 'parent must receive each completed child result');
    console.log('PASS: two concurrent local agents complete and return results through supported subscription input items');
  } finally { clearTimeout(timeout); }
} finally {
  process.chdir(originalCwd);
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, originalEnv);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
