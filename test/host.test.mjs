import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import Sessions, { appendPluginRecord } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Llm, { LlmAdapter, createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import * as NativeRetry from '@deepseek-ai/dsh-llm-retry';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Commands from '@deepseek-ai/dsh-commands';
import * as Gene from '../lib/index.mjs';
import { presetGenes } from '../lib/shared/public/core.js';

const broken = 'function solve(input) { const seen=new Set(); return input.filter(pair=>{const key=pair.join("|"); if(seen.has(key))return false; seen.add(key); return true;}); }';
const fixed = 'function solve(input) { const seen=new Set(); return input.filter(pair=>{const key=JSON.stringify(pair); if(seen.has(key))return false; seen.add(key); return true;}); }';
async function fixture(responses = [broken, fixed], cap = 20000, reasoningEffort = 'high', geneConfig = { maxTokens: 20000 }, retry = null) {
  const ctx = new Context(), calls = [], fibers = [], errors = [];
  ctx.on('agent/error', ({ error }) => { errors.push(error.stack || error.message); });
  for (const plugin of [Sessions, Projections, Agents, Llm, Prompt, Tools, Commands]) fibers.push(await ctx.plugin(plugin));
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }));
  class Fake extends LlmAdapter {
    providerRetryPolicy() { return retry?.native ? resolveRetryPolicy({ mode: 'always', backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }) : undefined; }
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 200000 }, defaultMaxTokens: cap ?? 32000, reasoning: { defaultEffort: 'high', efforts: ['low', 'high', 'max'].map(id => ({ id, name: id })) } }; }
    async *stream(options) {
      calls.push(options);
      const text = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (typeof text === 'function') { yield* text(options); return; }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '```js\n' + text + '\n```' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '```js\n' + text + '\n```' } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Fake());
  if (retry?.native) fibers.push(await ctx.plugin(NativeRetry));
  else if (retry) ctx.on('agent/request-error', retry);
  let gene = await ctx.plugin(Gene, { exposeVerifierTool: true, ...geneConfig });
  const handle = await ctx.agents.create({ sessionId: 'gene-test', agentOptions: { provider: 'fixture', model: 'fake', reasoningEffort, ...(cap === null ? {} : { maxTokens: cap }) } });
  const agent = handle.agent;
  const command = async input => (await ctx.commands.execute(agent, '/gene ' + JSON.stringify(input), [], new AbortController().signal))?.result;
  const get = async () => JSON.parse((await command({ op: 'get' })).text);
  return { ctx, calls, errors, agent, handle, command, get,
    async reload(nextConfig = geneConfig) { geneConfig = nextConfig; await gene.dispose(); gene = await ctx.plugin(Gene, { exposeVerifierTool: true, ...geneConfig }); },
    async unload() { await gene.dispose(); },
    async close() { await handle.dispose(); await gene.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose(); await ctx.fiber.dispose(); } };
}

function legacy(run, version = 3, maxTokens = 20000) {
  const saved = structuredClone(run);
  saved.version = version; saved.maxCalls = 2; saved.maxTokens = maxTokens;
  saved.budget.maxTokens = maxTokens; saved.budget.maxCalls = 2; saved.budget.remainingCalls = 2 - saved.budget.callsUsed;
  delete saved.progress; delete saved.legacyCapRestore;
  if (version < 3) delete saved.maxTokens;
  if (version === 1) { delete saved.settings; delete saved.historicalReadOnly; }
  return saved;
}

function plainAnswer(text, reason = { kind: 'stop' }) {
  return async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
    yield { type: 'finish', reason };
  };
}
const systemText = call => call.messages.filter(message => message.role === 'system').flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
async function ordinaryTurn(f, text) {
  f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
  await f.agent.whenIdle();
}

test('real Cordis Host, native loop, evidence repair, same checks, durable budget and unload', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const initial = await f.get(); assert.equal(initial.run, null);
    const genes = { ...presetGenes(), skepticism: 100 };
    const start = await f.command({ op: 'start', taskId: 'tuple_dedup', genes, expectedRevision: 0 });
    assert.equal(start.kind, 'success', start.text);
    await f.agent.whenIdle();
    const state = await f.get();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
    assert.ok(f.calls.every(c => c.maxTokens === 20000 && c.reasoningEffort === 'high'));
    assert.equal(state.run.budget.callsUsed, 2);
    assert.equal(state.run.phase, 'complete');
    assert.equal(state.run.evidence.entries[0].status, 'failed');
    assert.equal(state.run.evidence.entries[1].status, 'passed');
    assert.ok(state.run.evidence.entries[1].checks.some(c => c.id === 'tuple_dedup.delimiter'));
    assert.ok(JSON.stringify(f.calls[1].messages).includes('Public execution feedback'));
    await f.reload();
    assert.equal((await f.get()).run.budget.callsUsed, 2);
    assert.equal((await f.command({ op: 'set', genes, expectedRevision: 0 })).kind, 'error');
    await f.unload();
    assert.equal(await f.ctx.commands.execute(f.agent, '/gene {}', [], new AbortController().signal), undefined);
    assert.equal(f.ctx.sessionProjections.stateOf(f.agent.session, 'geneEditing'), undefined);
  } finally { await f.close(); }
});

