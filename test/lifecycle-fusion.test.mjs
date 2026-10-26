import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Sessions, { buildForkSeed } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import Agents from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import Prompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import Commands from '@deepseek-ai/dsh-commands';
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import * as Gene from '../src/index.mjs';
import { presetGenes } from '../lib/shared/public/core.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const options = { provider: 'lifecycle-fixture', model: 'local-model', reasoningEffort: 'high', maxTokens: 24000 };
const validAnswer = '```js\nfunction solve(input) { const seen=new Set(); return input.filter(pair=>{const key=JSON.stringify(pair); if(seen.has(key))return false; seen.add(key); return true;}); }\n```';
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
async function* response(text = validAnswer, usage = 30) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'usage', usage: { inputTokens: 10, outputTokens: usage - 10, totalTokens: usage } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

async function fixture(stream = () => response()) {
  const root = await mkdtemp(join(testDirectory, '.lifecycle-fixture-'));
  const ctx = new Context(), fibers = [], handles = new Set(), calls = [], errors = [];
  ctx.on('agent/error', ({ error }) => { errors.push(error.message); });
  for (const plugin of [Sessions, Projections, Agents, Llm, Prompt, Tools, Commands]) fibers.push(await ctx.plugin(plugin));
  fibers.push(await ctx.plugin(JsonlPersistence, { root, compression: 'none' }));
  fibers.push(await ctx.plugin(AgentLoop, { agents: [] }));
  class LocalAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 200000 }, defaultMaxTokens: 24000,
        reasoning: { defaultEffort: 'high', efforts: ['low', 'high', 'max'].map(id => ({ id, name: id })) } };
    }
    async *stream(request) { calls.push(request); yield* stream(request); }
  }
  ctx.llm.registerAdapter(['lifecycle-fixture'], new LocalAdapter());
  let gene = await ctx.plugin(Gene, { exposeVerifierTool: true });
  const own = handle => { handles.add(handle); return handle; };
  const command = async (agent, input) => (await ctx.commands.execute(agent, '/gene ' + JSON.stringify(input), [], new AbortController().signal))?.result;
  const get = async agent => {
    const result = await command(agent, { op: 'get' });
    assert.equal(result?.kind, 'success', result?.text);
    return JSON.parse(result.text);
  };
  return {
    ctx, calls, errors, command, get,
    create: async id => own(await ctx.agents.create({ sessionId: id, agentOptions: options })),
    fork: async (parent, id) => {
      const events = parent.session.snapshotEvents();
      return own(await ctx.agents.create({ sessionId: id, agentOptions: options,
        meta: { isSeeded: true, parentSession: parent.id }, inheritedEventCount: events.length,
        seed: buildForkSeed(events, events.at(-1).seq) }));
    },
    async resume(handle) {
      const id = handle.agent.id;
      await handle.dispose(); handles.delete(handle);
      return own(await ctx.agents.resume({ resumeSessionId: id, agentOptions: options }));
    },
    async reload() { await gene.dispose(); gene = await ctx.plugin(Gene, { exposeVerifierTool: true }); },
    async close() {
      try {
        for (const handle of handles) await handle.dispose();
        await gene.dispose();
        for (const fiber of fibers.reverse()) await fiber.dispose();
        await ctx.fiber.dispose();
      } finally {
        const resolved = resolve(root);
        assert.ok(resolved.startsWith(resolve(testDirectory) + sep) && resolved.includes('.lifecycle-fixture-'));
        await rm(resolved, { recursive: true, force: true });
      }
    },
  };
}
async function turn(agent, text = 'Respond to this local fixture.') {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }));
  await agent.whenIdle();
}
const state = (f, agent) => f.ctx.sessionProjections.stateOf(agent.session, 'geneEditing');
const streamOptions = agent => ({ ...options, sessionId: agent.id, messages: [], signal: new AbortController().signal });

