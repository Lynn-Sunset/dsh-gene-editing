import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { ToolArgsError } from '@deepseek-ai/dsh-tools';
import { compilePolicy, makeV4Directive, validateV4TokenBudget } from '../shared/src/v4/policy.mjs';
import { BudgetLedger } from '../shared/src/v4/budget.mjs';
import { RequestLedger } from './request-ledger.mjs';
import { installToolIntegration } from './tool-integration.mjs';
import { EvidenceLedger, artifactHash } from '../shared/src/v4/evidence.mjs';
import { verifyCandidate, listVerificationTasks, getVerificationTask } from '../shared/src/v4/verifiers/index.mjs';
import { presetGenes } from '../shared/public/core.js';
import { validateReasoningEffort } from '../shared/public/settings.js';

export const name = 'gene-editing';
export const inject = ['commands', 'agents', 'llm', 'systemPrompt', 'sessionProjections', 'tools'];
const RECORD = 'plugin:gene-editing/state';
const KEY = 'geneEditing';
const clone = value => JSON.parse(JSON.stringify(value));
const preferencesOnly = run => run?.version === 4 && run.mode === 'preferences';
const idle = agent => { if (agent.status !== 'idle') throw new Error('Wait for the active turn to finish before changing Genes.'); };
const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'gene-editing', form: 'notice', summary: 'Gene Editing execution feedback' } });

// A pure fold: the official registry owns replay, lazy catch-up and lifecycle.
// No deprecated synchronous session-event reads are used.
export const projection = {
  key: KEY, stateVersion: 2,
  stateSchema: z.object({ run: z.json().nullable(), runInherited: z.boolean(), inheritedEventCount: z.number().int().nonnegative(), artifact: z.string(), artifactSeq: z.number() }),
  init: (_header, inheritedEventCount) => ({ run: null, runInherited: false, inheritedEventCount, artifact: '', artifactSeq: -1 }),
  apply(state, event) {
    const record = pluginRecordOf(event);
    if (record?.type === RECORD) return { ...state, run: record.data, runInherited: event.seq < state.inheritedEventCount };
    if (event.type !== 'assistant/message' || event.seq < state.inheritedEventCount) return state;
    const artifact = event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return { ...state, artifact: artifact.slice(0, 131073), artifactSeq: event.seq };
  },
};

