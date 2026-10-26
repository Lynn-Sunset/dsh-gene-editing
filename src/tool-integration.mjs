import { createHash } from 'node:crypto';
import { z } from 'zod';
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools';

export const TOOL_KEY = 'geneEditingTools';
export const INSPECT_TOOL = 'gene_tools_inspect';
const STATE = 'plugin:gene-editing/state';
const OUTCOME = 'plugin:gene-editing/tool-outcome';
const MAX_ROWS = 128;
const clone = value => structuredClone(value);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(canonical(value) ?? 'null').digest('hex');
const parsedArgs = value => { try { return typeof value === 'string' ? JSON.parse(value || '{}') : value; } catch { return value; } };
const tier = n => n >= 67 ? 2 : n >= 34 ? 1 : 0;
const enabled = run => Boolean(run?.enabled && run.version === 4 && run.mode === 'preferences');
const identity = (callId, rootCallId, nested) => JSON.stringify([nested, rootCallId, callId]);
const blankCounts = () => ({ total: 0, roots: 0, nested: 0, succeeded: 0, failed: 0, cancelled: 0, skipped: 0 });
function fresh(owner, inherited = 0) {
  return { owner, inherited, runId: null, revision: 0, enabled: false, taskSeq: -1, turn: 0, step: 0,
    counts: blankCounts(), observations: [], pending: {}, finalMeta: {}, feedback: [], acknowledgedSeq: -1, terminalStep: null, dropped: 0 };
}
function taskReset(state, seq) {
  return { ...state, taskSeq: seq, observations: [], pending: {}, finalMeta: {}, feedback: [], acknowledgedSeq: seq, terminalStep: null };
}
function started(state, event, nested) {
  const d = event.data, callId = nested ? d.subCallId : d.callId;
  if (typeof callId !== 'string') return state;
  const entry = { callId, rootCallId: nested ? d.rootCallId : callId, parentCallId: nested ? d.parentCallId : null,
    name: d.name, nested, argsHash: hash(parsedArgs(d.arguments)), startSeq: event.seq,
    turn: d.turn ?? state.turn, step: d.step ?? state.step };
  const pending = { ...state.pending, [identity(callId, entry.rootCallId, nested)]: entry };
  // Bound derived metadata, never the host's calls. Original events remain in the session.
  const keys = Object.keys(pending);
  if (keys.length > 1024) delete pending[keys[0]];
  return { ...state, pending };
}
function settled(state, event, nested) {
  const d = event.data, m = nested ? d : d.message;
  const callId = nested ? d.subCallId : m?.toolCallId ?? m?.source?.callId;
  if (typeof callId !== 'string') return state;
  const rootCallId = nested ? d.rootCallId : callId;
  const key = identity(callId, rootCallId, nested);
  const start = state.pending[key];
  const turn = d.turn ?? start?.turn ?? state.turn, step = d.step ?? start?.step ?? state.step;
  if (state.observations.some(row => row.callId === callId && row.rootCallId === rootCallId && row.nested === nested && row.turn === turn && row.step === step)) return state;
  const code = d.error?.code ?? null;
  const status = code === 'ABORTED_BEFORE_DISPATCH' ? 'skipped' : code === 'ABORTED' ? 'cancelled' : m?.isError ? 'failed' : 'succeeded';
  const meta = state.finalMeta[key];
  const row = { ...start, callId, rootCallId: start?.rootCallId ?? (nested ? d.rootCallId : callId),
    parentCallId: start?.parentCallId ?? (nested ? d.parentCallId : null), name: start?.name ?? d.name ?? '(unavailable)',
    argsHash: start?.argsHash ?? (nested ? hash(d.arguments) : null), nested, turn, step, seq: event.seq,
    status, code, resultHash: hash(m?.content ?? []), business: meta?.business ?? 'unknown',
    artifactVersion: meta?.artifactVersion ?? null };
  const counts = { ...state.counts, total: state.counts.total + 1, [nested ? 'nested' : 'roots']: state.counts[nested ? 'nested' : 'roots'] + 1,
    [status]: state.counts[status] + 1 };
  const pending = { ...state.pending }, finalMeta = { ...state.finalMeta };
  delete pending[key]; delete finalMeta[key];
  return { ...state, counts, pending, finalMeta, observations: [...state.observations, row].slice(-MAX_ROWS),
    dropped: state.dropped + (state.observations.length >= MAX_ROWS ? 1 : 0) };
}

