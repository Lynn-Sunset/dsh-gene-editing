import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Sessions, { buildForkSeed } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools, { defineTool } from '@deepseek-ai/dsh-tools';
import Commands from '@deepseek-ai/dsh-commands';
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime';
import * as RepeatToolReminder from '@deepseek-ai/dsh-repeat-tool-reminder';
import * as Gene from '../lib/index.mjs';
import { presetGenes } from '../lib/shared/public/core.js';

// Real rc.3 services and loop; only the provider and PTC interpreter are local
// fixtures. No network, provider credentials, child processes, or paid calls.
const lowGenes = () => Object.fromEntries(Object.keys(presetGenes()).map(key => [key, 0]));
const highRigor = () => ({ ...lowGenes(), rigor: 100 });
const highGenes = () => Object.fromEntries(Object.keys(presetGenes()).map(key => [key, 100]));
const textOf = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
const feedbackOf = call => call.messages.filter(message => message.source?.kind === 'gene-editing-tools');
const resultOf = (call, id) => call.messages.find(message => message.role === 'tool' && message.toolCallId === id);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function answer(text = 'Fixture answer.') {
  return async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
}

function callsResponse(...calls) {
  return async function* () {
    for (const [index, call] of calls.entries()) {
      const block = { type: 'tool-call', id: call.id, name: call.name, arguments: call.raw ?? JSON.stringify(call.args ?? {}) };
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments };
      yield { type: 'block-end', index, block };
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
}

async function fixture(responses, { mode = 'native', runtimeBehavior } = {}) {
  const ctx = new Context(), fibers = [], handles = [], calls = [], errors = [];
  ctx.on('agent/error', ({ error }) => { errors.push(error.stack || error.message); });
  for (const plugin of [Sessions, Projections, Agents, Llm, Prompt, Commands]) fibers.push(await ctx.plugin(plugin));
  fibers.push(await ctx.plugin(Tools, { mode }));
  if (mode === 'ptc') {
    ctx.provide('workingDirectory', {
      defaultDirectory: process.cwd(),
      get: session => session.header.cwd ?? process.cwd(),
      ensure: agent => Promise.resolve(agent.session.header.cwd ?? process.cwd()),
    });
    class FakeRuntime extends PtcRuntime {
      language = 'typescript';
      isolation = 'fixture';
      resolve(request) { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: 10000 }; }
      run(request) { return runtimeBehavior(request); }
    }
    fibers.push(await ctx.plugin(FakeRuntime));
  }
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }));
  class Fake extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 200000 }, defaultMaxTokens: 32000,
        reasoning: { defaultEffort: 'high', efforts: ['low', 'high', 'max'].map(id => ({ id, name: id })) } };
    }
    async *stream(options) {
      calls.push(options);
      if (calls.length > 20) throw new Error('Unexpected fixture request loop.');
      yield* (responses[calls.length - 1] ?? answer('Unexpected extra continuation.'))(options);
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Fake());
  let gene = await ctx.plugin(Gene, {});
  const agentOptions = { provider: 'fixture', model: 'fake', reasoningEffort: 'high', maxTokens: 32000 };
  const handle = await ctx.agents.create({ sessionId: 'tool-integration-parent', agentOptions });
  handles.push(handle);
  const agent = handle.agent;
  const command = async (input, target = agent) => (await ctx.commands.execute(target, '/gene ' + JSON.stringify(input), [], new AbortController().signal))?.result;
  const get = async (target = agent) => {
    const result = await command({ op: 'get' }, target);
    assert.equal(result?.kind, 'success', result?.text);
    return JSON.parse(result.text);
  };
  return { ctx, calls, errors, agent, command, get,
    async apply(genes = lowGenes(), target = agent) {
      const old = await get(target);
      const result = await command({ op: 'apply', expectedRevision: old.run?.revision ?? 0, genes }, target);
      assert.equal(result?.kind, 'success', result?.text);
      return JSON.parse(result.text);
    },
    async turn(text = 'Use the fixture tools.', target = agent) {
      target.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
      await target.whenIdle();
    },
    async reload() { await gene.dispose(); gene = await ctx.plugin(Gene, {}); },
    async fork(id = 'tool-integration-child') {
      const events = agent.session.snapshotEvents(), boundary = events.at(-1).seq;
      const child = await ctx.agents.create({ sessionId: id, agentOptions,
        meta: { parentSession: agent.id, isSeeded: true }, inheritedEventCount: boundary + 1,
        seed: buildForkSeed(events, boundary) });
      handles.push(child);
      return child.agent;
    },
    async close() {
      for (const item of handles.reverse()) await item.dispose();
      await gene.dispose();
      for (const fiber of fibers.reverse()) await fiber.dispose();
      await ctx.fiber.dispose();
    },
  };
}

function registerEcho(f, name = 'fixture_echo', options = {}) {
  return f.ctx.tools.register(defineTool({
    name, description: 'Deterministic local fixture.', parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) { return options.execute ? options.execute(args, exec) : `echo:${args.value}`; },
    ...(options.isConcurrencySafe ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    ...(options.finalizeContent ? { finalizeContent: options.finalizeContent } : {}),
  }));
}

function summary(view) {
  assert.ok(view.toolIntegration, 'The command must expose native tool integration state.');
  assert.ok(view.toolIntegration.counts);
  assert.ok(Array.isArray(view.toolIntegration.observations));
  return view.toolIntegration;
}

function expectCounts(state, expected) {
  for (const [key, value] of Object.entries(expected)) assert.equal(state.counts[key], value, `tool count ${key}: ${JSON.stringify(state.counts)}`);
}

test('successful ordinary work remains quiet with all Genes high and preserves persistent preferences', async () => {
  const responses = Array.from({ length: 8 }, (_, i) => callsResponse({ id: `ordinary-${i}`, name: 'fixture_echo', args: { value: `file-${i}` } }));
  const f = await fixture([...responses, answer()]);
  try {
    registerEcho(f); await f.apply(highGenes()); await f.turn();
    assert.equal(f.calls.length, 9, JSON.stringify(f.errors));
    for (const request of f.calls) assert.equal(feedbackOf(request).length, 0);
    assert.match(JSON.stringify(f.calls[0].messages.filter(message => message.role === 'system')), /Behavior preferences:/);
    const state = summary(await f.get());
    expectCounts(state, { total: 8, succeeded: 8 }); assert.equal(state.feedback.length, 0);
  } finally { await f.close(); }
});