test('same-session revision conflicts, cross-session isolation and effort mismatch fail closed', async () => {
  const f = await fixture();
  try {
    const genes = presetGenes();
    assert.equal((await f.command({ op: 'start', taskId: 'tuple_dedup', genes, expectedRevision: 0, submit: false })).kind, 'success');
    assert.equal((await f.command({ op: 'set', genes, expectedRevision: 0 })).kind, 'error');
    assert.equal((await f.command({ op: 'set', genes: { ...genes, depth: 100 }, expectedRevision: 1 })).kind, 'success');
    assert.equal((await f.get()).run.settings.reasoningEffort, 'high');
    assert.equal((await f.command({ op: 'start', taskId: 'tuple_dedup', settings: { reasoningEffort: 'max' }, expectedRevision: 2, submit: false })).kind, 'error');
    const other = await f.ctx.agents.create({ sessionId: 'other', agentOptions: { provider: 'fixture', model: 'fake', maxTokens: 20000 } });
    try { const reply = await f.ctx.commands.execute(other.agent, '/gene {"op":"get"}', [], new AbortController().signal); assert.equal(JSON.parse(reply.result.text).run, null); } finally { await other.dispose(); }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('new runs preserve a host limit above the former 100k plugin ceiling', async () => {
  const f = await fixture([fixed], 256000);
  try { const reply = await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0 }); assert.equal(reply.kind, 'success', reply.text); await f.agent.whenIdle(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].maxTokens, 256000); assert.equal((await f.get()).run.budget.calls[0].maxTokens, 256000); }
  finally { await f.close(); }
});

test('auxiliary calls are refused and missing usage remains unknown', async () => {
  const noUsage = async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TEST', message: 'fixture', status: 402 } } }; };
  const f = await fixture([noUsage]);
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0, submit: false });
    const opts = { provider: 'fixture', model: 'fake', maxTokens: 20000, reasoningEffort: 'high', messages: [], sessionId: f.agent.id, purpose: 'session-title' };
    await assert.rejects(async () => { for await (const _ of f.ctx.llm.stream(opts)) {} }, /Auxiliary/);
    assert.equal(f.calls.length, 0);
    delete opts.purpose;
    for await (const _ of f.ctx.llm.stream(opts)) {}
    assert.equal((await f.get()).run.budget.missingUsageCalls, 1);
    assert.equal((await f.get()).run.budget.knownTotalTokens, 0);
  } finally { await f.close(); }
});

test('native transport retry can exceed two attempts and every attempt is accounted', async () => {
  const transient = async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP_ERROR', status: 503, message: 'local fixture' } } }; };
  let retries = 0;
  const f = await fixture([transient, transient, fixed], 32000, 'high', {}, async ({ signal }) => { signal.throwIfAborted(); retries++; await new Promise(resolve => setTimeout(resolve, 5)); return { kind: 'retry' }; });
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0 });
    await f.agent.whenIdle();
    assert.equal(f.calls.length, 3, JSON.stringify(f.errors)); assert.equal(retries, 2);
    const run = (await f.get()).run;
    assert.equal(run.budget.callsUsed, 3); assert.equal(run.budget.missingUsageCalls, 2); assert.equal(run.budget.maxCalls, null);
    assert.equal(run.phase, 'complete');
  } finally { await f.close(); }
});

test('plugin unload cancels and drains an in-flight native model request', { timeout: 10000 }, async () => {
  let entered; const began = new Promise(resolve => { entered = resolve; });
  let drained = false;
  const hanging = async function* (options) {
    entered();
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    drained = true;
    yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'fixture' } } };
  };
  const f = await fixture([hanging]);
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0 });
    await began;
    await f.unload();
    assert.equal(drained, true); assert.equal(f.agent.status, 'idle');
    assert.equal(f.calls.length, 1);
  } finally { await f.close(); }
});

test('truncation can repair in the native turn and retains verified completion', async () => {
  const truncated = async function* () {
    const text = '```js\nfunction solve(input) {';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20000, totalTokens: 20010 } };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  };
  const f = await fixture([truncated, fixed]);
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0 }); await f.agent.whenIdle();
    await new Promise(resolve => setImmediate(resolve)); await f.agent.whenIdle();
    const run = (await f.get()).run;
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
    assert.equal(run.phase, 'complete'); assert.equal(run.budget.callsUsed, 2);
  } finally { await f.close(); }
});

test('malformed candidate gets one format recovery without requiring harness JSON', async () => {
  const f = await fixture(['{"answer":"not executable"}', fixed]);
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0 }); await f.agent.whenIdle();
    const run = (await f.get()).run;
    assert.equal(f.calls.length, 2); assert.equal(run.evidence.entries[0].status, 'unknown'); assert.equal(run.phase, 'complete');
    assert.ok(JSON.stringify(f.calls[1].messages).includes('no JSON wrapper'));
  } finally { await f.close(); }
});