function restore(saved) {
  const followsHost = saved.version === 4;
  const preferences = preferencesOnly(saved) && saved.taskId === null;
  const validMode = saved.mode === undefined || saved.mode === 'verified' || preferences;
  if (![1, 2, 3, 4].includes(saved.version) || typeof saved.runId !== 'string' || saved.maxCalls !== (followsHost ? null : 2) || !validMode || (!preferences && !getVerificationTask(saved.taskId))) throw new Error('Incompatible Gene run state; start a new session.');
  if (saved.version === 3 && saved.maxTokens === undefined) throw new Error('Missing persisted Gene token cap. Start a new session.');
  if (followsHost && (saved.maxTokens !== null || saved.budget?.maxCalls !== null || saved.budget?.remainingCalls !== null)) throw new Error('Invalid persisted host-managed budget.');
  const maxTokens = followsHost ? null : saved.version < 3 ? 20000 : validateV4TokenBudget(saved.maxTokens);
  if (saved.budget?.maxTokens !== maxTokens) throw new Error('Persisted Gene token cap does not match its budget.');
  if (saved.version === 3 && saved.requestBudgetOverride != null
    && saved.requestBudgetOverride.originalMaxTokens !== null
    && (!Number.isSafeInteger(saved.requestBudgetOverride.originalMaxTokens) || saved.requestBudgetOverride.originalMaxTokens <= 0)) throw new Error('Invalid persisted original request cap.');
  const historicalReadOnly = saved.version === 1;
  if (!historicalReadOnly && !preferences && typeof saved.settings?.reasoningEffort !== 'string') throw new Error('Missing independent effort in persisted Gene run. Start a new session.');
  const settings = historicalReadOnly || preferences ? null : { reasoningEffort: validateReasoningEffort(saved.settings?.reasoningEffort) };
  if (followsHost && saved.legacyCapRestore != null && (!Number.isSafeInteger(saved.legacyCapRestore.ownedMaxTokens) || saved.legacyCapRestore.ownedMaxTokens <= 0 || (saved.legacyCapRestore.originalMaxTokens !== null && (!Number.isSafeInteger(saved.legacyCapRestore.originalMaxTokens) || saved.legacyCapRestore.originalMaxTokens <= 0)))) throw new Error('Invalid persisted legacy cap restoration.');
  const policy = historicalReadOnly ? null : compilePolicy(saved.genes, { revision: saved.revision, ...settings, budget: followsHost ? { mode: 'host' } : { maxTokens } });
  const budget = followsHost ? new RequestLedger() : new BudgetLedger({ maxRounds: 2, maxTokens });
  if (!Array.isArray(saved.budget?.calls) || (!followsHost && saved.budget.calls.length > 2)) throw new Error('Invalid persisted budget.');
  for (const old of saved.budget.calls) {
    if (!followsHost && old.maxTokens !== maxTokens) throw new Error('Persisted Gene attempt has a different token cap.');
    const id = followsHost ? budget.reserve(old.kind, old.maxTokens) : budget.reserve(old.kind);
    // An interrupted pending call still consumed a request; usage stays unknown.
    budget.settle(id, old.usage);
  }
  const evidence = EvidenceLedger.restore(saved.evidence?.entries ?? []);
  return { ...saved, maxTokens, settings, historicalReadOnly, historicalSnapshot: historicalReadOnly ? clone(saved) : null, policy, budget, evidence, prepared: null, pending: 0 };
}