test('identical successful results produce one focus cue without requiring or stopping a call', async () => {
  const f = await fixture([...Array.from({ length: 4 }, (_, i) => callsResponse({ id: `same-${i}`, name: 'fixture_echo', args: { value: 'same' } })), answer()]);
  try {
    let attempts = 0; registerEcho(f, 'fixture_echo', { execute: async () => { attempts++; return 'unchanged'; } });
    await f.apply(highGenes()); await f.turn();
    assert.equal(f.calls.length, 5); assert.equal(attempts, 4);
    assert.equal(feedbackOf(f.calls[1]).length, 0);
    assert.equal(feedbackOf(f.calls[2]).length, 1);
    assert.equal(feedbackOf(f.calls[4]).length, 1);
    const notes = summary(await f.get()).feedback;
    assert.equal(notes.length, 1); assert.deepEqual(notes[0].genes, ['focus']);
    assert.equal(notes[0].events[0].kind, 'repeat-result');
    assert.match(textOf(feedbackOf(f.calls[2])[0]), /intentional polling/);
  } finally { await f.close(); }
});

test('failure, repeated failure and recovery get distinct cues; unchanged failure does not repeat a lecture', async () => {
  const f = await fixture([...Array.from({ length: 5 }, (_, i) => callsResponse({ id: `attempt-${i}`, name: 'fixture_retry', args: { value: 'same' } })), answer()]);
  try {
    let attempts = 0;
    registerEcho(f, 'fixture_retry', { execute: async () => { if (++attempts <= 3) throw new Error('same failure'); return 'recovered'; } });
    await f.apply(highGenes()); await f.turn();
    assert.equal(attempts, 5); assert.equal(f.calls.length, 6, JSON.stringify(f.errors));
    assert.equal(feedbackOf(f.calls[2]).length, 2);
    assert.equal(feedbackOf(f.calls[3]).length, 2, 'The third identical failure must stay quiet.');
    const state = summary(await f.get());
    assert.deepEqual(state.feedback.flatMap(item => item.events.map(event => event.kind)), ['failure', 'repeat-failure', 'recovery', 'repeat-result']);
    expectCounts(state, { total: 5, failed: 3, succeeded: 2 });
    const original = state.feedback;
    await f.reload(); assert.deepEqual(summary(await f.get()).feedback, original);
  } finally { await f.close(); }
});

test('declared version changes trigger a version cue; arbitrary changed output stays unknown and quiet', async () => {
  const f = await fixture([
    callsResponse({ id: 'declared-1', name: 'ops_result' }, { id: 'untyped-1', name: 'fixture_untyped' }),
    callsResponse({ id: 'declared-2', name: 'ops_result' }, { id: 'untyped-2', name: 'fixture_untyped' }), answer(),
  ]);
  try {
    for (const name of ['ops_result', 'fixture_untyped']) {
      let attempt = 0;
      f.ctx.tools.register(defineTool({ name, description: 'Version fixture.', parameters: {},
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        async execute() { return { complete: true, status: 'success', contentHash: (++attempt === 1 ? 'a' : 'b').repeat(64) }; },
      }));
    }
    await f.apply(highGenes()); await f.turn();
    assert.equal(f.calls.length, 3); assert.equal(feedbackOf(f.calls[1]).length, 0);
    const state = summary(await f.get());
    assert.equal(state.feedback.length, 1); assert.equal(state.feedback[0].events[0].kind, 'version-change');
    assert.equal(state.feedback[0].events[0].callId, 'declared-2');
    assert.ok(state.observations.every(row => row.business === 'unknown'));
    assert.equal(state.observations.find(row => row.callId === 'untyped-2').artifactVersion, null);
  } finally { await f.close(); }
});

test('ordinary low/high RIG changes feedback while preserving the same failed native result and host request settings', { timeout: 15000 }, async () => {
  const observed = [];
  for (const genes of [lowGenes(), highRigor()]) {
    const f = await fixture([callsResponse({ id: 'failure-1', name: 'fixture_fail', args: { value: 'same input' } }), answer()]);
    try {
      let executions = 0;
      registerEcho(f, 'fixture_fail', { execute: async () => { executions++; throw new Error('fixture operation failed'); } });
      await f.apply(genes);
      const userText = 'Try the local fixture once and explain its result.';
      await f.turn(userText);
      assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
      assert.equal(executions, 1);
      assert.ok(f.calls.every(call => call.reasoningEffort === 'high' && call.maxTokens === 32000 && call.provider === 'fixture' && call.model === 'fake'));
      assert.equal(textOf(f.calls[0].messages.find(message => message.source?.kind === 'user')), userText);
      const result = resultOf(f.calls[1], 'failure-1');
      assert.equal(result.isError, true);
      assert.match(textOf(result), /fixture operation failed/);
      const view = await f.get(), state = summary(view);
      expectCounts(state, { total: 1, roots: 1, nested: 0, succeeded: 0, failed: 1, cancelled: 0, skipped: 0 });
      assert.equal(state.observations[0].status, 'failed');
      assert.equal(view.run.mode, 'preferences');
      assert.equal(view.run.budget.callsUsed, 0);
      assert.equal(view.run.evidence.entries.length, 0);
      observed.push({ result: { isError: result.isError, content: result.content }, feedback: feedbackOf(f.calls[1]) });
    } finally { await f.close(); }
  }
  assert.deepEqual(observed[0].result, observed[1].result);
  assert.equal(observed[0].feedback.length, 0);
  assert.equal(observed[1].feedback.length, 1);
  assert.ok(textOf(observed[1].feedback[0]).length > 0);
});