test('FOC controls evidence reuse and no-progress stopping independently of total calls', async () => {
  for (const [focus, entries, calls] of [[100, 1, 2], [0, 3, 3]]) {
    const f = await fixture([broken, broken]);
    try {
      await f.command({ op: 'start', taskId: 'tuple_dedup', genes: { ...presetGenes(), skepticism: 100, focus }, expectedRevision: 0 });
      await f.agent.whenIdle();
      const run = (await f.get()).run;
      assert.equal(run.budget.callsUsed, calls);
      assert.equal(run.evidence.entries.length, entries, `FOC=${focus}`);
      assert.equal(run.unchanged, calls - 1); assert.equal(run.phase, 'blocked');
    } finally { await f.close(); }
  }
});

test('optional native gene_verify tool uses actual Harness tool dispatch and records public evidence', async () => {
  const f = await fixture();
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', genes: { ...presetGenes(), skepticism: 100 }, expectedRevision: 0, submit: false });
    const result = await f.ctx.tools.execute({ callId: 'fixture-verify', name: 'gene_verify', arguments: { artifact: broken }, agent: f.agent, signal: new AbortController().signal });
    assert.ok(JSON.stringify(result).includes('tuple_dedup.delimiter'));
    assert.equal((await f.get()).run.evidence.entries[0].status, 'failed');
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('optional verifier enforces its complete argument contract before recording evidence', async () => {
  const f = await fixture();
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0, submit: false });
    for (const args of [[], null, 'not an object', {}, { artifact: broken, extra: true }, { artifact: 'x'.repeat(131073) }]) {
      const result = await f.ctx.tools.execute({ callId: 'bad-verify', name: 'gene_verify', arguments: args, agent: f.agent, signal: new AbortController().signal });
      assert.equal(result.isError, true); assert.equal(result.error.info.code, 'INVALID_ARGS');
    }
    assert.equal((await f.get()).run.evidence.entries.length, 0); assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

for (const effort of ['low', 'high', 'max']) test(`DEP changes semantic instructions while native Agent effort remains ${effort}`, async () => {
  const f = await fixture([fixed], 20000, effort);
  try {
    const initial = await f.get();
    assert.equal(initial.capabilities.fixedEffort, effort);
    assert.equal(initial.defaultSettings.reasoningEffort, effort);
    for (const [depth, expectedRevision] of [[0, 0], [100, 1]]) {
      const reply = await f.command({ op: 'start', taskId: 'tuple_dedup', genes: { ...presetGenes(), depth }, settings: { reasoningEffort: effort }, expectedRevision });
      assert.equal(reply.kind, 'success', reply.text); await f.agent.whenIdle();
      const run = (await f.get()).run;
      assert.equal(run.version, 4); assert.equal(run.settings.reasoningEffort, effort);
      assert.equal(run.effectiveEffort, effort); assert.equal(run.budget.maxTokens, null); assert.equal(run.budget.calls[0].maxTokens, 20000);
    }
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
    assert.ok(f.calls.every(c => c.reasoningEffort === effort && c.maxTokens === 20000));
    const depthLine = call => JSON.stringify(call.messages).match(/depth: ([^\\]*)/)?.[1];
    assert.ok(depthLine(f.calls[0]), 'DEP has a public semantic preference');
    assert.notEqual(depthLine(f.calls[0]), depthLine(f.calls[1]));
    await f.reload();
    assert.equal((await f.get()).run.settings.reasoningEffort, effort);
    assert.equal((await f.get()).run.budget.callsUsed, 1);
  } finally { await f.close(); }
});

test('all Gene edits preserve independent effort and reject effort mutation through set', async () => {
  const f = await fixture([fixed], 20000, 'low');
  try {
    const first = await f.command({ op: 'start', taskId: 'tuple_dedup', submit: false, expectedRevision: 0 });
    assert.equal(first.kind, 'success', first.text);
    const genes = Object.fromEntries(Object.keys(presetGenes()).map(k => [k, 100]));
    assert.equal((await f.command({ op: 'set', genes, expectedRevision: 1 })).kind, 'success');
    const run = (await f.get()).run;
    assert.equal(run.settings.reasoningEffort, 'low'); assert.equal(run.effectiveEffort, 'low');
    const denied = await f.command({ op: 'set', genes, settings: { reasoningEffort: 'max' }, expectedRevision: 2 });
    assert.equal(denied.kind, 'error'); assert.match(denied.text, /cannot change effort/);
    assert.equal((await f.get()).run.revision, 2);
    for (const value of ['max', 'invalid', null, {}, true]) {
      const reply = await f.command({ op: 'start', taskId: 'tuple_dedup', settings: { reasoningEffort: value }, expectedRevision: 2, submit: false });
      assert.equal(reply.kind, 'error');
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('historical v1 state remains visible and read-only until an explicit new v4 run', async () => {
  const f = await fixture();
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', genes: { ...presetGenes(), skepticism: 100 }, expectedRevision: 0 });
    await f.agent.whenIdle();
    const historical = legacy((await f.get()).run, 1);
    appendPluginRecord(f.agent.session, 'plugin:gene-editing/state', historical);
    await f.reload();
    const state = await f.get();
    assert.equal(state.run.version, 1); assert.equal(state.run.historicalReadOnly, true);
    assert.equal(state.run.budget.callsUsed, 2); assert.deepEqual(state.run.evidence, historical.evidence);
    assert.equal((await f.command({ op: 'set', genes: presetGenes(), expectedRevision: 1 })).kind, 'error');
    const options = { provider: 'fixture', model: 'fake', maxTokens: 20000, reasoningEffort: 'high', messages: [], sessionId: f.agent.id };
    await assert.rejects(async () => { for await (const _ of f.ctx.llm.stream(options)) {} }, /Historical Gene run is read-only/);
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.ctx.sessionProjections.stateOf(f.agent.session, 'geneEditing').run, historical, 'read-only access never rewrites historical state');
    const reply = await f.command({ op: 'start', taskId: 'tuple_dedup', genes: { ...presetGenes(), depth: 100 }, expectedRevision: 1, submit: false });
    assert.equal(reply.kind, 'success', reply.text);
    const fresh = (await f.get()).run;
    assert.equal(fresh.version, 4); assert.equal(fresh.historicalReadOnly, false); assert.equal(fresh.budget.callsUsed, 0);
  } finally { await f.close(); }
});

test('host cap survives repair and reload while obsolete plugin config no longer limits new runs', async () => {
  const f = await fixture([broken, fixed], 100000, 'max', {});
  try {
    assert.equal((await f.get()).defaultSettings.maxTokens, null);
    const start = await f.command({ op: 'start', taskId: 'tuple_dedup', genes: { ...presetGenes(), skepticism: 100 }, expectedRevision: 0 });
    assert.equal(start.kind, 'success', start.text); await f.agent.whenIdle();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
    assert.ok(f.calls.every(c => c.maxTokens === 100000 && c.reasoningEffort === 'max'));
    await f.reload({ maxTokens: 20000 });
    const run = (await f.get()).run;
    assert.equal(run.version, 4); assert.equal(run.maxTokens, null); assert.equal(run.budget.maxTokens, null);
    assert.ok(run.budget.calls.every(c => c.maxTokens === 100000));
    assert.equal(run.budget.callsUsed, 2);
  } finally { await f.close(); }
});

test('v2 restoration retains 20k and independent effort after new-run caps are removed', async () => {
  const f = await fixture([fixed]);
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0, submit: false });
    const historical = legacy((await f.get()).run, 2);
    delete historical.maxTokens; delete historical.manageRequestBudget; delete historical.requestBudgetOverride;
    appendPluginRecord(f.agent.session, 'plugin:gene-editing/state', historical);
    await f.reload({ maxTokens: 100000, manageRequestBudget: true });
    const restored = (await f.get()).run;
    assert.equal(restored.version, 2); assert.equal(restored.maxTokens, 20000); assert.equal(restored.budget.maxTokens, 20000);
    assert.deepEqual(f.ctx.sessionProjections.stateOf(f.agent.session, 'geneEditing').run, historical);
    assert.equal((await f.command({ op: 'set', genes: { ...presetGenes(), depth: 100 }, expectedRevision: 1 })).kind, 'success');
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Return the fixture function.' }] }));
    await f.agent.whenIdle();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].maxTokens, 20000);
  } finally { await f.close(); }
});

