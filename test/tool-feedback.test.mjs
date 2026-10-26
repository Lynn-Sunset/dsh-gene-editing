import test from 'node:test';
import assert from 'node:assert/strict';
import { selectToolFeedback } from '../lib/tool-feedback.mjs';
import { toolProjection } from '../lib/tool-integration.mjs';

const genes = { exploration: 100, rigor: 100, creativity: 100, depth: 100,
  skepticism: 100, abstraction: 100, focus: 100, synthesis: 100 };
const row = (seq, overrides = {}) => ({ seq, name: 'render', nested: false, callId: `call-${seq}`,
  argsHash: 'a'.repeat(64), resultHash: 'b'.repeat(64), status: 'failed', business: 'unknown', code: null, ...overrides });

test('admission alone acknowledges event keys; replay restores deduplication and a new human question resets it', () => {
  const stateEvent = { type: 'plugin:gene-editing/state', ignorable: true, seq: 0, data: {
    version: 4, mode: 'preferences', enabled: true, sessionId: 'owner', runId: 'run', revision: 1,
  } };
  const input = { type: 'user/message', seq: 1, data: { source: { kind: 'user' } } };
  let state = toolProjection.apply(toolProjection.init({ id: 'owner' }, 0), stateEvent);
  state = toolProjection.apply(state, input);
  const evidence = row(4);
  const items = selectToolFeedback({ genes, rows: [evidence], history: [evidence], notified: state.notified });
  assert.equal(items.length, 1);
  assert.equal(state.notified.length, 0, 'Preparing a note cannot acknowledge it.');
  const admitted = { type: 'user/message', seq: 5, data: { source: {
    kind: 'gene-editing-tools', runId: 'run', revision: 1, taskSeq: 1, throughSeq: 4,
    genes: items[0].genes, events: items.map(({ key, kind, callId, seq }) => ({ key, kind, callId, seq })),
  } } };
  const restored = [stateEvent, input, admitted].reduce(toolProjection.apply, toolProjection.init({ id: 'owner' }, 0));
  assert.equal(selectToolFeedback({ genes, rows: [evidence], history: [evidence], notified: restored.notified }).length, 0);
  const pruned = toolProjection.apply(restored, { ...admitted, seq: 6, surfaceOp: { op: 'replace' } });
  assert.deepEqual(pruned, restored);
  const reset = toolProjection.apply(restored, { ...input, seq: 7 });
  assert.equal(reset.notified.length, 0);
  assert.equal(selectToolFeedback({ genes, rows: [evidence], history: [evidence], notified: reset.notified }).length, 1);
  const legacy = structuredClone(admitted); delete legacy.data.source.events;
  const legacyState = toolProjection.apply(state, legacy);
  assert.equal(legacyState.notified.length, 0, 'Old feedback records remain readable without inventing event keys.');
});

test('cancelled and skipped work cannot become failure advice even if earlier metadata reports failure', () => {
  const rows = [row(2, { status: 'cancelled', business: 'failed' }), row(3, { status: 'skipped', business: 'partial' })];
  assert.deepEqual(selectToolFeedback({ genes, rows, history: rows }), []);
});

test('a batch gives at most three event notes and only emitted keys are acknowledged', () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(i + 1, { argsHash: String(i).repeat(64) }));
  const notes = selectToolFeedback({ genes, rows, history: rows });
  assert.equal(notes.length, 3);
  assert.equal(new Set(notes.map(item => item.key)).size, 3);
  assert.deepEqual(notes.map(item => item.callId), ['call-1', 'call-2', 'call-3']);
});

test('a non-version output change is not treated as an evidence conflict or artifact revision', () => {
  const first = row(1, { status: 'succeeded', resultHash: 'a'.repeat(64) });
  const second = row(2, { status: 'succeeded', resultHash: 'c'.repeat(64) });
  assert.deepEqual(selectToolFeedback({ genes, rows: [second], history: [first, second] }), []);
});