test('downstream post-policy blocks and last-mile finalizer failures are recorded as final failures', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse(
    { id: 'blocked-1', name: 'fixture_blocked', args: { value: 'body-success' } },
    { id: 'finalizer-1', name: 'fixture_finalizer', args: { value: 'body-success' } }), answer()]);
  try {
    let bodies = 0;
    registerEcho(f, 'fixture_blocked', { execute: async () => { bodies++; return 'successful body'; } });
    registerEcho(f, 'fixture_finalizer', { execute: async () => { bodies++; return 'successful body'; },
      finalizeContent() { throw new Error('fixture finalizer failed'); } });
    const nativeContext = createUserMessage({ content: [{ type: 'text', text: 'Preserve the blocking policy context.' }], source: { kind: 'fixture-policy' } });
    f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'fixture_blocked'
      ? { kind: 'block', feedback: [{ type: 'text', text: 'Fixture policy blocked the result.' }], additionalContexts: [nativeContext] }
      : next());
    await f.apply(highRigor()); await f.turn();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors)); assert.equal(bodies, 2);
    const blocked = resultOf(f.calls[1], 'blocked-1'), finalizer = resultOf(f.calls[1], 'finalizer-1');
    assert.equal(blocked.isError, true); assert.equal(textOf(blocked), 'Fixture policy blocked the result.');
    assert.equal(finalizer.isError, true); assert.match(textOf(finalizer), /fixture finalizer failed/);
    assert.equal(f.calls[1].messages.filter(message => message.id === nativeContext.id).length, 1);
    const state = summary(await f.get());
    expectCounts(state, { total: 2, succeeded: 0, failed: 2 });
    assert.ok(state.observations.every(item => item.status === 'failed'));
  } finally { await f.close(); }
});

test('native permission rejection never runs the body or becomes a Gene retry', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse({ id: 'denied-1', name: 'fixture_denied', args: { value: 'no access' } }), answer()]);
  try {
    let executions = 0;
    registerEcho(f, 'fixture_denied', { execute: async () => { executions++; return 'must not execute'; } });
    f.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'fixture_denied'
      ? { kind: 'deny', reason: 'Fixture permission rejected.', info: { name: 'PermissionError', code: 'FIXTURE_PERMISSION_DENIED' } }
      : next());
    await f.apply(highGenes()); await f.turn();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors)); assert.equal(executions, 0);
    assert.equal(resultOf(f.calls[1], 'denied-1').isError, true);
    const state = summary(await f.get());
    expectCounts(state, { total: 1, succeeded: 0, failed: 1 });
    assert.equal(state.observations[0].code, 'FIXTURE_PERMISSION_DENIED');
  } finally { await f.close(); }
});

test('invalid arguments, malformed JSON and unknown tools remain native failures', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse(
    { id: 'schema-1', name: 'fixture_echo', args: { value: 42 } },
    { id: 'json-1', name: 'fixture_echo', raw: '{broken json' },
    { id: 'unknown-1', name: 'fixture_missing', args: {} }), answer()]);
  try {
    let executions = 0;
    registerEcho(f, 'fixture_echo', { execute: async () => { executions++; return 'must not execute'; } });
    await f.apply(highRigor()); await f.turn();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors)); assert.equal(executions, 0);
    for (const id of ['schema-1', 'json-1', 'unknown-1']) assert.equal(resultOf(f.calls[1], id).isError, true);
    const state = summary(await f.get());
    expectCounts(state, { total: 3, roots: 3, nested: 0, failed: 3, succeeded: 0 });
    assert.equal(new Set(state.observations.map(item => item.seq)).size, 3);
  } finally { await f.close(); }
});

test('parallel native dispatches retain one observation per final result without serializing the tool bodies', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse(...[1, 2, 3].map(n => ({ id: `parallel-${n}`, name: 'fixture_parallel', args: { value: String(n) } }))), answer()]);
  try {
    let active = 0, maximum = 0, entered = 0;
    const allEntered = deferred();
    registerEcho(f, 'fixture_parallel', { isConcurrencySafe: () => true, execute: async args => {
      active++; maximum = Math.max(maximum, active);
      if (++entered === 3) allEntered.resolve();
      await allEntered.promise; active--; return `parallel:${args.value}`;
    } });
    await f.apply(lowGenes()); await f.turn();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors)); assert.equal(maximum, 3);
    const state = summary(await f.get());
    expectCounts(state, { total: 3, roots: 3, nested: 0, succeeded: 3, failed: 0 });
    assert.deepEqual(state.observations.map(item => item.callId).sort(), ['parallel-1', 'parallel-2', 'parallel-3']);
    assert.equal(feedbackOf(f.calls[1]).length, 0);
  } finally { await f.close(); }
});

test('native cancellation records the interrupted call and synthetic undispatched siblings without continuing', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse(
    { id: 'cancel-running', name: 'fixture_wait', args: { value: 'running' } },
    { id: 'cancel-skipped-1', name: 'fixture_never', args: { value: 'skip' } },
    { id: 'cancel-skipped-2', name: 'fixture_never', args: { value: 'skip' } })]);
  try {
    const entered = deferred(); let siblings = 0;
    registerEcho(f, 'fixture_wait', { execute: async (_args, exec) => {
      entered.resolve();
      await new Promise(resolve => {
        if (exec.signal.aborted) resolve();
        else exec.signal.addEventListener('abort', resolve, { once: true });
      });
      // Returning after drainage lets rc.3 materialize its canonical ABORTED
      // result; throwing an arbitrary reason would be an ordinary tool error.
      return 'body drained after cancellation';
    } });
    registerEcho(f, 'fixture_never', { execute: async () => { siblings++; return 'must not execute'; } });
    await f.apply(highGenes());
    const pending = f.turn('Start the fixture batch.');
    await entered.promise;
    f.agent.cancel({ kind: 'user' });
    await pending; await new Promise(resolve => setImmediate(resolve)); await f.agent.whenIdle();
    assert.equal(f.calls.length, 1, JSON.stringify(f.errors)); assert.equal(siblings, 0);
    const state = summary(await f.get());
    expectCounts(state, { total: 3, roots: 3, nested: 0, succeeded: 0, cancelled: 1, skipped: 2 });
    assert.equal(state.observations.find(item => item.callId === 'cancel-running').status, 'cancelled');
    assert.ok(state.observations.filter(item => item.callId.startsWith('cancel-skipped')).every(item => item.status === 'skipped'));
    const nativeResults = f.agent.session.snapshotEvents().filter(event => event.type === 'tool/result');
    assert.equal(nativeResults.length, 3);
  } finally { await f.close(); }
});