for (const originalCap of [32000, null]) test(`managed cap changes only active v3 requests and restores ${originalCap ?? 'adapter default'} after stop`, async () => {
  const f = await fixture([fixed], originalCap, 'max', { manageRequestBudget: true });
  try {
    assert.equal((await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0, submit: false })).kind, 'success');
    const historical = { ...legacy((await f.get()).run, 3, 100000), manageRequestBudget: true, requestBudgetOverride: null };
    appendPluginRecord(f.agent.session, 'plugin:gene-editing/state', historical); await f.reload();
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Return the fixture.' }] }));
    await f.agent.whenIdle();
    assert.equal(f.calls.length, 1, JSON.stringify(f.errors));
    assert.equal(f.calls[0].maxTokens, 100000); assert.equal(f.calls[0].reasoningEffort, 'max');
    assert.equal(f.calls[0].provider, 'fixture'); assert.equal(f.calls[0].model, 'fake');
    assert.deepEqual((await f.get()).run.requestBudgetOverride, { originalMaxTokens: originalCap });
    await f.reload({ maxTokens: 20000, manageRequestBudget: false });
    const stop = await f.command({ op: 'stop', expectedRevision: 1 }); assert.equal(stop.kind, 'success', stop.text);
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Ordinary turn after Gene control.' }] }));
    await f.agent.whenIdle();
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
    assert.equal(f.calls[1].maxTokens, 32000); assert.equal(f.calls[1].reasoningEffort, 'max');
    assert.equal((await f.get()).run.budget.callsUsed, 1, 'ordinary request is outside Gene ledger');
  } finally { await f.close(); }
});

