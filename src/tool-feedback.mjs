import { createHash } from 'node:crypto';

const tier = value => value >= 67 ? 2 : value >= 34 ? 1 : 0;
const failed = row => row.status === 'failed' || ['failed', 'partial'].includes(row.business);
const failureClass = row => [row.status, row.code, row.business];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const operation = row => [row.name, row.nested === true, row.argsHash];
const sameOperation = (a, b) => a.name === b.name && a.nested === b.nested && a.argsHash === b.argsHash;
const version = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);

// Each cue concerns an observed transition. These are decision aids, never a
// request to add another tool call, fixed stage, or output section.
const CUES = {
  failure: {
    rigor: ['Keep this failed attempt separate from verified evidence.', 'Do not use this failed attempt to certify the current artifact.'],
    depth: ['Check the relevant input or dependency.', 'Locate the input or dependency responsible before changing the approach.'],
    skepticism: ['Revisit the assumption implicated by this error.', 'Use the reported error to test the implicated assumption; retain what still holds.'],
  },
  'repeat-failure': {
    exploration: ['Consider another authorized route.', 'Compare a materially different authorized route if this one remains blocked.'],
    creativity: ['Consider a different useful combination of available capabilities.', 'Recompose available capabilities if the current mechanism is the obstacle.'],
    depth: ['Resolve the dependency behind the repeated failure.', 'Inspect the unresolved cause instead of merely repeating the attempt.'],
    abstraction: ['Check whether the reused method fits these inputs.', 'Recheck the method’s preconditions against this concrete failure.'],
    focus: ['Avoid an unchanged retry without a reason.', 'Reuse the failure evidence; repeat only with a relevant change or native retry reason.'],
  },
  'repeat-result': {
    focus: ['Reuse the result when it still applies.', 'Reuse this result unless intentional polling, verification, or changed conditions justify another call.'],
  },
  recovery: {
    rigor: ['A recovered execution still needs task-relevant evidence.', 'Execution recovered; check the actual artifact before treating the task as verified.'],
    synthesis: ['Use the recovered result in place of the failed attempt.', 'Reconcile the recovery with earlier attempts, retaining any unresolved limitation.'],
  },
  'version-change': {
    rigor: ['Keep evidence attached to the version it checked.', 'Do not carry earlier verification over to the newly declared content version.'],
    abstraction: ['Check whether earlier assumptions still apply.', 'Recheck the reused method’s preconditions against the new declared version.'],
    synthesis: ['Use the appropriate version when combining results.', 'Keep old and new declared content versions distinct when combining evidence.'],
  },
};

function signals(row, previous) {
  if (['cancelled', 'skipped'].includes(row.status)) return [];
  if (failed(row)) {
    const repeated = previous && failed(previous) && digest(failureClass(previous)) === digest(failureClass(row));
    return [{ kind: repeated ? 'repeat-failure' : 'failure', detail: failureClass(row) }];
  }
  if (row.status !== 'succeeded') return [];
  const events = [];
  if (previous && failed(previous)) events.push({ kind: 'recovery', detail: failureClass(previous) });
  if (previous && version(previous.artifactVersion) && version(row.artifactVersion) && previous.artifactVersion !== row.artifactVersion) {
    events.push({ kind: 'version-change', detail: [previous.artifactVersion, row.artifactVersion] });
  } else if (previous?.status === 'succeeded' && !failed(previous) && previous.resultHash && previous.resultHash === row.resultHash) {
    events.push({ kind: 'repeat-result', detail: row.resultHash });
  }
  return events;
}

export function selectToolFeedback({ genes, rows, history, notified = [], hasNativeRepeat = false }) {
  const seen = new Set(notified), items = [];
  for (const row of rows) {
    // Nested outcomes remain inspectable. The outer program owns handling its
    // internal failures; only the final root outcome triggers a continuation cue.
    if (row.nested || row.name === 'gene_tools_inspect' || !row.argsHash) continue;
    const previous = history.findLast(other => other.seq < row.seq && sameOperation(other, row)
      && !['cancelled', 'skipped'].includes(other.status));
    for (const signal of signals(row, previous)) {
      const key = digest([signal.kind, ...operation(row), signal.detail]);
      if (seen.has(key)) continue;
      const guidance = Object.entries(CUES[signal.kind]).flatMap(([gene, choices]) => {
        const level = tier(genes[gene]);
        if (!level || (gene === 'focus' && hasNativeRepeat)) return [];
        return [{ gene, text: choices[level - 1] }];
      });
      if (!guidance.length) continue;
      seen.add(key);
      const evidence = `${String(row.name).slice(0, 80)} (${String(row.callId).slice(0, 100)}): ${signal.kind}; status=${row.status}; business=${row.business}`;
      items.push({ key, kind: signal.kind, callId: row.callId, seq: row.seq,
        genes: guidance.map(item => item.gene),
        text: `${evidence}\n${guidance.map(item => `${item.gene}: ${item.text}`).join('\n')}` });
      if (items.length === 3) return items;
    }
  }
  return items;
}

export function formatToolFeedback(items) {
  return `Gene tool note — native permissions and retry policy apply; no extra call is required.\n${items.map(item => item.text).join('\n')}`;
}
