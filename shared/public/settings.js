import { validateSettings as validateLegacySettings } from './core.js';

export const DEFAULT_MAX_TOKENS = 20000;
export const MAX_TOKENS = 100000;

export function validateReasoningEffort(reasoningEffort = 'high') {
  if (!['low', 'high', 'max'].includes(reasoningEffort)) throw new Error('Reasoning effort 必须为 low、high 或 max。');
  return reasoningEffort;
}

// Keep the original experiment's core.js byte-for-byte reproducible.
export function validateSettings(input = {}) {
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens < 1024 || maxTokens > MAX_TOKENS) throw new Error('每轮输出预算必须为 1024–100000 tokens。');
  const settings = validateLegacySettings({ ...input, maxTokens: Math.min(maxTokens, 16384) });
  return { ...settings, maxTokens, reasoningEffort: validateReasoningEffort(input.reasoningEffort) };
}
