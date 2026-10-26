import { V4_DEFAULT_MAX_TOKENS, validateV4TokenBudget } from './policy.mjs';

export class BudgetLedger {
  #calls = [];
  constructor({ maxRounds = 2, maxTokens = V4_DEFAULT_MAX_TOKENS } = {}) {
    if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 8) throw new Error('运行请求上限必须为 1–8。');
    validateV4TokenBudget(maxTokens);
    this.maxRounds = maxRounds;
    this.maxTokens = maxTokens;
  }
  reserve(kind = 'answer') {
    if (this.#calls.length >= this.maxRounds) throw new Error('模型请求预算已用尽。');
    const id = this.#calls.length + 1;
    this.#calls.push({ id, kind, maxTokens: this.maxTokens, status: 'pending', usage: null });
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
    const knownTotalTokens = calls.reduce((sum, c) => sum + (c.usage?.total_tokens ?? 0), 0);
    const missingUsageCalls = calls.filter(c => c.status === 'settled' && c.usage?.total_tokens === undefined).length;
    const pendingCalls = calls.filter(c => c.status === 'pending').length;
    return { maxTokens: this.maxTokens, maxCalls: this.maxRounds, callsUsed: calls.length, remainingCalls: this.maxRounds - calls.length, knownTotalTokens, missingUsageCalls, pendingCalls, usageComplete: !missingUsageCalls && !pendingCalls, calls };
  }
}
