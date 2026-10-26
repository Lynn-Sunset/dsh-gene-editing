import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePolicy, makeV4Directive } from '../lib/shared/src/v4/policy.mjs';
import { presetGenes } from '../lib/shared/public/core.js';

test('native-host policy removes plugin budget hints while keeping behavior preferences', () => {
  const legacy = compilePolicy(presetGenes(), { reasoningEffort: 'max', budget: { maxTokens: 100000 } });
  const current = compilePolicy(presetGenes(), { reasoningEffort: 'max', budget: { mode: 'host' } });
  assert.deepEqual(current.preferences, legacy.preferences);
  assert.deepEqual(current.verificationOrder, legacy.verificationOrder);
  assert.deepEqual(current.limits, { maxTokens: null, recoveryCalls: null, repairCalls: null });
  assert.doesNotMatch(makeV4Directive(current, { round: 12, maxRounds: null }), /of at most|final request/);
  assert.match(makeV4Directive(legacy, { round: 0, maxRounds: 2 }), /Request 1 of at most 2/);
  assert.throws(() => compilePolicy(presetGenes(), { budget: { maxTokens: 256000 } }), /1024–100000/);
});