test('real PTC bridge preserves nested failure facts when its outer program succeeds', { timeout: 15000 }, async () => {
  let nestedValue;
  const f = await fixture([callsResponse({ id: 'ptc-root', name: 'run_code', args: { code: 'fixture program', description: 'Run local fixture bindings.' } }), answer()], {
    mode: 'ptc',
    runtimeBehavior: async request => {
      const bound = request.bindings.find(binding => binding.global === 'tools').functions;
      nestedValue = await bound.fixture_echo({ value: 'nested value' });
      await assert.rejects(() => bound.fixture_fail({ value: 'nested failure' }), /nested failure/);
      return { logs: [], value: 'outer recovered successfully' };
    },
  });
  try {
    registerEcho(f);
    registerEcho(f, 'fixture_fail', { execute: async () => { throw new Error('nested failure'); } });
    await f.apply(highRigor()); await f.turn();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors)); assert.equal(nestedValue, 'echo:nested value');
    assert.equal(resultOf(f.calls[1], 'ptc-root').isError, false);
    const state = summary(await f.get());
    expectCounts(state, { total: 3, roots: 1, nested: 2, succeeded: 2, failed: 1 });
    assert.equal(state.observations.find(item => item.name === 'fixture_fail').status, 'failed');
    for (const item of state.observations.filter(item => item.nested)) assert.equal(item.rootCallId, 'ptc-root');
    const nestedEvents = f.agent.session.snapshotEvents().filter(event => event.type === 'tool/ptc-dispatch');
    assert.equal(nestedEvents.length, 2);
    assert.ok(nestedEvents.every(event => event.data.parentCallId === 'ptc-root'));
    assert.equal(f.calls[1].messages.filter(message => message.role === 'tool').length, 1, 'PTC nested events stay log-only.');
    assert.equal(feedbackOf(f.calls[1]).length, 0, 'A handled nested failure must not become a root failure reminder.');
  } finally { await f.close(); }
});

test('PTC outer policy block does not erase a completed nested operation or expose it as a successful root', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse({ id: 'ptc-blocked', name: 'run_code', args: { code: 'fixture', description: 'Run local fixture.' } }), answer()], {
    mode: 'ptc', runtimeBehavior: async request => {
      await request.bindings.find(binding => binding.global === 'tools').functions.fixture_echo({ value: 'completed inner' });
      return { logs: [], value: 'body result' };
    },
  });
  try {
    registerEcho(f);
    f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'run_code'
      ? { kind: 'block', feedback: [{ type: 'text', text: 'Outer fixture policy blocked.' }] } : next());
    await f.apply(highRigor()); await f.turn();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
    assert.equal(resultOf(f.calls[1], 'ptc-blocked').isError, true);
    const state = summary(await f.get());
    expectCounts(state, { total: 2, roots: 1, nested: 1, succeeded: 1, failed: 1 });
    assert.equal(state.observations.find(item => item.nested).status, 'succeeded');
    assert.equal(state.observations.find(item => !item.nested).status, 'failed');
  } finally { await f.close(); }
});

test('a successful terminal tool remains terminal even with all Genes high', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse({ id: 'terminal-1', name: 'fixture_terminal', args: { value: 'done' } })]);
  try {
    registerEcho(f, 'fixture_terminal', { execute: async (_args, exec) => { exec.concludeTurn(); return 'terminal result'; } });
    await f.apply(highGenes()); await f.turn();
    await new Promise(resolve => setImmediate(resolve)); await f.agent.whenIdle();
    assert.equal(f.calls.length, 1, JSON.stringify(f.errors));
    expectCounts(summary(await f.get()), { total: 1, succeeded: 1, failed: 0 });
    assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'gene-editing-tools').length, 0);
  } finally { await f.close(); }
});

test('tool state survives reload while a fork inherits preferences with an isolated run and ledger', { timeout: 15000 }, async () => {
  const f = await fixture([
    callsResponse({ id: 'parent-failure', name: 'fixture_fail', args: { value: 'parent' } }), answer(),
    callsResponse({ id: 'child-success', name: 'fixture_echo', args: { value: 'child' } }), answer(),
  ]);
  try {
    registerEcho(f); registerEcho(f, 'fixture_fail', { execute: async () => { throw new Error('parent fixture failure'); } });
    await f.apply(highRigor()); await f.turn('Parent question.');
    const before = await f.get();
    await f.reload();
    const restored = await f.get();
    assert.deepEqual(summary(restored).counts, summary(before).counts);
    assert.deepEqual(summary(restored).observations, summary(before).observations);
    assert.equal(restored.run.runId, before.run.runId);
    const child = await f.fork();
    const childBefore = await f.get(child);
    assert.deepEqual(childBefore.run.genes, before.run.genes);
    assert.equal(childBefore.run.mode, 'preferences');
    assert.equal(childBefore.run.sessionId, child.id);
    assert.notEqual(childBefore.run.runId, before.run.runId);
    expectCounts(summary(childBefore), { total: 0, roots: 0, nested: 0 });
    assert.equal(summary(childBefore).observations.length, 0);
    await f.turn('Child independent question.', child);
    assert.equal(f.calls.length, 4, JSON.stringify(f.errors));
    expectCounts(summary(await f.get(child)), { total: 1, succeeded: 1, failed: 0 });
    assert.deepEqual(summary(await f.get()).counts, summary(before).counts);
    await f.reload();
    expectCounts(summary(await f.get(child)), { total: 1, succeeded: 1, failed: 0 });
  } finally { await f.close(); }
});