// Only durable outcomes enter this fold. A body returning successfully is not a final result.
export const toolProjection = {
  key: TOOL_KEY, stateVersion: 1, stateSchema: z.json(),
  init: (header, inheritedEventCount) => fresh(header.id, inheritedEventCount),
  apply(state, event) {
    if (event.seq < state.inherited) return state;
    if (event.surfaceOp === 'replace' || event.surfaceOp?.op === 'replace') return state;
    const record = pluginRecordOf(event);
    if (record?.type === STATE) {
      const run = record.data;
      if (run.sessionId !== state.owner) return state;
      const next = run.runId === state.runId ? state : fresh(state.owner, state.inherited);
      return { ...next, runId: run.runId, revision: run.revision, enabled: enabled(run) };
    }
    if (!state.enabled) return state;
    if (record?.type === OUTCOME && record.data.runId === state.runId) {
      const d = record.data;
      return { ...state, finalMeta: { ...state.finalMeta, [identity(d.callId, d.rootCallId, d.nested)]: d },
        terminalStep: d.concludesTurn ? { turn: state.turn, step: state.step } : state.terminalStep };
    }
    if (event.type === 'step/start') return { ...state, turn: event.data.turn, step: event.data.step };
    if (event.type === 'user/message') {
      const source = event.data.source;
      if (source?.kind === 'user') return taskReset(state, event.seq);
      if (source?.kind === 'gene-editing-tools' && source.runId === state.runId && source.revision === state.revision && source.taskSeq === state.taskSeq) {
        return { ...state, acknowledgedSeq: Math.max(state.acknowledgedSeq, source.throughSeq),
          feedback: [...state.feedback, { seq: event.seq, throughSeq: source.throughSeq, genes: source.genes, kind: 'native-continuation' }].slice(-MAX_ROWS) };
      }
    }
    if (event.type === 'tool/call') return started(state, event, false);
    // A native pruner may replace a historical surface result. It is not a
    // second execution, even when the original observation was evicted.
    if (event.type === 'tool/result') return settled(state, event, false);
    if (event.type === 'tool/ptc-dispatch-start') return started(state, event, true);
    if (event.type === 'tool/ptc-dispatch') return settled(state, event, true);
    return state;
  },
};

// Explicit contract adapter, not keyword inference over arbitrary tools or output text.
function outcomeMetadata(exec, result) {
  let business = 'unknown', artifactVersion = null;
  if (['ops_batch', 'ops_result'].includes(exec.name) && result.value && typeof result.value === 'object') {
    const v = result.value;
    if (v.error) business = 'failed';
    else if (exec.name === 'ops_batch') {
      if (v.failed > 0 || ['failed', 'error'].includes(v.status)) business = 'failed';
      else if (v.unknown > 0 || ['partial', 'incomplete'].includes(v.status)) business = 'partial';
      else if (['completed', 'complete', 'success', 'succeeded'].includes(v.status)) business = 'reported-complete';
    }
    // ops_result.complete is page completeness, not execution success. Its
    // source payload requires a versioned contract; retain unknown here.
    const version = v.contentHash ?? v.source?.contentHash;
    if (typeof version === 'string' && /^[a-f0-9]{64}$/i.test(version)) artifactVersion = version;
  }
  return { business, artifactVersion, concludesTurn: exec.callId === exec.rootCallId && result.concludesTurn === true && !result.isError };
}

