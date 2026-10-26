import { validateGenes } from './core.js';
import { deriveCompactPolicy } from './compact-policy.js';

export const V4_DEFAULT_MAX_TOKENS = 20000;
export const V4_MAX_TOKENS = 100000;
export function validateV4TokenBudget(maxTokens = V4_DEFAULT_MAX_TOKENS) {
  if (!Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > V4_MAX_TOKENS) throw new Error('V4 每次请求预算必须为 1024–100000 tokens。');
  return maxTokens;
}
const level = n => n >= 67 ? 'high' : n >= 34 ? 'medium' : 'low';
function override(value, fallback) {
  const n = value ?? fallback;
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('Gene override must be between 0 and 100.');
  return Math.round(n);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// The semantic and runtime factors can be separated for controlled experiments.
// Runtime scores never enter the model directive.
export function compilePolicy(genes, { reasoningEffort = 'high', revision = 1, semanticSkepticism, runtimeSkepticism, evidence = {}, budget = {} } = {}) {
  const g = validateGenes(genes);
  // The official adapter can leave request limits to its native host. Other
  // runtimes retain their existing explicit token budget and validation.
  if (budget.mode !== undefined && budget.mode !== 'host') throw new Error('Unknown request budget mode.');
  const followsHost = budget.mode === 'host';
  const maxTokens = followsHost ? null : validateV4TokenBudget(budget.maxTokens);
  if (!Number.isInteger(revision) || revision < 1) throw new Error('Invalid gene revision.');
  const semantic = override(semanticSkepticism, g.skepticism), runtime = override(runtimeSkepticism, g.skepticism);
  const compact = deriveCompactPolicy({ ...g, skepticism: semantic }, { reasoningEffort });
  const scores = { baseline: 1, constraint: 1.2 * g.rigor / 100, boundary: 2 * runtime / 100 };
  const verificationOrder = Object.keys(scores).sort((a, b) => scores[b] - scores[a]);
  return freeze({
    controller: 'evidence-v4', version: 1, revision, genes: g,
    semanticSkepticism: semantic, runtimeSkepticism: runtime,
    preferences: compact.preferences, effort: compact.effort,
    levels: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, level(v)])),
    verificationOrder, verificationScores: scores,
    stop: { maxUnchangedRepairs: g.focus >= 67 ? 1 : 2, reuseIdenticalEvidence: g.focus >= 67 },
    limits: { maxTokens, recoveryCalls: followsHost ? null : 1, repairCalls: followsHost ? null : 1 },
    observed: { unresolvedCount: Number.isInteger(evidence.unresolvedCount) ? evidence.unresolvedCount : 0, remainingCalls: Number.isInteger(budget.remainingCalls) ? budget.remainingCalls : null },
  });
}

export function makeV4Directive(policy, { round = 0, maxRounds = 2, verificationTask } = {}) {
  const checked = Boolean(verificationTask);
  return `Solve the user's task in its language. Return one useful answer, with code when requested. Do not emit harness JSON, action labels, confidence scores, or duplicate summaries. Do not reveal private deliberation. Preserve the user's constraints and retain correct behavior unless concrete evidence justifies a change.
Behavior preferences:
${Object.entries(policy.preferences).map(([key, value]) => `${key}: ${value}`).join('\n')}
${checked ? 'For this task the harness can execute the requested pure JavaScript solve(input) function in an isolated interpreter. Return one complete implementation in a single JavaScript code block. Do not use imports, Node APIs, network, files, timers, or external packages. Public test feedback may follow. Fix only defects supported by the task or actual feedback; do not invent tool results.' : 'No task-specific verifier is selected. Answer normally; do not claim that code was executed or independently verified.'}
${maxRounds === null ? '' : `Request ${round + 1} of at most ${maxRounds}, including recovery and repair. `}Finish when ready; there are no mandatory headings or minimum numbers of alternatives or checks.`;
}