test('native surface compaction preserves durable tool state; a new user question clears only its working observations', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse({ id: 'compact-failure', name: 'fixture_fail', args: { value: 'original' } }), answer(), answer()]);
  try {
    registerEcho(f, 'fixture_fail', { execute: async () => { throw new Error('fixture compacted failure'); } });
    await f.apply(highRigor()); await f.turn('Original question.');
    const before = summary(await f.get());
    const events = f.agent.session.snapshotEvents();
    const firstUser = events.find(event => event.type === 'user/message' && event.data.source?.kind === 'user');
    const lastAssistant = events.findLast(event => event.type === 'assistant/message');
    f.agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Summary of the original question and failed fixture.' }],
      source: { kind: 'compact-checkpoint', compactionId: 'fixture-compaction' },
    }), { surfaceOp: { op: 'replace', startSeq: firstUser.seq, endSeq: lastAssistant.seq },
      sourceEventSeqs: events.filter(event => event.surfaceOp !== undefined && event.seq >= firstUser.seq && event.seq <= lastAssistant.seq).map(event => event.seq) });
    await f.reload();
    assert.deepEqual(summary(await f.get()).counts, before.counts);
    assert.deepEqual(summary(await f.get()).observations, before.observations);
    await f.turn('A genuinely new question without a tool request.');
    assert.equal(f.calls.length, 3, JSON.stringify(f.errors));
    const after = summary(await f.get());
    assert.deepEqual(after.counts, before.counts); assert.equal(after.observations.length, 0);
    assert.equal(feedbackOf(f.calls[2]).length, 0, 'Old pending feedback must not leak into the new question.');
    await f.apply(highRigor());
    expectCounts(summary(await f.get()), { total: 0, roots: 0, nested: 0 });
  } finally { await f.close(); }
});

test('ordinary auxiliary requests pass through with their native options and without tool feedback or controlled-run accounting', { timeout: 15000 }, async () => {
  const f = await fixture([answer('Fixture title')]);
  try {
    await f.apply(highGenes());
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'Generate a title.' }] }];
    const options = { provider: 'fixture', model: 'native-title', maxTokens: 64000, reasoningEffort: 'low', messages,
      sessionId: f.agent.id, purpose: 'session-title', signal: new AbortController().signal };
    const chunks = []; for await (const chunk of f.ctx.llm.stream(options)) chunks.push(chunk);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].purpose, 'session-title'); assert.equal(f.calls[0].model, 'native-title');
    assert.equal(f.calls[0].maxTokens, 64000); assert.equal(f.calls[0].reasoningEffort, 'low');
    assert.deepEqual(f.calls[0].messages, messages); assert.equal(feedbackOf(f.calls[0]).length, 0);
    assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Fixture title'));
    const view = await f.get();
    expectCounts(summary(view), { total: 0 }); assert.equal(view.run.budget.callsUsed, 0);
  } finally { await f.close(); }
});

test('each Gene contributes at its relevant event; combinations share native continuations', { timeout: 15000 }, async () => {
  const geneNames = Object.keys(lowGenes());
  for (const name of geneNames) {
    const later = ['exploration', 'creativity', 'abstraction', 'focus', 'synthesis'].includes(name);
    const responses = [callsResponse({ id: `single-${name}`, name: 'fixture_fail', args: { value: 'same evidence' } })];
    if (later) responses.push(callsResponse({ id: `again-${name}`, name: 'fixture_fail', args: { value: 'same evidence' } }));
    responses.push(answer());
    const f = await fixture(responses);
    try {
      let attempts = 0;
      registerEcho(f, 'fixture_fail', { execute: async () => {
        if (++attempts === 2 && name === 'synthesis') return 'Recovered fixture result';
        throw new Error('independent Gene fixture');
      } });
      await f.apply({ ...lowGenes(), [name]: 100 }); await f.turn();
      assert.equal(f.calls.length, responses.length, `${name}: ${JSON.stringify(f.errors)}`);
      if (later) assert.equal(feedbackOf(f.calls[1]).length, 0, `${name} should wait for its relevant transition`);
      const feedback = feedbackOf(f.calls.at(-1));
      assert.equal(feedback.length, 1, name);
      assert.deepEqual(feedback[0].source.genes, [name], name);
      assert.match(textOf(feedback[0]), new RegExp(`${name}:`), name);
      assert.deepEqual(summary(await f.get()).feedback[0].genes, [name]);
      expectCounts(summary(await f.get()), { total: later ? 2 : 1, failed: later && name !== 'synthesis' ? 2 : 1 });
    } finally { await f.close(); }
  }
  const f = await fixture([callsResponse({ id: 'combined', name: 'fixture_fail', args: { value: 'same evidence' } }), answer()]);
  try {
    registerEcho(f, 'fixture_fail', { execute: async () => { throw new Error('combined Gene fixture'); } });
    await f.apply(highGenes()); await f.turn();
    const feedback = feedbackOf(f.calls[1]);
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors)); assert.equal(feedback.length, 1);
    assert.deepEqual([...feedback[0].source.genes].sort(), ['depth', 'rigor', 'skepticism']);
    assert.equal(new Set(feedback[0].source.genes).size, 3, 'Only the Genes relevant to this first failure should interrupt.');
  } finally { await f.close(); }
});

test('middle and high Gene settings give distinct guidance without changing execution facts', { timeout: 15000 }, async () => {
  const observed = [];
  for (const rigor of [50, 100]) {
    const f = await fixture([callsResponse({ id: 'tier-fixture', name: 'fixture_fail', args: { value: 'same evidence' } }), answer()]);
    try {
      registerEcho(f, 'fixture_fail', { execute: async () => { throw new Error('tier comparison failure'); } });
      await f.apply({ ...lowGenes(), rigor }); await f.turn();
      const feedback = feedbackOf(f.calls[1]);
      assert.equal(f.calls.length, 2); assert.equal(feedback.length, 1);
      assert.deepEqual(feedback[0].source.genes, ['rigor']);
      observed.push({ text: textOf(feedback[0]), counts: summary(await f.get()).counts, result: resultOf(f.calls[1], 'tier-fixture').content });
    } finally { await f.close(); }
  }
  assert.notEqual(observed[0].text, observed[1].text);
  assert.deepEqual(observed[0].counts, observed[1].counts);
  assert.deepEqual(observed[0].result, observed[1].result);
});

