// Accounting only: the host/provider owns admission and per-request limits.
// null means no plugin limit, never an infinite numeric JSON value.
export class RequestLedger {
  #calls = [];
  reserve(kind = 'answer', maxTokens = null) {
    if (maxTokens !== null && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) throw new Error('Invalid resolved host token limit.');
    const id = this.#calls.length + 1;
    this.#calls.push({ id, kind, maxTokens, status: 'pending', usage: null });
    return id;
  }
  settle(id, usage) {
    const call = this.#calls[id - 1];
    if (!call || call.status !== 'pending') throw new Error('Unknown or already settled model attempt.');
    const sanitized = {};
    for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']) {
      if (Number.isFinite(usage?.[k]) && usage[k] >= 0) sanitized[k] = usage[k];
    }
    const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
    if (Number.isFinite(reasoning) && reasoning >= 0) sanitized.completion_tokens_details = { reasoning_tokens: reasoning };
    call.usage = Object.keys(sanitized).length ? sanitized : null;
    call.status = 'settled';
    return this.snapshot();
  }
  snapshot() {
    const calls = structuredClone(this.#calls);
    const knownTotalTokens = calls.reduce((sum, call) => sum + (call.usage?.total_tokens ?? 0), 0);
    const missingUsageCalls = calls.filter(call => call.status === 'settled' && call.usage?.total_tokens === undefined).length;
    const pendingCalls = calls.filter(call => call.status === 'pending').length;
    return { maxTokens: null, maxCalls: null, remainingCalls: null, callsUsed: calls.length, knownTotalTokens, missingUsageCalls, pendingCalls, usageComplete: !missingUsageCalls && !pendingCalls, calls };
  }
}