const ACTIONS = {
  exploration: ['Consider another available capability if the current route is blocked.', 'When useful, discover a materially different method or capability; compare its actual result with the current route.'],
  rigor: ['Distinguish executed evidence from an untested claim.', 'Bind consequential claims to actual execution and the checked artifact version; a successful call alone does not verify the claim.'],
  creativity: ['Combine available capabilities when that changes the solution.', 'If the current approach is limiting, consider a different composition or intervention using available capabilities; label unmet prerequisites.'],
  depth: ['Follow a consequential unresolved dependency.', 'Trace the dependency or mechanism that determines the result; inspect the necessary concrete input or contract and stop once resolved.'],
  skepticism: ['Check a consequential assumption when evidence conflicts.', 'Use a targeted diagnostic or independent source to test a consequential assumption; retain a proposal that survives.'],
  abstraction: ['Reuse a method only when its preconditions match.', 'Identify a reusable operation or invariant, then test its applicability to the concrete task; do not equate similar tool names with equivalent behavior.'],
  focus: ['Reuse evidence that still applies to the current inputs.', 'Avoid repeating the same call with the same inputs without new evidence; reuse applicable results and finish when the objective is met.'],
  synthesis: ['Reconcile relevant returned results.', 'Combine actual branch results, retaining source identities, version differences and unresolved conflicts; discard stale attempts.'],
};
function directives(genes, rows, hasNativeRepeat = false) {
  const failures = rows.some(r => r.status !== 'succeeded' || ['failed', 'partial'].includes(r.business));
  return Object.entries(ACTIONS).flatMap(([key, descriptions]) => {
    const level = tier(genes[key]);
    if (!level || (key === 'focus' && hasNativeRepeat)) return [];
    if (level === 1 && !failures && !['rigor', 'synthesis'].includes(key)) return [];
    return [{ gene: key, text: descriptions[level - 1] }];
  });
}
function visibleCapabilities(ctx, agent) {
  return ctx.tools.schemas(agent).filter(tool => tool.name !== INSPECT_TOOL).sort((a, b) => a.name.localeCompare(b.name));
}
const inspectArgs = z.object({ operation: z.enum(['capabilities', 'outcomes']).default('capabilities'), query: z.string().max(240).default(''),
  offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(20).default(6),
  includeSchemas: z.boolean().default(false) }).strict();

