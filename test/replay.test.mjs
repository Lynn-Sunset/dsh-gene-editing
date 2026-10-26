import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { zstdCompressSync } from 'node:zlib';

test('offline replay decodes concatenated frames and detects failure transitions without executing recorded commands', async () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const folder = await fs.mkdtemp(join(testDir, '.replay-fixture-'));
  try {
    const events = [
      { type: 'session', id: 'replay-fixture', version: 4, isSeeded: false },
      { type: 'plugin:gene-editing/state', ignorable: true, seq: 0, data: {
        version: 4, mode: 'preferences', enabled: true, sessionId: 'replay-fixture', runId: 'run', revision: 1,
        genes: { rigor: 100, exploration: 100 },
      } },
      { type: 'user/message', seq: 1, data: { source: { kind: 'user' } } },
    ];
    let seq = 2;
    for (let step = 1; step <= 3; step++) {
      events.push({ type: 'step/start', seq: seq++, data: { turn: 1, step } });
      events.push({ type: 'tool/call', seq: seq++, data: { turn: 1, step, callId: `fixture-${step}`, name: 'pwsh',
        arguments: JSON.stringify({ command: 'THIS MUST NEVER BE EXECUTED' }) } });
      events.push({ type: 'tool/result', seq: seq++, data: { turn: 1, step, message: {
        toolCallId: `fixture-${step}`, isError: true, content: [{ type: 'text', text: 'recorded failure' }],
      } } });
    }
    events.push({ type: 'step/start', seq: seq++, data: { turn: 1, step: 4 } });
    const file = join(folder, 'session.jsonl.zstd'), output = join(folder, 'report.json');
    const data = Buffer.concat(events.map(event => zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n'))));
    await fs.writeFile(file, data);
    await promisify(execFile)(process.execPath, [resolve(testDir, '../scripts/replay-feedback.mjs'), output, file], { windowsHide: true });
    const report = JSON.parse(await fs.readFile(output, 'utf8'));
    assert.equal(report.cases[0].recordedToolOutcomes, 3);
    assert.deepEqual(report.cases[0].after.byEvent, { failure: 1, 'repeat-failure': 1 });
    assert.equal(report.cases[0].after.messages, 2);
    assert.equal(report.modelRequests, 0); assert.equal(report.executedTools, 0);
    assert.deepEqual(await fs.readFile(file), data, 'The input session must remain byte-identical.');
    assert.doesNotMatch(JSON.stringify(report), /THIS MUST NEVER|replay-fixture|recorded failure/);
  } finally {
    assert.ok(resolve(folder).startsWith(resolve(testDir) + sep + '.replay-fixture-'));
    await fs.rm(folder, { recursive: true, force: true });
  }
});
