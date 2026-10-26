// Shadow replay: reads recorded outcomes, never executes tools or calls a model.
// Usage: node scripts/replay-feedback.mjs output.json session.jsonl[.zstd] [...]
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { toolProjection } from '../lib/tool-integration.mjs';
import { selectToolFeedback, formatToolFeedback } from '../lib/tool-feedback.mjs';

const [destination, ...inputs] = process.argv.slice(2);
if (!destination || !inputs.length) throw new Error('Usage: node scripts/replay-feedback.mjs output.json session.jsonl[.zstd] [...]');
if (inputs.some(file => path.resolve(file) === path.resolve(destination))) throw new Error('Output must not replace an input session.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function decode(file) {
  const input = fs.readFileSync(file);
  if (!file.endsWith('.zstd')) return { input, text: input.toString('utf8') };
  const parts = []; let offset = 0;
  while (offset < input.length) {
    const decoded = zstdDecompressSync(input.subarray(offset), { info: true });
    if (!decoded.engine.bytesWritten) throw new Error('Zstandard decoder made no progress.');
    offset += decoded.engine.bytesWritten; parts.push(decoded.buffer);
  }
  return { input, text: Buffer.concat(parts).toString('utf8') };
}

const cases = inputs.map((file, index) => {
  const { input, text } = decode(file);
  const events = text.trim().split('\n').map(JSON.parse);
  const header = events[0];
  if (header.type !== 'session' || header.isSeeded) throw new Error('This replay supports standalone, non-forked session logs only.');
  let state = toolProjection.init(header, 0), run = null, nativeRepeat = false;
  const before = { messages: 0, characters: 0 }, after = { messages: 0, characters: 0, byEvent: {} };
  for (const event of events.slice(1)) {
    if (event.type === 'plugin:gene-editing/state') run = event.data;
    if (event.type === 'user/message') {
      if (event.data.source?.kind === 'gene-editing-tools') {
        before.messages++;
        before.characters += event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n').length;
        continue; // Old notes must not acknowledge events in the new policy.
      }
      if (event.data.source?.kind === 'repeat-tool-reminder') nativeRepeat = true;
      if (event.data.source?.kind === 'user') nativeRepeat = false;
    }
    if (event.type === 'step/start') {
      const { turn, step } = event.data;
      if (run?.enabled && run.mode === 'preferences' && state.enabled
        && !(state.terminalStep?.turn === turn && state.terminalStep?.step === step - 1)) {
        const rows = state.observations.filter(row => row.seq > state.acknowledgedSeq && row.turn === turn && row.step === step - 1);
        const items = selectToolFeedback({ genes: run.genes, rows, history: state.observations,
          notified: state.notified, hasNativeRepeat: nativeRepeat });
        if (items.length) {
          after.messages++; after.characters += formatToolFeedback(items).length;
          for (const item of items) after.byEvent[item.kind] = (after.byEvent[item.kind] ?? 0) + 1;
          // Simulate admission at this recorded continuation boundary. No log is
          // modified, and later model actions are held fixed by this experiment.
          state = toolProjection.apply(state, { type: 'user/message', seq: event.seq, data: { source: {
            kind: 'gene-editing-tools', runId: run.runId, revision: run.revision, taskSeq: state.taskSeq,
            throughSeq: Math.max(...rows.map(row => row.seq)), genes: [...new Set(items.flatMap(item => item.genes))],
            events: items.map(({ key, kind, callId, seq }) => ({ key, kind, callId, seq })),
          } } });
        }
      }
      nativeRepeat = false;
    }
    state = toolProjection.apply(state, event);
  }
  return { label: `case-${index + 1}`, sourceSha256: hash(input), genes: run?.genes ?? null,
    recordedToolOutcomes: state.counts.total, before, after };
});

const report = {
  method: 'offline-shadow-replay', policyVersion: '0.6.3',
  meaning: 'Recorded model/tool actions are held fixed. Counts describe injected notes, not changed behavior or better artifacts.',
  units: 'characters are JavaScript string lengths, not tokens or billed cumulative input',
  modelRequests: 0, executedTools: 0, cases,
};
fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