test('inspection reads the current scoped schemas without dispatching discovered capabilities or adding a mandatory step', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse({ id: 'inspect-scoped', name: 'gene_tools_inspect', args: { operation: 'capabilities', query: 'fixture', includeSchemas: true, limit: 20 } }), answer()]);
  let release;
  try {
    let executions = 0;
    registerEcho(f, 'fixture_visible', { execute: async () => { executions++; return 'visible'; } });
    registerEcho(f, 'fixture_hidden', { execute: async () => { executions++; return 'hidden'; } });
    release = f.agent.ctx.tools.restrict({ deny: ['fixture_hidden'] });
    await f.apply(highGenes()); await f.turn('Inspect local capabilities without executing them.');
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors)); assert.equal(executions, 0);
    assert.ok(f.calls[0].tools.some(tool => tool.name === 'gene_tools_inspect'));
    assert.ok(!f.calls[0].tools.some(tool => tool.name === 'fixture_hidden'));
    const result = resultOf(f.calls[1], 'inspect-scoped'); assert.equal(result.isError, false);
    const value = JSON.parse(textOf(result));
    assert.equal(value.totalMatches, 1); assert.equal(value.nextOffset, null);
    assert.deepEqual(value.items.map(item => item.name), ['fixture_visible']);
    assert.equal(value.items[0].parameters.properties.value.type, 'string');
    assert.equal(value.items[0].output.type, 'string');
    assert.match(value.items[0].schemaHash, /^[a-f0-9]{64}$/);
    assert.match(value.catalogRevision, /^[a-f0-9]{64}$/);
    assert.equal(feedbackOf(f.calls[1]).length, 0, 'Inspection alone must not start a feedback loop.');
    expectCounts(summary(await f.get()), { total: 1, succeeded: 1 });
  } finally { release?.(); await f.close(); }
});

test('outcome inspection exposes identities and hashes without copying raw arguments or result text', { timeout: 15000 }, async () => {
  const f = await fixture([
    callsResponse({ id: 'observed-echo', name: 'fixture_echo', args: { value: 'PRIVATE_FIXTURE_PAYLOAD' } }),
    callsResponse({ id: 'inspect-outcomes', name: 'gene_tools_inspect', args: { operation: 'outcomes', limit: 20 } }), answer(),
  ]);
  try {
    registerEcho(f); await f.apply(lowGenes()); await f.turn();
    assert.equal(f.calls.length, 3, JSON.stringify(f.errors));
    const value = JSON.parse(textOf(resultOf(f.calls[2], 'inspect-outcomes')));
    assert.equal(value.observations.length, 1);
    const row = value.observations[0];
    assert.equal(row.callId, 'observed-echo'); assert.equal(row.name, 'fixture_echo'); assert.equal(row.status, 'succeeded');
    assert.match(row.argsHash, /^[a-f0-9]{64}$/); assert.match(row.resultHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_FIXTURE_PAYLOAD/);
    assert.match(textOf(resultOf(f.calls[2], 'observed-echo')), /PRIVATE_FIXTURE_PAYLOAD/, 'The native source result stays intact.');
    expectCounts(summary(await f.get()), { total: 2, succeeded: 2 });
  } finally { await f.close(); }
});

test('inspection requires active preferences and rejects unsupported parameters before any secondary execution', { timeout: 15000 }, async () => {
  const f = await fixture([
    callsResponse({ id: 'inactive-inspection', name: 'gene_tools_inspect', args: { operation: 'capabilities' } }), answer(),
    callsResponse({ id: 'bad-inspection', name: 'gene_tools_inspect', args: { operation: 'capabilities', limit: 1000, execute: 'fixture_echo' } }), answer(),
  ]);
  try {
    let executions = 0; registerEcho(f, 'fixture_echo', { execute: async () => { executions++; return 'must not execute'; } });
    await f.turn('Inspect before activation.');
    assert.equal(resultOf(f.calls[1], 'inactive-inspection').isError, true);
    expectCounts(summary(await f.get()), { total: 0 });
    await f.apply(highRigor()); await f.turn('Attempt invalid inspection parameters.');
    assert.equal(f.calls.length, 4, JSON.stringify(f.errors)); assert.equal(executions, 0);
    assert.equal(resultOf(f.calls[3], 'bad-inspection').isError, true);
    expectCounts(summary(await f.get()), { total: 1, failed: 1 });
  } finally { await f.close(); }
});

test('the native repeat reminder is preserved and suppresses only the duplicate Gene focus instruction', { timeout: 15000 }, async () => {
  const f = await fixture([
    callsResponse({ id: 'repeat-first', name: 'fixture_fail', args: { value: 'same' } }),
    callsResponse({ id: 'repeat-second', name: 'fixture_fail', args: { value: 'same' } }), answer(),
  ]);
  let nativeReminder;
  try {
    nativeReminder = await f.ctx.plugin(RepeatToolReminder, { thresholds: [2], include: [], exclude: [], argumentsPreviewChars: 100 });
    let executions = 0;
    registerEcho(f, 'fixture_fail', { execute: async () => { executions++; throw new Error('repeated fixture failure'); } });
    await f.apply(highGenes()); await f.turn();
    assert.equal(f.calls.length, 3, JSON.stringify(f.errors)); assert.equal(executions, 2);
    const native = f.calls[2].messages.filter(message => message.source?.kind === 'repeat-tool-reminder');
    assert.equal(native.length, 1); assert.match(textOf(native[0]), /repeating|Repeated/);
    const first = feedbackOf(f.calls[1]).at(-1), last = feedbackOf(f.calls[2]).at(-1);
    assert.ok(!first.source.genes.includes('focus'), 'A first failure is not evidence of a repeated call.');
    assert.ok(!last.source.genes.includes('focus'));
    assert.ok(last.source.genes.includes('exploration'));
    assert.equal(last.source.genes.length, 4);
    assert.equal(last.source.events[0].kind, 'repeat-failure');
    expectCounts(summary(await f.get()), { total: 2, failed: 2 });
  } finally { await nativeReminder?.dispose(); await f.close(); }
});