export function installToolIntegration(ctx, { runOf }) {
  ctx.sessionProjections.register(toolProjection);
  const stateOf = agent => ctx.sessionProjections.stateOf(agent.session, TOOL_KEY);
  const getToolState = agent => {
    const run = runOf(agent), s = stateOf(agent);
    return { enabled: enabled(run), runId: run?.runId ?? null, revision: run?.revision ?? 0, taskSeq: s?.taskSeq ?? -1,
      counts: clone(s?.counts ?? blankCounts()), observations: clone(s?.observations ?? []),
      feedback: clone(s?.feedback ?? []), dropped: s?.dropped ?? 0 };
  };
  ctx.tools.register(defineTool({
    name: INSPECT_TOOL,
    description: 'Read the current agent’s visible tool contracts or Gene execution facts. Optional capability discovery and provenance inspection; performs no other tool, file, network or model action. Available only with active Gene conversation preferences. Capability visibility is not permission. In PTC use the native SDK route.',
    parameters: {
      operation: { type: 'string', enum: ['capabilities', 'outcomes'] }, query: { type: 'string', description: 'Literal name/description terms (not semantic search); empty lists all. Try a different term if no match.' },
      offset: { type: 'integer' }, limit: { type: 'integer', description: '1–20; default 6.' }, includeSchemas: { type: 'boolean', description: 'Include full input/output schemas; default false.' },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => true,
    async execute(input, exec) {
      exec.signal.throwIfAborted();
      const validation = inspectArgs.safeParse(input);
      if (!validation.success) throw new ToolArgsError(['Invalid inspection parameters: operation, query, offset, limit and includeSchemas only; limit 1–20.']);
      const agent = exec.agent, run = agent && runOf(agent);
      if (!enabled(run)) throw new Error('Apply Gene conversation preferences to this session first.');
      const args = validation.data, state = getToolState(agent);
      const available = visibleCapabilities(ctx, agent), catalogRevision = hash(available);
      if (args.operation === 'outcomes') {
        const rows = state.observations.filter(row => !args.query || row.name.toLowerCase().includes(args.query.toLowerCase()));
        return { ...state, observations: rows.slice(args.offset, args.offset + args.limit), totalRetained: rows.length,
          nextOffset: args.offset + args.limit < rows.length ? args.offset + args.limit : null,
          catalogRevision, semantics: 'Counts are native outcomes, not task verification. Only hashes/identities are copied here; inspect original tool results for evidence. Earlier retained rows may be omitted; durable host events remain authoritative.' };
      }
      const terms = args.query.toLowerCase().split(/\s+/u).filter(Boolean);
      const matches = available.filter(tool => terms.every(term => `${tool.name} ${tool.description}`.toLowerCase().includes(term)));
      const items = matches.slice(args.offset, args.offset + args.limit).map(tool => ({ name: tool.name, description: tool.description.slice(0, 600),
        schemaHash: hash(tool.parameters), ...(args.includeSchemas ? { parameters: tool.parameters, output: ctx.tools.get(tool.name, agent)?.output?.schema ?? null } : {}) }));
      return { runId: run.runId, revision: run.revision, catalogRevision, totalAvailable: available.length, totalMatches: matches.length,
        nextOffset: args.offset + args.limit < matches.length ? args.offset + args.limit : null, items,
        preferences: directives(run.genes, []).map(row => ({ gene: row.gene, guidance: row.text })),
        semantics: 'Current scoped registry snapshot. All calls still require native policy and permissions. No capability was activated or executed. Follow the host native/PTC presentation. Schema hashes identify contracts, not artifact versions or authority.' };
    },
  }));
  ctx.systemPrompt.section({ name: 'gene-editing.tools', order: 901, interpolate: false, text({ agent }) {
    if (!agent) return '';
    const run = runOf(agent);
    if (!enabled(run)) return '';
    const available = visibleCapabilities(ctx, agent);
    if (!available.length) return '';
    return `Gene tool integration: ${available.length} currently visible capabilities (catalog ${hash(available).slice(0, 12)}). Use native tools only when they help the task; answer directly when appropriate. ${INSPECT_TOOL} can inspect current contracts and execution provenance on demand; it does not activate or execute other tools. Follow native/PTC presentation and permissions. No required stages, checks, branches or output headings.\n${directives(run.genes, []).map(row => `${row.gene}: ${row.text}`).join('\n')}`;
  } });
  ctx.on('tools/result', (exec, result) => {
    const run = exec.agent && runOf(exec.agent);
    if (!enabled(run)) return;
    const meta = outcomeMetadata(exec, result);
    if (meta.concludesTurn || meta.business !== 'unknown' || meta.artifactVersion) appendPluginRecord(exec.agent.session, OUTCOME, {
      runId: run.runId, callId: exec.callId, rootCallId: exec.rootCallId, nested: exec.callId !== exec.rootCallId, ...meta });
  });
  ctx.on('agent/pre-step', async ({ agent, turn, step, signal }, next) => {
    const decision = await next();
    signal.throwIfAborted();
    if (decision.kind !== 'enter' || decision.messages.some(m => m.source?.kind === 'user')) return decision;
    const run = runOf(agent), s = stateOf(agent);
    if (!enabled(run) || !s || (s.terminalStep?.turn === turn && s.terminalStep?.step === step - 1)) return decision;
    const rows = s.observations.filter(row => row.seq > s.acknowledgedSeq && row.turn === turn && row.step === step - 1 && row.name !== INSPECT_TOOL);
    if (!rows.length) return decision;
    const actions = directives(run.genes, rows, decision.messages.some(m => m.source?.kind === 'repeat-tool-reminder'));
    if (!actions.length) return decision;
    const throughSeq = Math.max(...rows.map(row => row.seq));
    const shown = rows.slice(-12).map(row => `${row.callId} ${row.name}: ${row.status}${row.code ? ` (${row.code})` : ''}; business=${row.business}${row.nested ? `; nested under ${row.rootCallId}` : ''}${row.artifactVersion ? `; artifact=${row.artifactVersion}` : ''}`).join('\n');
    const text = `Gene execution feedback (${rows.length} new outcomes; ${Math.min(rows.length, 12)} shown). This is provenance, not a verification verdict. Nested failure may have been intentionally handled by the outer program. No automatic retry or extra step is required.\n${shown}\n${actions.map(row => `${row.gene}: ${row.text}`).join('\n')}`;
    const feedback = createUserMessage({ source: { kind: 'gene-editing-tools', form: 'notice', summary: 'Gene tool execution feedback',
      runId: run.runId, revision: run.revision, taskSeq: s.taskSeq, throughSeq, genes: actions.map(row => row.gene) }, content: [{ type: 'text', text }] });
    // Acknowledgement happens only when the host durably admits this message.
    return { ...decision, messages: [...decision.messages, feedback] };
  });
  return { getToolState };
}
