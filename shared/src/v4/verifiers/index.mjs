import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { TASKS } from './tasks.mjs';
import { runGuestCases } from './sandbox.mjs';

export const VERIFIER_VERSION = 'gene-verifiers/1.0.1-quickjs-0.32.0';
const hash = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);

export function listVerificationTasks() {
  return TASKS.map(({ id, title, family, prompt }) => ({ id, title, family, prompt }));
}

export function getVerificationTask(id) {
  const task = TASKS.find(item => item.id === id);
  return task ? clone(task) : null;
}

export function extractCandidate(artifact) {
  if (typeof artifact !== 'string' || artifact.length > 131072) return null;
  const fenced = [];
  let open = null;
  for (const line of artifact.split(/\r\n|\n|\r/)) {
    if (open) {
      const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closing && closing[1][0] === open.marker[0] && closing[1].length >= open.marker.length) {
        fenced.push(open);
        open = null;
      } else open.lines.push(line);
    } else {
      // Fences occupy their own lines; inline backticks in prose cannot open a block.
      const opening = /^ {0,3}(`{3,}|~{3,})([^`~]*)$/.exec(line);
      if (opening) open = { marker: opening[1], info: opening[2].trim(), lines: [] };
    }
  }
  // An incomplete block leaves the response ambiguous, even after a complete candidate.
  if (open) return null;
  const js = fenced.filter(block => /^(?:js|javascript|ecmascript)?$/i.test(block.info));
  if (js.length > 1) return null;
  if (fenced.length === 0 && /^[\s]*[\[{"']/.test(artifact)) return null;
  const source = (js.length === 1 ? js[0].lines.join('\n') : fenced.length ? '' : artifact).trim().replace(/^export\s+(?:default\s+)?(?=function\s+solve\b)/, '');
  if (!source || source.length > 65536 || !/(?:\bfunction\s+solve\s*\(|\b(?:const|let|var)\s+solve\s*=)/.test(source)) return null;
  return source;
}

export function candidateHash(artifact) {
  const source = extractCandidate(artifact);
  return source === null ? null : hash(source);
}

function baseResult(artifact, taskId, selection) {
  return { artifactHash: hash(typeof artifact === 'string' ? artifact : ''), candidateHash: candidateHash(artifact), taskId, selection, verifierVersion: VERIFIER_VERSION, source: 'quickjs-guest-execution', checks: [] };
}

function selectPublicChecks(task, selection, policy, requiredCheckIds) {
  const byId = new Map(task.checks.map(check => [check.id, check]));
  if (!Array.isArray(requiredCheckIds) || requiredCheckIds.length > 32 || requiredCheckIds.some(id => !byId.has(id))) throw new Error('invalid_required_check');
  if (selection === 'full') return task.checks;
  if (selection !== 'diagnostic') throw new Error('invalid_selection');
  const order = Array.isArray(policy?.verificationOrder) ? policy.verificationOrder : ['baseline', 'constraint', 'boundary'];
  const priority = kind => { const at = order.indexOf(kind); return at < 0 ? 99 : at; };
  const optional = task.checks.filter(check => !check.mandatory).sort((a, b) => priority(a.kind) - priority(b.kind));
  const ids = new Set([...task.checks.filter(check => check.mandatory).map(check => check.id), ...requiredCheckIds]);
  if (optional[0]) ids.add(optional[0].id);
  return task.checks.filter(check => ids.has(check.id));
}

async function execute({ artifact, taskId, selection, checks, signal }) {
  const out = baseResult(artifact, taskId, selection);
  const source = extractCandidate(artifact);
  if (!source) return { ...out, status: 'unknown', reason: 'candidate_not_extractable', summary: '没有唯一可执行的 solve(input) JavaScript 候选。' };
  const started = Date.now();
  const result = await runGuestCases({ source, cases: checks, signal });
  if (result.error) return { ...out, elapsedMs: Date.now() - started, status: 'error', reason: result.error, summary: '检查器未完成，不能据此判定候选正确。' };
  out.checks = checks.map((check, i) => {
    const observed = result.rows[i];
    const passed = observed.status === 'executed' && isDeepStrictEqual(observed.actual, check.expected);
    return { id: check.id, kind: check.kind || 'acceptance', status: passed ? 'passed' : 'failed', input: clone(check.input), expected: clone(check.expected), ...(observed.status === 'executed' ? { actual: observed.actual } : { error: observed.error }), summary: check.summary || '独立留出验收', mandatory: Boolean(check.mandatory) };
  });
  const failed = out.checks.filter(check => check.status === 'failed').length;
  return { ...out, status: failed ? 'failed' : 'passed', passedChecks: out.checks.length - failed, totalChecks: out.checks.length, elapsedMs: Date.now() - started, summary: failed ? `${failed}/${out.checks.length} 项指定检查失败。` : `${out.checks.length} 项指定检查通过；不代表未覆盖行为均正确。` };
}

export async function verifyCandidate({ artifact, taskId, selection = 'diagnostic', policy, requiredCheckIds = [], signal } = {}) {
  signal?.throwIfAborted();
  const task = TASKS.find(item => item.id === taskId);
  if (!task) return { ...baseResult(artifact, taskId, selection), status: 'unknown', reason: 'unsupported_task', summary: '没有与此任务匹配的检查器。' };
  let checks;
  try { checks = selectPublicChecks(task, selection, policy, requiredCheckIds); }
  catch (error) { return { ...baseResult(artifact, taskId, selection), status: 'error', reason: error.message, summary: '检查选择无效；未执行或暴露任何隐藏验收。' }; }
  return execute({ artifact, taskId, selection, checks, signal });
}

export async function evaluateCandidate({ artifact, taskId, signal } = {}) {
  signal?.throwIfAborted();
  const { HIDDEN_CASES } = await import('./hidden-cases.mjs');
  const checks = Object.hasOwn(HIDDEN_CASES, taskId) ? HIDDEN_CASES[taskId] : null;
  if (!checks) return { ...baseResult(artifact, taskId, 'hidden'), status: 'unknown', reason: 'unsupported_task' };
  return execute({ artifact, taskId, selection: 'hidden', checks, signal });
}