test('a downstream pre-step rejection cannot durably acknowledge feedback that the host did not admit', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse({ id: 'rejected-continuation', name: 'fixture_fail', args: { value: 'failed' } })]);
  try {
    registerEcho(f, 'fixture_fail', { execute: async () => { throw new Error('failed before rejected step'); } });
    let rejected = 0;
    f.ctx.on('agent/pre-step', async ({ step }, next) => {
      const decision = await next();
      if (step === 2) { rejected++; return { kind: 'reject' }; }
      return decision;
    });
    await f.apply(highGenes()); await f.turn();
    assert.equal(rejected, 1); assert.equal(f.calls.length, 1, JSON.stringify(f.errors));
    const state = summary(await f.get());
    expectCounts(state, { total: 1, failed: 1 }); assert.equal(state.observations.length, 1);
    assert.equal(state.feedback.length, 0);
    assert.equal(f.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'gene-editing-tools').length, 0);
    await f.reload(); assert.equal(summary(await f.get()).feedback.length, 0);
  } finally { await f.close(); }
});

test('explicit ops business metadata distinguishes a failed operation from successful transport and ignores unrelated result keywords', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse(
    { id: 'ops-business', name: 'ops_batch', args: {} },
    { id: 'unrelated-business', name: 'fixture_status_object', args: {} }), answer()]);
  try {
    const value = { status: 'failed', failed: 1, source: { contentHash: 'a'.repeat(64) } };
    for (const name of ['ops_batch', 'fixture_status_object']) f.ctx.tools.register(defineTool({
      name, description: 'Structured business outcome fixture.', parameters: {},
      output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }] },
      async execute() { return value; },
    }));
    await f.apply(highRigor()); await f.turn();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
    for (const id of ['ops-business', 'unrelated-business']) {
      const result = resultOf(f.calls[1], id);
      assert.equal(result.isError, false); assert.deepEqual(JSON.parse(textOf(result)), value);
    }
    const state = summary(await f.get());
    expectCounts(state, { total: 2, succeeded: 2, failed: 0 });
    const ops = state.observations.find(row => row.callId === 'ops-business');
    assert.equal(ops.status, 'succeeded'); assert.equal(ops.business, 'failed'); assert.equal(ops.artifactVersion, 'a'.repeat(64));
    const unrelated = state.observations.find(row => row.callId === 'unrelated-business');
    assert.equal(unrelated.business, 'unknown'); assert.equal(unrelated.artifactVersion, null);
    assert.match(textOf(feedbackOf(f.calls[1]).at(-1)), /business=failed/);
    await f.reload();
    assert.deepEqual(summary(await f.get()).observations, state.observations);
  } finally { await f.close(); }
});

test('PTC inspection sees scoped SDK leaf contracts while the model wire exposes only run_code', { timeout: 15000 }, async () => {
  let inspected;
  const f = await fixture([callsResponse({ id: 'ptc-inspection-root', name: 'run_code', args: { code: 'inspect fixture SDK', description: 'Inspect local SDK capability contracts.' } }), answer()], {
    mode: 'ptc', runtimeBehavior: async request => {
      inspected = await request.bindings.find(binding => binding.global === 'tools').functions.gene_tools_inspect({
        operation: 'capabilities', query: 'fixture', includeSchemas: true, limit: 20,
      });
      return { logs: [], value: { observedNames: inspected.items.map(item => item.name) } };
    },
  });
  let release;
  try {
    let executions = 0;
    registerEcho(f, 'fixture_ptc_visible', { execute: async () => { executions++; return 'not executed'; } });
    registerEcho(f, 'fixture_ptc_hidden', { execute: async () => { executions++; return 'not executed'; } });
    release = f.agent.ctx.tools.restrict({ deny: ['fixture_ptc_hidden'] });
    await f.apply(lowGenes()); await f.turn('Inspect the fixture SDK without invoking its leaf operation.');
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors)); assert.equal(executions, 0);
    assert.deepEqual(f.calls[0].tools.map(tool => tool.name), ['run_code']);
    assert.ok(inspected, JSON.stringify(f.errors));
    assert.equal(inspected.totalMatches, 1);
    assert.deepEqual(inspected.items.map(item => item.name), ['fixture_ptc_visible']);
    assert.equal(inspected.items[0].parameters.properties.value.type, 'string');
    assert.equal(inspected.items[0].output.type, 'string');
    expectCounts(summary(await f.get()), { total: 2, roots: 1, nested: 1, succeeded: 2 });
    assert.equal(summary(await f.get()).observations.find(item => item.nested).name, 'gene_tools_inspect');
  } finally { release?.(); await f.close(); }
});

test('ops_result pagination and source capture metadata do not masquerade as a business execution verdict', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse(
    { id: 'ops-page', name: 'ops_result', args: { kind: 'page' } },
    { id: 'ops-page-error', name: 'ops_result', args: { kind: 'error' } }), answer()]);
  try {
    // dsh-ops' page `complete` describes retained rows, independently from
    // source execution/capture. An opaque source object is not verified here.
    const page = { complete: false, offset: 0, nextOffset: 2, total: 5, omitted: 3,
      sourceTotal: 7, contentHash: 'b'.repeat(64), items: [{ item: 1 }, { item: 2 }],
      source: { status: 'completed', failed: 1, unknown: 2, captureComplete: false, capturedItems: 5 } };
    const failure = { error: { code: 'NOT_FOUND', message: 'Fixture reference unavailable.' } };
    f.ctx.tools.register(defineTool({
      name: 'ops_result', description: 'Session-owned result page fixture.', parameters: { kind: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args) { return args.kind === 'page' ? page : failure; },
    }));
    await f.apply(highRigor()); await f.turn();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
    assert.equal(resultOf(f.calls[1], 'ops-page').isError, false);
    assert.deepEqual(JSON.parse(textOf(resultOf(f.calls[1], 'ops-page'))), page);
    const state = summary(await f.get());
    expectCounts(state, { total: 2, succeeded: 2, failed: 0 });
    const pageRow = state.observations.find(row => row.callId === 'ops-page');
    assert.equal(pageRow.business, 'unknown'); assert.equal(pageRow.artifactVersion, 'b'.repeat(64));
    assert.equal(state.observations.find(row => row.callId === 'ops-page-error').business, 'failed');
  } finally { await f.close(); }
});