test('forked preferences own fresh identities and ledgers, exclude parent artifacts, and resume their own revision', { timeout: 30000 }, async () => {
  const f = await fixture(() => response('A parent answer without a verification task.'));
  try {
    const parent = (await f.create('prefs-parent')).agent;
    const genes = { ...presetGenes(), depth: 91, skepticism: 78 };
    assert.equal((await f.command(parent, { op: 'apply', genes, expectedRevision: 0 })).kind, 'success');
    await turn(parent);
    const before = (await f.get(parent)).run;
    assert.notEqual(state(f, parent).artifact, '');
    let childHandle = await f.fork(parent, 'prefs-child');
    let child = childHandle.agent;
    const inherited = (await f.get(child)).run;
    assert.equal(inherited.mode, 'preferences'); assert.equal(inherited.enabled, true);
    assert.notEqual(inherited.runId, before.runId); assert.equal(inherited.sessionId, child.id);
    assert.deepEqual(inherited.genes, before.genes);
    assert.equal(inherited.revision, 1); assert.equal(inherited.budget.callsUsed, 0);
    assert.equal(inherited.lastHash, null); assert.equal(inherited.progress, null);
    assert.equal(inherited.legacyCapRestore, null); assert.deepEqual(inherited.evidence.entries, []);
    assert.equal(state(f, child).artifact, ''); assert.equal(state(f, child).artifactSeq, -1);
    assert.equal(state(f, child).runInherited, false, 'derived child record must be committed outside the inherited prefix');
    await f.reload();
    assert.deepEqual((await f.get(child)).run, inherited, 'reload must not mint another fork identity');
    assert.equal((await f.command(child, { op: 'stop', expectedRevision: 1 })).kind, 'success');
    const stopped = (await f.get(child)).run;
    assert.equal(stopped.revision, 2); assert.equal(stopped.enabled, false);
    assert.deepEqual((await f.get(parent)).run, before, 'child writes must leave parent state untouched');
    childHandle = await f.resume(childHandle); child = childHandle.agent;
    assert.deepEqual((await f.get(child)).run, stopped, 'real JSONL resume keeps the child identity, stop state, and revision');
    const grandchild = (await f.fork(child, 'prefs-grandchild')).agent;
    const next = (await f.get(grandchild)).run;
    assert.notEqual(next.runId, stopped.runId); assert.equal(next.enabled, false);
    assert.equal(next.phase, 'stopped'); assert.equal(next.revision, 1);
    assert.equal(f.calls.length, 1, 'fork, reload and resume cannot submit model work');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('forking a completed verified run does not inherit its task, evidence, cap ownership or artifact; resume keeps its own state', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    let parentHandle = await f.create('verified-parent');
    let parent = parentHandle.agent;
    assert.equal((await f.command(parent, { op: 'start', taskId: 'tuple_dedup', expectedRevision: 0 })).kind, 'success');
    await parent.whenIdle();
    const before = (await f.get(parent)).run;
    assert.equal(before.phase, 'complete', JSON.stringify(f.errors));
    assert.equal(before.budget.callsUsed, 1); assert.ok(before.evidence.entries.length > 0);
    const child = (await f.fork(parent, 'verified-child')).agent;
    assert.equal((await f.get(child)).run, null);
    assert.equal(state(f, child).artifact, ''); assert.equal(state(f, child).artifactSeq, -1);
    await turn(child, 'A normal follow-up in the fork.');
    assert.equal((await f.get(child)).run, null);
    assert.ok(state(f, child).artifactSeq >= child.session.inheritedEventCount);
    assert.equal(f.calls.length, 2, 'fork should run only the explicitly submitted child request');
    assert.doesNotMatch(JSON.stringify(f.calls[1].messages.filter(message => message.role === 'system')), /Public execution feedback|requested pure JavaScript|Behavior preferences:/);
    parentHandle = await f.resume(parentHandle); parent = parentHandle.agent;
    assert.deepEqual((await f.get(parent)).run, before, 'own verified evidence and ledger survive JSONL resume');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('verified compaction is transparent while an answer is pending and does not spend or settle its Gene attempt', { timeout: 30000 }, async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(async function* (request) {
    if (request.purpose === 'compaction') { yield* response('Native compact summary.', 99); return; }
    entered.resolve(); await release.promise; yield* response('Pending answer completed.', 30);
  });
  let primary;
  try {
    const agent = (await f.create('compact-pending')).agent;
    assert.equal((await f.command(agent, { op: 'start', taskId: 'tuple_dedup', expectedRevision: 0, submit: false })).kind, 'success');
    primary = collect(f.ctx.llm.stream(streamOptions(agent)));
    await entered.promise;
    const before = (await f.get(agent)).run;
    assert.equal(before.budget.callsUsed, 1); assert.equal(before.budget.pendingCalls, 1);
    const compact = { ...streamOptions(agent), purpose: 'compaction', model: 'native-compact-model', reasoningEffort: 'low', maxTokens: 777,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Keep this exact compaction input.' }] }] };
    const chunks = await collect(f.ctx.llm.stream(compact));
    assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Native compact summary.'));
    assert.equal(f.calls[1].purpose, 'compaction'); assert.equal(f.calls[1].model, compact.model);
    assert.equal(f.calls[1].maxTokens, 777); assert.equal(f.calls[1].reasoningEffort, 'low');
    assert.deepEqual(f.calls[1].messages, compact.messages); assert.equal(f.calls[1].signal, compact.signal);
    assert.deepEqual((await f.get(agent)).run, before);
    await assert.rejects(collect(f.ctx.llm.stream({ ...streamOptions(agent), purpose: 'session-title' })), /Auxiliary model calls are disabled/);
    assert.equal(f.calls.length, 2, 'other auxiliary calls retain the existing refusal');
    release.resolve(); await primary; primary = undefined;
    const after = (await f.get(agent)).run;
    assert.equal(after.budget.callsUsed, 1); assert.equal(after.budget.pendingCalls, 0);
    assert.equal(after.budget.knownTotalTokens, 30, 'the 99 compaction tokens belong to native accounting');
  } finally { release.resolve(); await primary; await f.close(); }
});

test('native compaction after verified completion preserves completed evidence and accounting', { timeout: 30000 }, async () => {
  const f = await fixture(request => response(request.purpose === 'compaction' ? 'Completed-run summary.' : validAnswer));
  try {
    const agent = (await f.create('compact-completed')).agent;
    assert.equal((await f.command(agent, { op: 'start', taskId: 'tuple_dedup', expectedRevision: 0 })).kind, 'success');
    await agent.whenIdle();
    const before = (await f.get(agent)).run;
    assert.equal(before.phase, 'complete');
    await collect(f.ctx.llm.stream({ ...streamOptions(agent), purpose: 'compaction', reasoningEffort: 'low', maxTokens: 999 }));
    assert.deepEqual((await f.get(agent)).run, before);
    await assert.rejects(collect(f.ctx.llm.stream({ ...streamOptions(agent), purpose: 'session-title' })), /Auxiliary model calls are disabled/);
    assert.equal(f.calls.length, 2); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