test('managed run still refuses a bypassed mismatching wire cap before dispatch', async () => {
  const f = await fixture([fixed], 32000, 'high', { manageRequestBudget: true });
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0, submit: false });
    appendPluginRecord(f.agent.session, 'plugin:gene-editing/state', { ...legacy((await f.get()).run, 3, 100000), manageRequestBudget: true, requestBudgetOverride: null }); await f.reload();
    const opts = { provider: 'fixture', model: 'fake', maxTokens: 20000, reasoningEffort: 'high', messages: [], sessionId: f.agent.id };
    await assert.rejects(async () => { for await (const _ of f.ctx.llm.stream(opts)) {} }, /must equal 100000/);
    assert.equal(f.calls.length, 0); assert.equal((await f.get()).run.budget.callsUsed, 0);
  } finally { await f.close(); }
});

test('native pending/default effort selection outranks stale header and plugin fixed fallback', async () => {
  const f = await fixture([fixed]);
  try {
    const selected = { provider: 'fixture', model: 'fake', reasoningEffort: 'max' };
    f.ctx.provide('agentDefaultModel', { currentSelection: () => selected });
    assert.equal((await f.get()).capabilities.fixedEffort, 'max');
    delete selected.reasoningEffort;
    const missing = await f.command({ op: 'get' });
    assert.equal(missing.kind, 'success'); assert.equal(JSON.parse(missing.text).defaultSettings.reasoningEffort, null);
    const strictStart = await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0, submit: false });
    assert.equal(strictStart.kind, 'error'); assert.match(strictStart.text, /no explicit reasoning effort/);
    selected.reasoningEffort = 'max';
    const requestHeader = f.agent.session.requestHeader;
    f.agent.session.requestHeader = () => ({ config: { reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } });
    assert.equal((await f.get()).defaultSettings.reasoningEffort, null);
    f.agent.session.requestHeader = requestHeader;
    f.ctx.sessionProjections.register({ key: 'modelSelection', stateVersion: 2, stateSchema: (await import('zod')).z.json(), init: () => ({ pending: { provider: 'fixture', model: 'fake', reasoningEffort: 'low' } }), apply: state => state });
    assert.equal((await f.get()).capabilities.fixedEffort, 'low');
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('invalid configured token cap and budget-management mode fail before activation', () => {
  for (const maxTokens of [null, 0, 100001, 20000.5, '100000']) assert.throws(() => Gene.apply({}, { maxTokens }), /1024/);
  assert.throws(() => Gene.apply({}, { manageRequestBudget: 'true' }), /must be boolean/);
});

test('three improving verification attempts complete and restore without a plugin request limit', async () => {
  const f = await fixture(['{"answer":"not executable"}', broken, fixed], null, 'max', {});
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', genes: { ...presetGenes(), skepticism: 100, focus: 100 }, expectedRevision: 0 });
    await f.agent.whenIdle();
    assert.equal(f.calls.length, 3, JSON.stringify(f.errors));
    const run = (await f.get()).run;
    assert.equal(run.phase, 'complete'); assert.equal(run.maxCalls, null); assert.equal(run.maxTokens, null);
    assert.equal(run.budget.remainingCalls, null); assert.equal(run.budget.knownTotalTokens, 90);
    assert.deepEqual(run.evidence.entries.map(e => e.status), ['unknown', 'failed', 'passed']);
    assert.ok(f.calls.every(c => c.maxTokens === 32000 && c.reasoningEffort === 'max'));
    assert.ok(f.calls.every(c => !/of at most 2|final request/.test(JSON.stringify(c.messages))));
    await f.reload(); assert.equal((await f.get()).run.budget.callsUsed, 3);
  } finally { await f.close(); }
});

test('changing candidate text without improving checks cannot evade no-progress stopping', async () => {
  const f = await fixture([broken, broken + '\n// changed text', broken + '\n// changed again'], 32000, 'high', {});
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', genes: { ...presetGenes(), skepticism: 100, focus: 100 }, expectedRevision: 0 });
    await f.agent.whenIdle();
    const run = (await f.get()).run;
    assert.equal(f.calls.length, 2); assert.equal(run.unchanged, 0);
    assert.equal(run.progress.stalled, 1); assert.equal(run.phase, 'blocked');
  } finally { await f.close(); }
});

test('unhandled rate limits do not become a plugin-owned busy retry loop', async () => {
  const limited = async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP_ERROR', status: 429, message: 'local fixture' } } }; };
  const f = await fixture([limited], null, 'high', {});
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0 }); await f.agent.whenIdle();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 1); assert.equal((await f.get()).run.phase, 'blocked');
  } finally { await f.close(); }
});

