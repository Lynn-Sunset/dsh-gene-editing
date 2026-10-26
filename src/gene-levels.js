import { validateGenes } from '../shared/public/core.js';

// Keep the Host's numeric protocol and historical records compatible. The Web
// draft exposes exactly three choices and submits one canonical value per tier.
export const GENE_LEVELS = [
  { id: 'low', label: '低', value: 0 },
  { id: 'medium', label: '中', value: 50 },
  { id: 'high', label: '高', value: 100 },
];
export const geneLevelIndex = value => value >= 67 ? 2 : value >= 34 ? 1 : 0;
export const discreteGeneDraft = genes => Object.fromEntries(
  Object.entries(validateGenes(genes)).map(([id, value]) => [id, GENE_LEVELS[geneLevelIndex(value)].value]),
);
