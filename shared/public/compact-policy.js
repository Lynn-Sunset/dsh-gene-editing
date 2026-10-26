import { validateGenes, derivePolicy as legacyPolicy } from './core.js';
import { validateReasoningEffort } from './settings.js';

const tier = n => n >= 67 ? 2 : n >= 34 ? 1 : 0;
export function deriveCompactPolicy(genes, { reasoningEffort = 'high' } = {}) {
  const g = validateGenes(genes);
  return { ...legacyPolicy(g), effort: validateReasoningEffort(reasoningEffort), controller: 'compact-v3', preferences: {
    exploration: ['Prefer a direct workable method.', 'Consider a materially different method only when it changes the decision.', 'Compare meaningfully different approaches when useful, then choose; omit redundant alternatives.'][tier(g.exploration)],
    rigor: ['Keep claims consistent with the supplied facts.', 'Separate evidence from assumptions; qualify unverified claims.', 'Check consequential claims against the supplied constraints; use arithmetic assistance when numerical uncertainty matters.'][tier(g.rigor)],
    creativity: ['Favor established solutions.', 'Use a useful combination of familiar ideas when it helps.', 'Consider a non-obvious solution when useful and explain its practical cost.'][tier(g.creativity)],
    depth: ['Explain the mechanism only as far as needed for the task.', 'Explain a consequential mechanism or difficult detail when it clarifies the answer.', 'Examine the mechanisms and difficult details that determine the answer, making relevant dependencies and conditions explicit. Stop when those details are resolved; do not add length or extra stages for their own sake.'][tier(g.depth)],
    skepticism: ['Emphasize a workable solution and its rationale. Fix noticed defects, but do not add a separate adversarial review merely for completeness.', 'Examine a consequential assumption when there is a concrete reason for doubt; include the result if it affects the decision.', 'Stress-test a consequential assumption or boundary before committing. Include a concise diagnostic example or argument when it changes or supports the decision; if the proposal survives, retain it. Do not invent objections or violate the given premises.'][tier(g.skepticism)],
    abstraction: ['Stay close to concrete implementation.', 'Use a general principle only if it clarifies this task.', 'Connect a useful general principle to a concrete implication; omit abstract restatement without value.'][tier(g.abstraction)],
    focus: ['Include relevant context without digressions.', 'Prioritize what changes the outcome.', 'Keep only decision-relevant details and honor the requested brevity.'][tier(g.focus)],
    synthesis: ['State a usable conclusion.', 'Choose a solution with its decisive reason.', 'Choose a solution and state a consequential tradeoff or limitation, if one remains.'][tier(g.synthesis)]
  }, limits: { minimumRecords: 0, recoveryCalls: 1, repeatedCalculations: 3 - tier(g.focus) } };
}

export function makeCompactDirective(policy, { round, maxRounds }) {
  return `Solve the user's task in its language. Return ONE useful answer in the format the user needs. Do not emit harness JSON, action labels, confidence scores, or duplicate summaries. There are no mandatory headings, candidate lists, or minimum check counts. Never reveal private deliberation. Public evidence and concise correctness arguments are welcome.
Preserve the user's stated constraints and semantics. Distinguish assumptions from facts. Retain a correct proposal unless a concrete reason justifies changing it. Do not add boilerplate to satisfy a preference. For short tasks, aim for at most 1200 Chinese characters or 650 English words; accuracy and the user's explicit format take priority.
Behavior preferences:
${Object.entries(policy.preferences).map(([key,value]) => `${key}: ${value}`).join('\n')}
Optional local arithmetic assistance: if an actual calculation is needed BEFORE answering, output only one line: @calculate EXPRESSION
The harness will evaluate numbers, parentheses, + - * / % ** (max 400 characters; bounded magnitude) and return the result. No variables, code, network, or files. Otherwise answer directly. Never claim a tool ran without returned feedback. This is a small harness command, not a required step or a provider-native tool call.
Request ${round + 1} of at most ${maxRounds}, including any calculation or transport recovery. ${round + 1 === maxRounds ? 'This is the last request; give a complete answer using available information, stating any limitation.' : 'Finish immediately when ready; extra requests are not mandatory.'}`;
}