test('official outer native retry may decide after Gene delegation without premature blocking', async () => {
  const limited = async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP_ERROR', status: 429, message: 'local fixture' } } }; };
  const f = await fixture([limited, limited, fixed], null, 'high', {}, { native: true });
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0 }); await f.agent.whenIdle();
    const run = (await f.get()).run;
    assert.equal(f.calls.length, 3, JSON.stringify(f.errors)); assert.equal(run.phase, 'complete');
    assert.equal(run.budget.callsUsed, 3); assert.equal(run.budget.missingUsageCalls, 2);
  } finally { await f.close(); }
});

test('repeated truncation without verifier progress cannot schedule endless followups', async () => {
  let count = 0;
  const truncated = async function* () {
    const text = '```js\nfunction solve(input) { // ' + (++count);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  };
  const f = await fixture([truncated], null, 'high', {});
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', genes: { ...presetGenes(), focus: 100 }, expectedRevision: 0 }); await f.agent.whenIdle();
    await new Promise(resolve => setImmediate(resolve)); await f.agent.whenIdle();
    assert.equal(f.calls.length, 2); assert.equal((await f.get()).run.phase, 'blocked');
    assert.match((await f.get()).run.lastError, /host output limit/);
  } finally { await f.close(); }
});

for (const originalCap of [32000, null]) test(`new v4 run removes inherited v3 override back to ${originalCap ?? 'host default'}`, async () => {
  const f = await fixture([fixed], originalCap, 'max', { manageRequestBudget: true });
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0, submit: false });
    appendPluginRecord(f.agent.session, 'plugin:gene-editing/state', { ...legacy((await f.get()).run, 3, 100000), manageRequestBudget: true, requestBudgetOverride: null }); await f.reload();
    f.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Old bounded run.' }] })); await f.agent.whenIdle();
    assert.equal(f.calls[0].maxTokens, 100000);
    const before = structuredClone(f.ctx.sessionProjections.stateOf(f.agent.session, 'geneEditing').run);
    assert.equal((await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 1 })).kind, 'success'); await f.agent.whenIdle();
    assert.equal(f.calls[1].maxTokens, 32000); assert.equal(f.calls[1].reasoningEffort, 'max');
    const run = (await f.get()).run; assert.equal(run.version, 4); assert.equal(run.budget.calls[0].maxTokens, 32000);
    assert.equal(before.version, 3); assert.equal(before.budget.callsUsed, 1);
    await f.reload();
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 2 }); await f.agent.whenIdle();
    assert.equal(f.calls[2].maxTokens, 32000); assert.equal((await f.get()).run.legacyCapRestore, null);
  } finally { await f.close(); }
});

test('apply changes only preferences and never submits a task or calls a model', async () => {
  const f = await fixture([plainAnswer('普通回答')], null, 'max', {});
  try {
    let selections = 0;
    f.agent.model = { current: () => ({ provider: 'fixture', model: 'fake', reasoningEffort: 'max' }), select: () => { selections++; } };
    const genes = { ...presetGenes(), depth: 100, exploration: 100 };
    const applied = await f.command({ op: 'apply', genes, expectedRevision: 0, submit: true });
    assert.equal(applied.kind, 'success', applied.text);
    await f.agent.whenIdle();
    assert.equal(f.calls.length, 0); assert.equal(f.agent.status, 'idle'); assert.equal(selections, 0);
    const run = (await f.get()).run;
    assert.equal(run.version, 4); assert.equal(run.mode, 'preferences'); assert.equal(run.taskId, null);
    assert.equal(run.phase, 'ready'); assert.equal(run.enabled, true);
    assert.equal(run.maxTokens, null); assert.equal(run.maxCalls, null);
    assert.equal(run.budget.callsUsed, 0); assert.equal(run.evidence.entries.length, 0);
    assert.equal(run.genes.depth, 100);
    assert.equal(run.settings, null); assert.equal(run.effectiveEffort, null);
    assert.equal((await f.get()).defaultSettings.reasoningEffort, 'max'); assert.equal(f.agent.options.reasoningEffort, 'max');
    const invalid = await f.command({ op: 'apply', taskId: 'tuple_dedup', expectedRevision: 1 });
    assert.equal(invalid.kind, 'error'); assert.equal((await f.get()).run.revision, 1);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test('preferences survive three normal turns and reload, follow native effort and cap, and stop removes the directive', async () => {
  const f = await fixture([plainAnswer('这是普通自然语言回答。')], null, 'max', {});
  try {
    const applied = await f.command({ op: 'apply', genes: { ...presetGenes(), depth: 100 }, expectedRevision: 0 });
    assert.equal(applied.kind, 'success', applied.text);
    await ordinaryTurn(f, '介绍一个设计方案。');
    assert.equal(f.calls.length, 1, JSON.stringify(f.errors));
    assert.match(systemText(f.calls[0]), /Behavior preferences:/);
    assert.doesNotMatch(systemText(f.calls[0]), /solve\(input\)|single JavaScript code block|requested pure JavaScript/);
    assert.doesNotMatch(systemText(f.calls[0]), /do not claim that code was executed|No task-specific verifier|Do not emit harness JSON/);
    assert.equal(f.calls[0].maxTokens, 32000); assert.equal(f.calls[0].reasoningEffort, 'max');
    await f.reload();
    assert.equal((await f.get()).run.mode, 'preferences');
    await ordinaryTurn(f, '继续讨论取舍。');
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors));
    // A native model-setting change remains authoritative after activation.
    const disposeSelection = f.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), reasoningEffort: 'low', maxTokens: 256000 }));
    await ordinaryTurn(f, '给我一个简短例子。');
    assert.equal(f.calls.length, 3, JSON.stringify(f.errors));
    assert.equal(f.calls[2].reasoningEffort, 'low'); assert.equal(f.calls[2].maxTokens, 256000);
    assert.equal(f.calls[2].provider, 'fixture'); assert.equal(f.calls[2].model, 'fake');
    assert.ok(f.calls.every(call => /Behavior preferences:/.test(systemText(call))));
    const run = (await f.get()).run;
    assert.equal(run.phase, 'ready'); assert.equal(run.evidence.entries.length, 0); assert.equal(run.budget.callsUsed, 0);
    const stopped = await f.command({ op: 'stop', expectedRevision: 1 });
    assert.equal(stopped.kind, 'success', stopped.text);
    await ordinaryTurn(f, '停止偏好后的普通问题。');
    assert.equal(f.calls.length, 4, JSON.stringify(f.errors));
    assert.doesNotMatch(systemText(f.calls[3]), /Behavior preferences:/);
    assert.equal((await f.get()).run.phase, 'stopped');
    disposeSelection();
  } finally { await f.close(); }
});