function replaceNativeToolResult(session, original) {
  // The same single-node replacement used by the native tool-result pruner;
  // this changes retained presentation, without dispatching another tool.
  return session.append('tool/result', { ...original.data,
    message: { ...original.data.message, content: [{ type: 'text', text: 'Pruned fixture result; consult original provenance.' }] },
  }, { surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq }, sourceEventSeqs: [original.seq] });
}

test('pruning a tool result outside the 128 retained observations does not count a new execution or feedback', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse(...Array.from({ length: 129 }, (_, index) => ({
    id: `bounded-${index}`, name: 'fixture_echo', args: { value: String(index) },
  }))), answer()]);
  try {
    registerEcho(f, 'fixture_echo', { isConcurrencySafe: () => true });
    await f.apply(highRigor()); await f.turn();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
    const before = summary(await f.get());
    expectCounts(before, { total: 129, roots: 129, nested: 0, succeeded: 129 });
    assert.equal(before.observations.length, 128);
    assert.ok(!before.observations.some(row => row.callId === 'bounded-0'));
    const original = f.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'bounded-0');
    assert.ok(original);
    const replacement = replaceNativeToolResult(f.agent.session, original);
    assert.ok(replacement.seq > original.seq);
    const after = summary(await f.get());
    assert.deepEqual(after.counts, before.counts);
    assert.deepEqual(after.observations, before.observations);
    assert.deepEqual(after.feedback, before.feedback);
    assert.equal(after.dropped, before.dropped);
    await f.reload();
    assert.deepEqual(summary(await f.get()), after);
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

test('pruning a previous question result cannot repopulate the new question ledger or feedback', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse({ id: 'old-question-result', name: 'fixture_fail', args: { value: 'old question' } }), answer(), answer()]);
  try {
    registerEcho(f, 'fixture_fail', { execute: async () => { throw new Error('Old question fixture failure.'); } });
    await f.apply(highRigor()); await f.turn('The old question.');
    const original = f.agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'old-question-result');
    assert.ok(original);
    await f.turn('A new unrelated question with no tools.');
    const before = summary(await f.get());
    expectCounts(before, { total: 1, failed: 1 });
    assert.equal(before.observations.length, 0); assert.equal(before.feedback.length, 0);
    replaceNativeToolResult(f.agent.session, original);
    const after = summary(await f.get());
    assert.deepEqual(after.counts, before.counts);
    assert.equal(after.observations.length, 0); assert.equal(after.feedback.length, 0);
    await f.reload();
    assert.deepEqual(summary(await f.get()), after);
    assert.equal(f.calls.length, 3, JSON.stringify(f.errors));
  } finally { await f.close(); }
});

test('PTC root and nested calls with identical callId text retain their distinct native identities', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse(
    { id: 'root', name: 'run_code', args: { code: 'first fixture root', description: 'First root invocation.' } },
    { id: 'root:ptc:1', name: 'run_code', args: { code: 'second fixture root', description: 'Second root invocation.' } }), answer()], {
    mode: 'ptc', runtimeBehavior: async request => {
      const value = await request.bindings.find(binding => binding.global === 'tools').functions.fixture_echo({ value: 'nested invocation' });
      return { logs: [], value };
    },
  });
  try {
    registerEcho(f); await f.apply(lowGenes()); await f.turn();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
    const state = summary(await f.get());
    expectCounts(state, { total: 4, roots: 2, nested: 2, succeeded: 4, failed: 0 });
    const colliding = state.observations.filter(row => row.callId === 'root:ptc:1');
    assert.equal(colliding.length, 2);
    assert.deepEqual(colliding.map(row => ({ name: row.name, nested: row.nested, rootCallId: row.rootCallId })), [
      { name: 'fixture_echo', nested: true, rootCallId: 'root' },
      { name: 'run_code', nested: false, rootCallId: 'root:ptc:1' },
    ]);
    assert.equal(f.calls[1].messages.filter(message => message.role === 'tool').length, 2);
    await f.reload(); assert.deepEqual(summary(await f.get()).observations, state.observations);
  } finally { await f.close(); }
});

test('a nested terminal marker cannot suppress Gene feedback when the outer PTC result is blocked', { timeout: 15000 }, async () => {
  const f = await fixture([callsResponse({ id: 'blocked-terminal-root', name: 'run_code', args: { code: 'nested terminal fixture', description: 'Run nested terminal fixture.' } }), answer()], {
    mode: 'ptc', runtimeBehavior: async request => {
      const value = await request.bindings.find(binding => binding.global === 'tools').functions.fixture_terminal({ value: 'terminal nested result' });
      return { logs: [], value };
    },
  });
  try {
    registerEcho(f, 'fixture_terminal', { execute: async (args, exec) => { exec.concludeTurn(); return args.value; } });
    f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'run_code'
      ? { kind: 'block', feedback: [{ type: 'text', text: 'The outer policy rejected this terminal result.' }] }
      : next());
    await f.apply(highRigor()); await f.turn();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
    assert.equal(resultOf(f.calls[1], 'blocked-terminal-root').isError, true);
    const state = summary(await f.get());
    expectCounts(state, { total: 2, roots: 1, nested: 1, succeeded: 1, failed: 1 });
    assert.equal(feedbackOf(f.calls[1]).length, 1);
    assert.equal(state.feedback.length, 1);
    assert.deepEqual(state.feedback[0].genes, ['rigor']);
  } finally { await f.close(); }
});