export function apply(ctx, config = {}) {
  // Legacy settings are accepted for upgrade compatibility, but never limit a
  // newly created v4 run. Historical records carry their own original budget.
  if (config.maxTokens !== undefined) validateV4TokenBudget(config.maxTokens);
  if (config.manageRequestBudget !== undefined && typeof config.manageRequestBudget !== 'boolean') throw new Error('manageRequestBudget must be boolean.');
  const runs = new Map(), controllers = new Set(), work = new Set();
  let closing = false;
  ctx.sessionProjections.register(projection);
  const fold = agent => ctx.sessionProjections.stateOf(agent.session, KEY);
  function runOf(agent) {
    if (!runs.has(agent.id)) {
      const state = fold(agent), saved = state?.run;
      if (saved && state.runInherited) {
        // A fork carries behavior preferences, never the parent's task, usage,
        // evidence, request-cap ownership, or completion state.
        if (!preferencesOnly(saved) || saved.taskId !== null) return undefined;
        const policy = compilePolicy(saved.genes, { revision: 1, reasoningEffort: hostEffort(agent, false) ?? 'high', budget: { mode: 'host' } });
        const run = { version: 4, mode: 'preferences', runId: randomUUID(), sessionId: agent.id, taskId: null,
          genes: policy.genes, revision: policy.revision, maxTokens: null, maxCalls: null, enabled: saved.enabled === true,
          phase: saved.enabled === true ? 'ready' : 'stopped', lastHash: null, checkedSeq: state.artifactSeq,
          requiredCheckIds: [], unchanged: 0, capabilities: { mutableEffort: mutableEffort(agent) }, settings: null, effectiveEffort: null,
          historicalReadOnly: false, historicalSnapshot: null, legacyCapRestore: null, progress: null, lastError: null,
          policy, budget: new RequestLedger(), evidence: new EvidenceLedger(), prepared: null, pending: 0 };
        runs.set(agent.id, run);
        persist(agent, run);
      } else if (saved) {
        if (saved.sessionId !== agent.id) throw new Error('Persisted Gene run belongs to another session.');
        runs.set(agent.id, restore(saved));
      }
    }
    return runs.get(agent.id);
  }
  function serialize(run) {
    if (run.historicalReadOnly) return clone({ ...run.historicalSnapshot, settings: null, historicalReadOnly: true });
    return clone({ version: run.version, runId: run.runId, sessionId: run.sessionId, taskId: run.taskId, genes: run.genes,
      revision: run.revision, maxTokens: run.maxTokens, maxCalls: run.version === 4 ? null : 2, enabled: run.enabled, phase: run.phase, lastHash: run.lastHash,
      checkedSeq: run.checkedSeq, requiredCheckIds: run.requiredCheckIds, unchanged: run.unchanged,
      capabilities: run.capabilities, settings: run.settings, effectiveEffort: run.effectiveEffort, historicalReadOnly: run.historicalReadOnly || false,
      ...(run.version === 3 ? { manageRequestBudget: run.manageRequestBudget, requestBudgetOverride: run.requestBudgetOverride } : {}),
      ...(run.version === 4 ? { mode: run.mode || 'verified', legacyCapRestore: run.legacyCapRestore, progress: run.progress } : {}),
      budget: run.budget.snapshot(), evidence: run.evidence.snapshot(), currentEvidence: run.lastHash ? run.evidence.snapshot(run.lastHash) : { entries: [], checks: [], unresolvedCount: 0 }, lastError: run.lastError || null });
  }
  function persist(agent, run) { appendPluginRecord(agent.session, RECORD, serialize(run)); }
  function hostEffort(agent, strict = true) {
    const header = agent.session.requestHeader();
    const pending = ctx.sessionProjections.stateOf(agent.session, 'modelSelection')?.pending;
    const nativeSelection = pending ?? (header ? null : ctx.get('agentDefaultModel')?.currentSelection());
    if ((nativeSelection && nativeSelection.reasoningEffort === undefined) || (!pending && header?.adapterDefaults?.reasoningEffort === true)) {
      if (!strict) return null;
      throw new Error('The native model selection has no explicit reasoning effort. Choose low, high or max in the Harness model picker before starting Gene control.');
    }
    const effort = agent.model?.current?.()?.reasoningEffort ?? nativeSelection?.reasoningEffort ?? header?.config?.reasoningEffort ?? agent.options.reasoningEffort;
    if (!strict && effort === undefined) return null;
    return validateReasoningEffort(effort ?? config.fixedEffort ?? 'high');
  }
  const mutableEffort = agent => Boolean(agent.model?.select && agent.model?.current);
  const toolIntegration = installToolIntegration(ctx, { runOf });
  function view(agent) {
    const run = runOf(agent);
    const effort = hostEffort(agent, Boolean(run && !preferencesOnly(run)));
    return { available: true, sessionId: agent.id, status: agent.status, tasks: listVerificationTasks(),
      defaults: presetGenes(), defaultSettings: { reasoningEffort: effort, maxTokens: null }, capabilities: { mutableEffort: mutableEffort(agent), fixedEffort: mutableEffort(agent) ? null : effort },
      run: run ? serialize(run) : null, toolIntegration: toolIntegration.getToolState(agent) };
  }
  function choosePolicy(agent, genes, revision, reasoningEffort) {
    const policy = compilePolicy(genes, { revision, reasoningEffort: validateReasoningEffort(reasoningEffort), budget: { mode: 'host' } });
    if (mutableEffort(agent)) {
      agent.model.select({ ...agent.model.current(), reasoningEffort: policy.effort });
      return policy;
    }
    // Published rc.3 lacks the source snapshot's Model API. Never fake a change.
    const fixed = hostEffort(agent);
    if (fixed !== policy.effort) throw new Error(`Harness model settings currently select ${fixed} effort, but this run requested ${policy.effort}. Change effort in the native Harness model picker, then start a new Gene run. Genes never change effort.`);
    return policy;
  }
  ctx.commands.register({ name: 'gene', description: 'Session Gene controls and verified runs', recordInput: false,
    input: { hint: '{"op":"get"}' },
    async handler({ agent, rawInput, signal }) {
      try {
        signal.throwIfAborted();
        if (closing) throw new Error('Gene Editing is unloading.');
        if (rawInput.length > 12000) throw new Error('Command too large.');
        const input = JSON.parse(rawInput.trim() || '{"op":"get"}');
        if (input.op === 'get') return { kind: 'success', text: JSON.stringify(view(agent)) };
        idle(agent);
        const old = runOf(agent);
        if (input.expectedRevision !== (old?.revision || 0)) throw new Error('Revision conflict. Refresh the panel and retry.');
        if (old?.historicalReadOnly && !['start', 'apply'].includes(input.op)) throw new Error('Historical v1 run is read-only: DEP used to control effort. Start a new explicit run or apply preferences for independent effort and semantic DEP.');
        if (input.op === 'start' || input.op === 'apply') {
          const preferences = input.op === 'apply';
          if (preferences && input.taskId !== undefined && input.taskId !== null) throw new Error('Applying conversation preferences cannot select a verification task.');
          const task = preferences ? null : getVerificationTask(input.taskId);
          if (!preferences && !task) throw new Error('Choose a supported verification task.');
          if (preferences && input.settings?.reasoningEffort != null) validateReasoningEffort(input.settings.reasoningEffort);
          const policy = preferences
            ? compilePolicy(input.genes || presetGenes(), { revision: (old?.revision || 0) + 1, reasoningEffort: hostEffort(agent, false) ?? 'high', budget: { mode: 'host' } })
            : choosePolicy(agent, input.genes || presetGenes(), (old?.revision || 0) + 1, input.settings?.reasoningEffort === undefined ? hostEffort(agent) : input.settings.reasoningEffort);
          const legacyCapRestore = old?.version === 3 && old.requestBudgetOverride ? { ...old.requestBudgetOverride, ownedMaxTokens: old.maxTokens } : old?.legacyCapRestore ?? null;
          const run = { version: 4, mode: preferences ? 'preferences' : 'verified', maxTokens: null, runId: randomUUID(), sessionId: agent.id, taskId: task?.id ?? null, genes: policy.genes, revision: policy.revision, settings: preferences ? null : { reasoningEffort: policy.effort },
            legacyCapRestore: clone(legacyCapRestore), progress: null,
            policy, maxCalls: null, enabled: true, phase: 'ready', lastHash: null, checkedSeq: fold(agent)?.artifactSeq ?? -1,
            requiredCheckIds: [], unchanged: 0, capabilities: { mutableEffort: mutableEffort(agent) }, effectiveEffort: preferences ? null : policy.effort,
            budget: new RequestLedger(), evidence: new EvidenceLedger(), prepared: null, pending: 0 };
          runs.set(agent.id, run); persist(agent, run);
          // Reuse the native agent loop. There is no plugin-owned model loop.
          if (!preferences && input.submit !== false) agent.followup(message(task.prompt));
        } else if (input.op === 'set') {
          if (!old?.enabled || old.budget.snapshot().callsUsed) throw new Error('Genes are frozen after a run starts; start a new matched run to change them.');
          if (preferencesOnly(old)) {
            if (input.settings?.reasoningEffort != null) validateReasoningEffort(input.settings.reasoningEffort);
          } else if (input.settings?.reasoningEffort !== undefined && input.settings.reasoningEffort !== old.settings.reasoningEffort) throw new Error('Changing Genes cannot change effort. Choose effort explicitly when starting a new run.');
          if (input.settings?.maxTokens !== undefined && input.settings.maxTokens !== old.maxTokens) throw new Error('Changing Genes cannot change the run token cap.');
          const policy = compilePolicy(input.genes, { revision: old.revision + 1, ...(preferencesOnly(old) ? { reasoningEffort: hostEffort(agent, false) ?? 'high' } : old.settings), budget: old.version === 4 ? { mode: 'host' } : { maxTokens: old.maxTokens } });
          Object.assign(old, { genes: policy.genes, revision: policy.revision, policy }); persist(agent, old);
        } else if (input.op === 'stop') {
          if (!old) throw new Error('No active run.');
          old.enabled = false; old.phase = 'stopped'; old.revision++; persist(agent, old);
        } else throw new Error('Unknown Gene operation.');
        return { kind: 'success', text: JSON.stringify(view(agent)) };
      } catch (error) { return { kind: 'error', text: String(error.message).slice(0, 2000) }; }
    },
  });
  ctx.systemPrompt.section({ name: 'gene-editing.preferences', order: 900, interpolate: false,
    text({ agent }) {
      if (!agent) return '';
      const run = runOf(agent);
      if (run?.historicalReadOnly) throw new Error('Historical Gene run is read-only. Start a new run before requesting a model response.');
      if (!run?.enabled) return '';
      if (closing) throw new Error('Gene Editing is unloading.');
      run.prepared = run.policy;
      if (preferencesOnly(run)) return `Behavior preferences:\n${Object.entries(run.policy.preferences).map(([key, value]) => `${key}: ${value}`).join('\n')}\nFollow the user's constraints and requested output format. There are no mandatory stages, headings, or minimum numbers of checks.`;
      return makeV4Directive(run.prepared, { round: run.budget.snapshot().callsUsed, maxRounds: run.version === 4 ? null : 2, verificationTask: getVerificationTask(run.taskId) });
    },
  });
  // rc.3's documented request waterfall logs the final call configuration.
  // Only this run's output cap is owned here; route and effort stay native.
  ctx.on('agent/request', async ({ agent, signal }, next) => {
    const resolved = await next();
    signal.throwIfAborted();
    const run = runOf(agent);
    if (run?.version === 4 && run.legacyCapRestore) {
      const previous = run.legacyCapRestore;
      if (agent.session.requestHeader()?.config?.maxTokens !== previous.ownedMaxTokens) {
        run.legacyCapRestore = null; persist(agent, run); return resolved;
      }
      if (resolved.maxTokens === previous.ownedMaxTokens) {
        const { maxTokens: _owned, ...withoutCap } = resolved;
        return previous.originalMaxTokens === null ? withoutCap : { ...withoutCap, maxTokens: previous.originalMaxTokens };
      }
      return resolved;
    }
    if (!run || run.version !== 3 || !run.manageRequestBudget) return resolved;
    if (run.enabled) {
      if (closing) throw new Error('Gene Editing is unloading.');
      if (run.requestBudgetOverride === null) {
        run.requestBudgetOverride = { originalMaxTokens: resolved.maxTokens ?? null };
        persist(agent, run);
      }
      return { ...resolved, maxTokens: run.maxTokens };
    }
    // The loop reuses its logged header. Keep this restoration retryable if
    // admission is cancelled before a replacement header can be committed.
    if (run.requestBudgetOverride && resolved.maxTokens === run.maxTokens) {
      const { maxTokens: _owned, ...withoutCap } = resolved;
      return run.requestBudgetOverride.originalMaxTokens === null ? withoutCap : { ...withoutCap, maxTokens: run.requestBudgetOverride.originalMaxTokens };
    }
    return resolved;
  });
  ctx.on('llm/stream', async function* (options, next) {
    const agent = options.sessionId && ctx.agents.get(options.sessionId);
    const run = agent && runOf(agent);
    if (run?.historicalReadOnly) throw new Error('Historical Gene run is read-only. Start a new run before requesting a model response.');
    if (!run?.enabled || preferencesOnly(run)) { yield* next(); return; }
    // Native compaction owns its request and accounting, even while a verified
    // answer is pending or complete. It does not spend a Gene answer attempt.
    if (options.purpose === 'compaction') { yield* next(); return; }
    if (closing || options.purpose) throw new Error('Auxiliary model calls are disabled for Gene runs.');
    if (run.pending) throw new Error('Concurrent model calls are prohibited for a controlled Gene run.');
    if (run.version !== 4 && options.maxTokens !== run.maxTokens) throw new Error(`Gene run refused: resolved request maxTokens must equal ${run.maxTokens}.`);
    if (options.reasoningEffort !== run.effectiveEffort) throw new Error('Gene run refused: actual model effort does not match the run.');
    if (run.phase === 'complete' || run.phase === 'blocked') throw new Error('This Gene run is finished. Start a new run explicitly.');
    const id = run.budget.reserve(run.budget.snapshot().callsUsed ? 'repair-or-recovery' : 'answer', options.maxTokens ?? null);
    run.pending++; run.phase = 'running'; persist(agent, run);
    let usage;
    // The stream hook cannot replace options; the Agent owns its signal. On
    // plugin unload we cancel the Agent and wait for stream finally to settle.
    let done; const pending = new Promise(resolve => { done = resolve; }); work.add(pending);
    try {
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = { total_tokens: chunk.usage.totalTokens, prompt_tokens: chunk.usage.inputTokens, completion_tokens: chunk.usage.outputTokens,
          prompt_cache_hit_tokens: chunk.usage.cacheReadTokens, completion_tokens_details: { reasoning_tokens: chunk.usage.reasoningTokens } };
        yield chunk;
      }
    } finally { run.budget.settle(id, usage); run.pending--; persist(agent, run); work.delete(pending); done(); }
  });
  async function check(agent, artifact, signal, seq = -1) {
    const run = runOf(agent);
    if (preferencesOnly(run)) throw new Error('No task-specific verifier is bound to conversation preferences.');
    if (!run?.enabled || run.historicalReadOnly || closing) throw new Error('No writable managed run.');
    const hash = artifactHash(artifact);
    if (run.lastHash === hash) run.unchanged++;
    if ((run.prepared || run.policy).stop.reuseIdenticalEvidence && run.lastHash === hash && run.evidence.snapshot(hash).entries.length) {
      run.checkedSeq = seq; persist(agent, run);
      return { status: run.evidence.currentStatus(hash), artifactHash: hash, checks: run.evidence.snapshot(hash).checks, reused: true };
    }
    const controller = new AbortController(); controllers.add(controller);
    const combined = AbortSignal.any([signal, controller.signal]);
    const promise = verifyCandidate({ artifact, taskId: run.taskId, selection: 'diagnostic', policy: run.prepared || run.policy,
      requiredCheckIds: run.requiredCheckIds, signal: combined });
    work.add(promise);
    try {
      const result = await promise;
      combined.throwIfAborted();
      run.evidence.record(result, { revision: run.revision, round: run.budget.snapshot().callsUsed });
      run.requiredCheckIds = [...new Set([...run.requiredCheckIds, ...result.checks.filter(c => c.status === 'failed').map(c => c.id)])];
      run.lastHash = hash; run.checkedSeq = seq; persist(agent, run); return result;
    } finally { controllers.delete(controller); work.delete(promise); }
  }
  if (config.exposeVerifierTool === true) ctx.tools.register({ name: 'gene_verify', description: 'Execute the current Gene task checks on a complete solve(input) candidate.',
    parameters: { type: 'object', properties: { artifact: { type: 'string', maxLength: 131072 } }, required: ['artifact'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'artifact') || typeof args.artifact !== 'string' || args.artifact.length > 131072) throw new ToolArgsError(['Expected only a complete artifact string of at most 131072 characters.']);
      if (!exec.agent) throw new Error('The verifier requires a calling agent.');
      return check(exec.agent, args.artifact, exec.signal);
    },
  });
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const run = runOf(agent);
    if (!run?.enabled || run.historicalReadOnly || preferencesOnly(run) || closing) return;
    const current = fold(agent);
    if (!current || current.artifactSeq <= run.checkedSeq) return;
    const result = await check(agent, current.artifact, signal, current.artifactSeq);
    if (run.version === 4) {
      // Only objective improvement can restart the no-progress allowance.
      // Accumulate best passed IDs: alternating regressions, changed prose and
      // whitespace cannot manufacture progress. The trusted check set is finite.
      const passed = (result.checks || []).filter(c => c.status === 'passed').map(c => c.id);
      const previous = run.progress;
      const best = previous?.passed || [];
      const improves = passed.length > best.length && best.every(id => passed.includes(id));
      run.progress = { passed: improves || !previous ? passed : best, stalled: !previous || improves ? 0 : previous.stalled + 1 };
    }
    const canRepair = ['failed', 'unknown'].includes(result.status)
      && (run.version === 4 ? run.progress.stalled < run.policy.stop.maxUnchangedRepairs : run.budget.snapshot().remainingCalls > 0 && run.unchanged < run.policy.stop.maxUnchangedRepairs);
    run.phase = canRepair ? 'repairing' : result.status === 'passed' ? 'complete' : 'blocked';
    if (run.version === 4 && !canRepair && result.status !== 'passed') run.lastError = result.status === 'error' ? 'Verifier error; automatic repair stopped.' : 'No further verification progress; automatic repair stopped.';
    persist(agent, run);
    if (canRepair) agent.steer(message(result.status === 'failed' ? run.evidence.feedback(result.artifactHash) : `The candidate could not be extracted. Return one complete JavaScript code block defining solve(input), with no JSON wrapper.${run.version === 4 ? '' : ' This is the final request.'}`));
  });
  // Legacy v1-v3 provider failures share their original two-attempt ledger.
  // New v4 runs delegate retry timing and decisions to the native host policy.
  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    const run = runOf(agent);
    if (!run?.enabled || run.historicalReadOnly || preferencesOnly(run)) return next();
    signal.throwIfAborted();
    if (run.version === 4) {
      if (closing) return undefined;
      // Native retry owns Retry-After, backoff and cancellation. Never turn
      // removal of a request count limit into an immediate 429 retry loop.
      const action = await next();
      signal.throwIfAborted();
      return action;
    }
    if (!closing && [408, 429, 500, 502, 503, 504].includes(failure?.status) && run.budget.snapshot().remainingCalls > 0) return { kind: 'retry' };
    run.phase = 'blocked'; run.lastError = 'Model request failed; see the native Harness diagnostic.'; persist(agent, run);
    return undefined;
  });
  ctx.on('agent/disposed', ({ agent }) => { runs.delete(agent.id); });
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end' || !['max-tokens', 'error', 'aborted'].includes(event.data.reason?.kind)) return;
    queueMicrotask(() => {
      const agent = ctx.agents.get(session.id), run = agent && runOf(agent);
      if (!run?.enabled || run.historicalReadOnly || preferencesOnly(run) || closing || run.phase === 'complete') return;
      if (run.version === 4) {
        run.phase = 'blocked'; run.lastError = event.data.reason.kind === 'max-tokens' ? 'The host output limit was reached without a verified answer. Automatic continuation stopped; review host settings before a new run.' : 'The native request ended without a verified answer; see the Harness diagnostic.'; persist(agent, run); return;
      }
      if (event.data.reason.kind !== 'max-tokens') return;
      run.phase = run.budget.snapshot().remainingCalls ? 'recovering' : 'blocked'; persist(agent, run);
      if (run.budget.snapshot().remainingCalls) agent.followup(message('The previous answer reached its token limit. Return a concise, complete JavaScript solve(input) implementation in one code block. Do not resume a partial block. This is the final request.'));
    });
  });
  ctx.effect(() => async () => {
    closing = true;
    for (const controller of controllers) controller.abort(new Error('Gene Editing unloaded.'));
    for (const [id, run] of runs) if (run.pending) ctx.agents.get(id)?.cancel({ kind: 'hook', reason: 'Gene Editing unloaded' });
    await Promise.allSettled([...work]);
    runs.clear();
  }, 'gene-editing.quiescence');
}