test('preferences can be reapplied after conversation but stale revisions cannot replace them', async () => {
  const f = await fixture([plainAnswer('正常回答')], null, 'high', {});
  try {
    assert.equal((await f.command({ op: 'apply', genes: { ...presetGenes(), depth: 0 }, expectedRevision: 0 })).kind, 'success');
    await ordinaryTurn(f, '第一轮');
    const before = systemText(f.calls[0]);
    const stale = await f.command({ op: 'apply', genes: { ...presetGenes(), depth: 100 }, expectedRevision: 0 });
    assert.equal(stale.kind, 'error'); assert.match(stale.text, /Revision conflict/);
    assert.equal((await f.get()).run.genes.depth, 0);
    const applied = await f.command({ op: 'apply', genes: { ...presetGenes(), depth: 100 }, expectedRevision: 1 });
    assert.equal(applied.kind, 'success', applied.text); assert.equal(f.calls.length, 1);
    assert.equal((await f.get()).run.revision, 2);
    await ordinaryTurn(f, '第二轮');
    assert.equal(f.calls.length, 2); assert.notEqual(systemText(f.calls[1]), before);
    assert.equal(f.calls[1].reasoningEffort, 'high');
    assert.equal((await f.command({ op: 'stop', expectedRevision: 1 })).kind, 'error');
    assert.equal((await f.get()).run.enabled, true);
  } finally { await f.close(); }
});

test('preferences permit auxiliary model requests without changing their options or accounting', async () => {
  const f = await fixture([plainAnswer('标题')], 20000, 'high', {});
  try {
    assert.equal((await f.command({ op: 'apply', expectedRevision: 0 })).kind, 'success');
    const options = { provider: 'fixture', model: 'native-title-model', maxTokens: 64000, reasoningEffort: 'low', messages: [{ role: 'user', content: [{ type: 'text', text: 'title fixture' }] }], sessionId: f.agent.id, purpose: 'session-title', signal: new AbortController().signal };
    const output = []; for await (const chunk of f.ctx.llm.stream(options)) output.push(chunk);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].purpose, 'session-title'); assert.equal(f.calls[0].model, 'native-title-model');
    assert.equal(f.calls[0].maxTokens, 64000); assert.equal(f.calls[0].reasoningEffort, 'low');
    assert.deepEqual(f.calls[0].messages, options.messages);
    assert.ok(output.some(chunk => chunk.type === 'text-delta' && chunk.text === '标题'));
    assert.equal((await f.get()).run.budget.callsUsed, 0);
  } finally { await f.close(); }
});

