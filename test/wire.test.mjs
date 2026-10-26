import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DeepSeekAdapter, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { createAssistantMessage, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm';

for (const maxTokens of [20000, 100000, 256000]) for (const effort of ['low', 'high', 'max']) test(`official DeepSeek adapter serializes host-selected ${maxTokens} max_tokens and independent ${effort} effort on a local fake endpoint`, async () => {
  let wire, path, attribution;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    wire = JSON.parse(Buffer.concat(chunks)); path = request.url;
    attribution = Object.keys(request.headers).filter(k => /dsh|harness|client|user-id/i.test(k));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [event, data] of [
      ['message_start', { type: 'message_start', message: { id: 'fixture-response', type: 'message', role: 'assistant', content: [], model: 'deepseek-v4-flash', usage: { input_tokens: 4, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
      ['message_stop', { type: 'message_stop' }],
    ]) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const options = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${server.address().port}`, maxTokens, reasoningEffort: effort });
    const adapter = new DeepSeekAdapter({ options: () => options, resolveAuth: async () => ({ headers: { authorization: 'Bearer local-test-not-a-real-key' } }),
      resolveUserId: () => 'local-fixture', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) });
    const chunks = [];
    for await (const chunk of adapter.stream({ provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: effort, maxTokens,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }], signal: new AbortController().signal })) chunks.push(chunk);
    assert.equal(wire.max_tokens, maxTokens);
    assert.equal(wire.output_config.effort, effort);
    assert.equal(wire.model, 'deepseek-v4-flash');
    assert.match(path, /messages/);
    assert.ok(chunks.some(c => c.type === 'text-delta' && c.text === 'fixture'), JSON.stringify(chunks));
    assert.ok(attribution.length > 0, 'official adapter includes attribution headers');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('official native thinking + tool_use stream replays through tool_result without dropping private continuation', async () => {
  const requests = [], signature = 'opaque-local-test-signature', thought = 'private fixture reasoning';
  const server = createServer(async (request, response) => {
    const parts = []; for await (const chunk of request) parts.push(chunk);
    requests.push(JSON.parse(Buffer.concat(parts)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('message_start', { message: { id: 'fixture-response-' + requests.length, type: 'message', role: 'assistant', content: [], model: 'deepseek-v4-flash', usage: { input_tokens: 8, output_tokens: 0 } } });
    if (requests.length === 1) {
      emit('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
      emit('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: thought } });
      emit('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature } });
      emit('content_block_stop', { index: 0 });
      emit('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'fixture-tool', name: 'gene_verify', input: {} } });
      emit('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"artifact":"function solve(input){return input}"}' } });
      emit('content_block_stop', { index: 1 });
      emit('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } });
    } else {
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Public fixture answer' } });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } });
    }
    emit('message_stop', {}); response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const options = resolveAdapterOptions({ baseURL: `http://127.0.0.1:${server.address().port}`, maxTokens: 20000, reasoningEffort: 'high' });
    const adapter = new DeepSeekAdapter({ options: () => options, resolveAuth: async () => ({ headers: { authorization: 'Bearer local-fixture' } }),
      resolveUserId: () => 'local-fixture', prepareExtensions: async () => ({ fields: {}, accept: async () => {} }) });
    const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Review a function.' }] });
    const base = { provider: 'deepseek', model: 'deepseek-v4-flash', reasoningEffort: 'high', maxTokens: 20000, signal: new AbortController().signal,
      tools: [{ name: 'gene_verify', description: 'Local fixture verifier', parameters: { type: 'object', properties: { artifact: { type: 'string' } }, required: ['artifact'] } }] };
    const first = []; for await (const chunk of adapter.stream({ ...base, messages: [input] })) first.push(chunk);
    const content = first.filter(c => c.type === 'block-end').map(c => c.block);
    assert.equal(content[0].type, 'reasoning'); assert.equal(content[0].text, thought);
    assert.equal(content[1].type, 'tool-call'); assert.equal(content[1].id, 'fixture-tool');
    assert.equal(JSON.parse(content[1].arguments).artifact, 'function solve(input){return input}');
    const finish = first.find(c => c.type === 'finish'); assert.equal(finish.reason.kind, 'tool-calls');
    const assistant = createAssistantMessage({ content, source: { provider: 'deepseek', model: 'deepseek-v4-flash', replayState: finish.replayState } });
    const tool = createMessage({ role: 'tool', toolCallId: 'fixture-tool', source: { kind: 'tool', callId: 'fixture-tool' }, content: [{ type: 'text', text: '{"status":"passed"}' }] });
    const final = []; for await (const chunk of adapter.stream({ ...base, messages: [input, assistant, tool] })) final.push(chunk);
    assert.equal(requests.length, 2); assert.ok(requests.every(r => r.max_tokens === 20000));
    const replay = requests[1].messages.find(m => m.role === 'assistant');
    assert.equal(replay.content[0].type, 'thinking'); assert.equal(replay.content[0].thinking, thought); assert.equal(replay.content[0].signature, signature);
    assert.equal(replay.content[1].type, 'tool_use'); assert.equal(replay.content[1].id, 'fixture-tool');
    const result = requests[1].messages.at(-1).content.find(c => c.type === 'tool_result');
    assert.equal(result.tool_use_id, 'fixture-tool'); assert.ok(JSON.stringify(result.content).includes('passed'));
    assert.ok(final.some(c => c.type === 'text-delta' && c.text === 'Public fixture answer'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
