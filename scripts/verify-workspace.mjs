// Integration acceptance for the real official engine. The loopback Responses
// fixture emits a fixed, harmless tool call; no model or gateway is used. Run in
// a network-disabled container to also exclude unrelated engine background I/O.
// Select the engine with MCODEX_WORKSPACE_TEST_CODEX_BIN, or use the bundled one.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bundledCodexEntry, commandVersion, engineCommand } from '../src/engine.js';
import { runCodex } from '../src/tunnel.js';

const selectedEngine = path.resolve(process.env.MCODEX_WORKSPACE_TEST_CODEX_BIN || bundledCodexEntry());
const originalCwd = process.cwd();
const originalEnv = { ...process.env };
const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'mcodex-workspace-')));
const home = path.join(directory, 'home');
const workspace = path.join(directory, 'workspace');
const alternate = path.join(workspace, 'alternate workspace');
const startup = path.join(directory, 'bash-startup');
const marker = 'MCODEX_WORKSPACE_MARKER';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const key = 'offline-workspace-fixture-key';
let active;
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/responses', 'engine must keep the mcodex provider when user config flags are present');
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const payload = JSON.parse(raw);
    active.requests++;
    assert.ok(active.requests <= 3, 'fixture must finish without model retries');
    const outputs = (payload.input ?? []).filter(item => item.type === 'function_call_output');
    active.outputs.push(...outputs.map(item => typeof item.output === 'string' ? item.output : JSON.stringify(item.output)));
    const names = (payload.tools ?? []).map(item => item.name);
    const name = names.includes('exec_command') ? 'exec_command' : 'shell_command';
    assert.ok(names.includes(name), 'official engine must expose a shell tool');
    const id = `response_${active.requests}`;
    const command = 'pwd -P; cat ./workspace-marker.txt';
    const item = outputs.length
      ? { id: `message_${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Workspace check complete.', annotations: [] }] }
      : { id: `function_${id}`, type: 'function_call', call_id: `call_${id}`, name, status: 'completed',
        arguments: JSON.stringify(name === 'exec_command' ? { cmd: command, shell: '/bin/bash', max_output_tokens: 1000 } : { command }) };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
    emit('response.created', { response: { id, status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item });
    emit('response.output_item.done', { output_index: 0, item });
    emit('response.completed', { response: { id, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } });
    response.end();
  } catch (error) {
    active.error = error;
    response.writeHead(500);
    response.end('Invalid workspace fixture request');
    active.controller?.abort(error);
  }
});
server.on('upgrade', (_request, socket) => {
  const error = new Error('Engine dropped the mcodex HTTP provider and attempted a WebSocket connection');
  active.error = error;
  socket.destroy();
  active.controller?.abort(error);
});

try {
  const engine = engineCommand(selectedEngine);
  console.log(`Workspace acceptance engine: ${await commandVersion(engine.command, [...engine.prefix, '--version'])}`);
  await Promise.all([home, workspace, alternate].map(item => mkdir(item, { recursive: true })));
  await Promise.all([workspace, alternate].map(item => writeFile(path.join(item, 'workspace-marker.txt'), `${marker}\n`)));
  // BASH_ENV is confined to this process and its children. Only a login shell
  // changes directory; this models a user's login profile without editing it.
  await writeFile(startup, `if shopt -q login_shell; then cd ${quote(home)}; fi\n`);
  Object.assign(process.env, { HOME: home, PWD: home, SHELL: '/bin/bash', BASH_ENV: startup });
  const probe = spawnSync('/bin/bash', ['-lc', 'pwd -P'], { cwd: workspace, env: process.env, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), home, 'login startup fixture must demonstrate directory drift');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // These credentials are only fixture values. Some engines honor this base
  // URL on provider fallback; the server rejects that unexpected route.
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/unexpected-provider`;
  process.env.OPENAI_API_KEY = key;
  const transport = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const tunnel = { origin: `http://127.0.0.1:${server.address().port}`, key, child: transport };
  const cases = [
    { label: 'login shell reproduces drift without snapshot', options: ['-c', 'allow_login_shell=true', '-c', 'features.shell_snapshot=false'], expected: home, drift: true },
    { label: 'wrapper default preserves cwd without snapshot', options: ['-c', 'features.shell_snapshot=false'], expected: workspace },
    { label: 'wrapper default preserves cwd with default snapshot', options: [], expected: workspace },
    { label: '--cd preserves an explicit relative directory', options: ['-c', 'features.shell_snapshot=false', '--cd', 'alternate workspace'], expected: alternate },
    { label: '--cd= preserves an explicit directory', options: ['-c', 'features.shell_snapshot=false', '--cd=alternate workspace'], expected: alternate },
    { label: '-C preserves an explicit directory', options: ['-c', 'features.shell_snapshot=false', '-C', 'alternate workspace'], expected: alternate },
    { label: 'exec-scoped -c keeps the mcodex provider and workspace defaults', options: [], commandOptions: ['-c', 'features.shell_snapshot=false'], expected: workspace },
    { label: 'mixed root and exec --config preserves the last value', options: ['-c', 'allow_login_shell=true'],
      commandOptions: ['--config', 'allow_login_shell=false', '--config=features.shell_snapshot=false'], expected: workspace },
    { label: 'attached -c and -c= after exec preserve provider defaults', options: [],
      commandOptions: ['-cfeatures.shell_snapshot=false', '-c=allow_login_shell=false'], expected: workspace },
    { label: 'last exec login-shell override remains effective with the mcodex provider', options: ['--config=allow_login_shell=false'],
      commandOptions: ['-c=features.shell_snapshot=false', '--config=allow_login_shell=true'], expected: home, drift: true },
  ];
  for (const [index, scenario] of cases.entries()) {
    active = { requests: 0, outputs: [] };
    const codexHome = path.join(directory, `codex-home-${index}`);
    await mkdir(codexHome);
    process.env.CODEX_HOME = codexHome;
    process.chdir(workspace);
    const controller = new AbortController();
    active.controller = controller;
    const timeout = setTimeout(() => controller.abort(new Error('Workspace integration check timed out')), 30000);
    console.log(`\nWorkspace acceptance: ${scenario.label}`);
    try {
      const status = await runCodex(tunnel, [...scenario.options, 'exec', '--skip-git-repo-check', '--ephemeral', '--json', '--dangerously-bypass-approvals-and-sandbox',
        ...(scenario.commandOptions ?? []), 'Read workspace-marker.txt from the current directory.'], {
        model: 'gpt-5.4', engine: { ...engine, source: 'external' }, signal: controller.signal,
      });
      assert.equal(status, 0, `engine exited during ${scenario.label}`);
      if (active.error) throw active.error;
      assert.ok(active.outputs.length, 'fixture must receive a real shell tool result');
      const output = active.outputs.join('\n');
      assert.ok(output.split('\n').includes(scenario.expected), `${scenario.label}: expected cwd ${scenario.expected}; received:\n${output}`);
      assert.equal(output.includes(marker), !scenario.drift, `${scenario.label}: relative marker read did not match expected directory`);
      console.log(`PASS: ${scenario.label}`);
    } finally { clearTimeout(timeout); }
  }
} finally {
  process.chdir(originalCwd);
  for (const name of Object.keys(process.env)) if (!(name in originalEnv)) delete process.env[name];
  Object.assign(process.env, originalEnv);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