test('provider-default effort permits apply and reload without inventing or changing native effort', async () => {
  const f = await fixture([plainAnswer('默认模式回答')], null, 'high', {});
  try {
    f.ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fake' }) });
    assert.equal((await f.get()).defaultSettings.reasoningEffort, null);
    const applied = await f.command({ op: 'apply', genes: presetGenes(), expectedRevision: 0 });
    assert.equal(applied.kind, 'success', applied.text);
    assert.equal(f.calls.length, 0);
    assert.equal((await f.get()).run.settings, null);
    assert.equal((await f.get()).run.effectiveEffort, null);
    // A previously resolved provider default must not masquerade as an explicit
    // user effort choice when the native request header is replayed.
    const originalHeader = f.agent.session.requestHeader;
    f.agent.session.requestHeader = () => ({ config: { reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } });
    await f.reload();
    assert.equal((await f.get()).defaultSettings.reasoningEffort, null);
    assert.equal((await f.get()).run.settings, null);
    const options = { provider: 'fixture', model: 'fake', maxTokens: 12345, messages: [{ role: 'user', content: [{ type: 'text', text: 'native default fixture' }] }], sessionId: f.agent.id, signal: new AbortController().signal };
    for await (const _ of f.ctx.llm.stream(options)) {}
    assert.equal(f.calls.length, 1);
    // The native Llm service resolves this fixture provider's declared default
    // to high. Gene leaves the caller's omitted choice and its own metadata null.
    assert.equal(options.reasoningEffort, undefined); assert.equal(f.calls[0].reasoningEffort, 'high'); assert.equal(f.calls[0].maxTokens, 12345);
    assert.equal((await f.get()).run.phase, 'ready'); assert.equal((await f.get()).run.budget.callsUsed, 0);
    f.agent.session.requestHeader = originalHeader;
  } finally { await f.close(); }
});

test('preferences preserve native tool dispatch and do not invoke the verification loop', async () => {
  let executions = 0;
  const toolRequest = async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' };
    yield { type: 'tool-call-delta', index: 0, id: 'preference-echo-1', name: 'local_echo', argumentsDelta: '{"text":"ping"}' };
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'preference-echo-1', name: 'local_echo', arguments: '{"text":"ping"}' } };
    yield { type: 'finish', reason: { kind: 'tool-calls' } };
  };
  const f = await fixture([toolRequest, plainAnswer('工具已返回 ping。')], null, 'high', {});
  try {
    f.ctx.tools.register({ name: 'local_echo', description: 'Local fixture echo.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      async execute(args) { executions++; return { text: `echo:${args.text}` }; } });
    assert.equal((await f.command({ op: 'apply', expectedRevision: 0 })).kind, 'success');
    await ordinaryTurn(f, '请使用本地 echo 工具。');
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors)); assert.equal(executions, 1);
    assert.ok(f.calls[0].tools.some(tool => tool.name === 'local_echo'));
    const result = f.calls[1].messages.find(message => message.role === 'tool' && message.toolCallId === 'preference-echo-1');
    assert.ok(result); assert.match(JSON.stringify(result.content), /echo:ping/);
    assert.equal((await f.get()).run.evidence.entries.length, 0); assert.equal((await f.get()).run.phase, 'ready');
  } finally { await f.close(); }
});

test('ordinary truncation and provider errors do not start Gene repairs or block later conversation', async () => {
  const failure = async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'HTTP_ERROR', status: 402, message: 'local fixture' } } }; };
  const f = await fixture([plainAnswer('未完的普通文本', { kind: 'max-tokens' }), failure, plainAnswer('后续普通回答')], null, 'high', {});
  try {
    assert.equal((await f.command({ op: 'apply', expectedRevision: 0 })).kind, 'success');
    for (let i = 1; i <= 3; i++) {
      await ordinaryTurn(f, `普通问题 ${i}`); await new Promise(resolve => setImmediate(resolve)); await f.agent.whenIdle();
      assert.equal(f.calls.length, i, JSON.stringify(f.errors)); assert.equal((await f.get()).run.phase, 'ready');
    }
    assert.equal((await f.get()).run.evidence.entries.length, 0); assert.equal((await f.get()).run.budget.callsUsed, 0);
  } finally { await f.close(); }
});

for (const originalCap of [32000, null]) test(`applying preferences restores a legacy v3 override to ${originalCap ?? 'host default'} without submitting`, async () => {
  const f = await fixture([fixed, plainAnswer('普通回答')], originalCap, 'max', { manageRequestBudget: true });
  try {
    await f.command({ op: 'start', taskId: 'tuple_dedup', expectedRevision: 0, submit: false });
    appendPluginRecord(f.agent.session, 'plugin:gene-editing/state', { ...legacy((await f.get()).run, 3, 100000), manageRequestBudget: true, requestBudgetOverride: null }); await f.reload();
    await ordinaryTurn(f, 'Old bounded fixture.'); assert.equal(f.calls[0].maxTokens, 100000);
    const applied = await f.command({ op: 'apply', expectedRevision: 1 });
    assert.equal(applied.kind, 'success', applied.text); assert.equal(f.calls.length, 1);
    await f.reload(); await ordinaryTurn(f, '继续正常对话。');
    assert.equal(f.calls.length, 2, JSON.stringify(f.errors)); assert.equal(f.calls[1].maxTokens, 32000); assert.equal(f.calls[1].reasoningEffort, 'max');
    assert.equal((await f.get()).run.mode, 'preferences'); assert.equal((await f.get()).run.budget.callsUsed, 0);
    assert.doesNotMatch(systemText(f.calls[1]), /requested pure JavaScript|single JavaScript code block/);
  } finally { await f.close(); }
});
