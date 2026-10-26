import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { GENES, presetGenes } from '../lib/shared/public/core.js';

// Exercise the built Client's state/command boundary without attaching to any
// installed profile. The minimal React shim inspects elements and state updates;
// it does not claim browser layout or upstream Web lifecycle validation.
async function panel({ effort = 'high', mutable = false, run = null, maxTokens = null } = {}) {
  const view = { status: 'idle', defaults: presetGenes(), defaultSettings: { reasoningEffort: effort, maxTokens, maxCalls: null },
    capabilities: { mutableEffort: mutable, fixedEffort: mutable ? null : effort }, tasks: [{ id: 'tuple_dedup', title: 'Tuple' }], run };
  const state = [true, view, presetGenes(), '', false, effort];
  let cursor = 0, exports, Component;
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial; return [state[i], value => { state[i] = value; }]; } };
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window: { __ModuleLoader__: { load: value => { exports = value.factory(name => { assert.equal(name, 'react'); return React; }); } } } });
  exports.apply({ effect() {}, remote: { commands: {} }, slots: { inject(_name, fn) { fn(); }, register(_definition, component) { Component = component; } } });
  const calls = [];
  const render = () => { cursor = 0; return Component({ sessionId: 'fixture', execute: async (_id, input) => { calls.push(input); return view; } }); };
  return { state, calls, render };
}
const nodes = value => !value || typeof value !== 'object' ? [] : [value, ...(value.children || []).flat(Infinity).flatMap(nodes)];
const text = value => value == null || value === false ? '' : typeof value !== 'object' ? String(value) : (Array.isArray(value) ? value : value.children || []).map(text).join('');
const run = (settings = { reasoningEffort: 'low' }) => ({ version: 2, genes: presetGenes(), revision: 4, settings, effectiveEffort: settings.reasoningEffort, phase: 'ready',
  budget: { callsUsed: 0, knownTotalTokens: 0, usageComplete: true }, currentEvidence: { unresolvedCount: 0 }, evidence: { entries: [] } });

test('applying Genes preserves host effort and never sends a benchmark task or submits a message', async () => {
  const p = await panel({ effort: 'low' });
  let tree = p.render();
  assert.equal(nodes(tree).find(n => n.props['aria-label'] === '独立 reasoning effort'), undefined);
  assert.doesNotMatch(text(tree), /模型 effort/);
  const depth = nodes(tree).find(n => n.props['aria-label'] === GENES.find(g => g.id === 'depth').name);
  depth.props.onChange({ target: { value: '2' } }); tree = p.render();
  assert.equal(p.state[2].depth, 100); assert.equal(p.state[5], 'low');
  assert.equal(nodes(tree).find(n => n.props['aria-label'] === '独立 reasoning effort'), undefined);
  assert.doesNotMatch(text(tree), /模型 effort/);
  assert.doesNotMatch(text(tree), /需新建 Agent|agentOptions/);
  await nodes(tree).find(n => n.type === 'button' && text(n) === '应用到当前会话').props.onClick();
  assert.equal(p.calls[0].op, 'apply'); assert.equal(p.calls[0].genes.depth, 100);
  for (const key of ['taskId', 'submit', 'settings', 'reasoningEffort', 'effort']) assert.equal(key in p.calls[0], false);
});

test('historical state does not resurrect removed benchmark and evidence modules', async () => {
  const historical = { ...run(), enabled: true, taskId: 'tuple_dedup', historicalReadOnly: true };
  const before = JSON.stringify(historical);
  const p = await panel({ run: historical });
  const tree = p.render();
  assert.doesNotMatch(text(tree), /同题任务|刷新证据|检查优先级|当前运行策略|失败检查|tokens|revision/);
  assert.equal(nodes(tree).find(n => n.type === 'button' && text(n) === '停用 Gene').props.disabled, true);
  await nodes(tree).find(n => n.type === 'button' && text(n) === '应用到当前会话').props.onClick();
  assert.equal(p.calls[0].op, 'apply'); assert.equal(p.calls[0].expectedRevision, 4);
  assert.equal(p.calls[0].genes.rigor, 100); assert.equal(p.calls[0].genes.skepticism, 50);
  assert.equal(JSON.stringify(historical), before);
});

test('reopening the panel reads the current session without a refresh-evidence control', async () => {
  const historical = run();
  const before = JSON.stringify(historical);
  const p = await panel({ effort: 'max', run: historical });
  p.state[0] = false;
  await nodes(p.render()).find(n => n.type === 'button' && text(n) === '◉ Gene Editing').props.onClick();
  // Opening starts an asynchronous read; allow its state update to settle.
  await new Promise(setImmediate);
  assert.equal(p.calls[0].op, 'get');
  assert.equal(p.state[2].rigor, 100); assert.equal(p.state[2].skepticism, 50);
  assert.equal(p.state[5], 'max');
  assert.equal(JSON.stringify(historical), before);
});

test('provider default effort stays internal and is neither displayed nor submitted by apply', async () => {
  const p = await panel({ effort: null });
  const tree = p.render();
  assert.equal(nodes(tree).find(n => n.props['aria-label'] === '独立 reasoning effort'), undefined);
  assert.doesNotMatch(text(tree), /模型 effort|宿主默认/);
  assert.equal(p.state[5], null);
  await nodes(tree).find(n => n.type === 'button' && text(n) === '应用到当前会话').props.onClick();
  for (const key of ['settings', 'reasoningEffort', 'effort']) assert.equal(key in p.calls[0], false);
});

test('applied status follows the draft and stopping only sends a revision-guarded command', async () => {
  const active = { ...run(), enabled: true, mode: 'preferences', taskId: null,
    genes: { exploration: 50, rigor: 100, creativity: 50, depth: 100, skepticism: 50, abstraction: 50, focus: 100, synthesis: 100 } };
  const p = await panel({ run: active });
  let tree = p.render();
  assert.match(text(tree), /已应用/);
  nodes(tree).find(n => n.props['aria-label'] === '探索').props.onChange({ target: { value: '2' } });
  tree = p.render();
  assert.doesNotMatch(text(tree), /已应用/);
  await nodes(tree).find(n => n.type === 'button' && text(n) === '停用 Gene').props.onClick();
  assert.equal(p.calls[0].op, 'stop'); assert.equal(p.calls[0].expectedRevision, 4);
  assert.equal('genes' in p.calls[0], false); assert.equal('taskId' in p.calls[0], false);
});

test('all Gene disclosures open, switch and close without submitting or changing a draft', async () => {
  const p = await panel();
  const initial = JSON.stringify(p.state[2]);
  assert.equal(nodes(p.render()).filter(n => n.props.className === 'ge-help').length, 0);
  for (const gene of GENES) {
    nodes(p.render()).find(n => n.props['aria-label'] === `查看${gene.name}工作逻辑`).props.onClick();
    const tree = p.render(), help = nodes(tree).find(n => n.props['aria-label'] === `${gene.name}工作逻辑`);
    assert.ok(help, gene.id);
    assert.match(text(help), /低.*中.*高/);
    assert.doesNotMatch(text(help), /0–33|34–66|67–100|RIG \/ 100|SKE \/ 100|FOC ≥ 67/);
    assert.equal(nodes(tree).filter(n => n.props['aria-expanded'] === true).length, 1);
    assert.equal(nodes(tree).filter(n => n.props.className === 'ge-help').length, 1);
    assert.equal(nodes(help).filter(n => n.props.className === 'ge-level-active').length, 1);
  }
  nodes(p.render()).find(n => n.props['aria-label'] === '收起工作逻辑').props.onClick();
  assert.equal(nodes(p.render()).filter(n => n.props.className === 'ge-help').length, 0);
  const openFocus = () => nodes(p.render()).find(n => n.props['aria-label'] === '查看聚焦工作逻辑').props.onClick();
  openFocus(); openFocus();
  assert.equal(nodes(p.render()).filter(n => n.props.className === 'ge-help').length, 0);
  openFocus();
  nodes(p.render()).find(n => n.props.className === 'ge-panel').props.onKeyDown({ key: 'Escape' });
  assert.equal(nodes(p.render()).filter(n => n.props.className === 'ge-help').length, 0);
  assert.equal(JSON.stringify(p.state[2]), initial); assert.equal(p.calls.length, 0);
});

test('three-position sliders update the displayed semantic preference', async () => {
  const p = await panel();
  nodes(p.render()).find(n => n.props['aria-label'] === '查看聚焦工作逻辑').props.onClick();
  const change = (name, value) => nodes(p.render()).find(n => n.props['aria-label'] === name).props.onChange({ target: { value: String(value) } });
  for (const [value, level] of [[0, 'low'], [1, 'medium'], [2, 'high']]) {
    change('聚焦', value);
    const tree = p.render();
    assert.equal(nodes(tree).find(n => n.props.className === 'ge-level-active').props['data-level'], level);
    assert.match(text(tree), value === 2 ? /Keep only decision-relevant details/ : value === 1 ? /Prioritize what changes the outcome/ : /Include relevant context without digressions/);
  }
  assert.equal(p.calls.length, 0);
});

test('legacy scores map to exactly three accessible draft positions and canonical submissions', async () => {
  const p = await panel();
  for (const [score, position, label, submitted] of [[33, 0, '低', 0], [34, 1, '中', 50], [66, 1, '中', 50], [67, 2, '高', 100]]) {
    p.state[2] = { ...presetGenes(), exploration: score };
    const tree = p.render();
    const sliders = nodes(tree).filter(n => n.type === 'input' && n.props.type === 'range');
    assert.equal(sliders.length, 8);
    for (const slider of sliders) {
      assert.equal(slider.props.min, '0'); assert.equal(slider.props.max, '2'); assert.equal(slider.props.step, '1');
      assert.ok(['低', '中', '高'].includes(slider.props['aria-valuetext']));
    }
    const exploration = sliders.find(n => n.props['aria-label'] === '探索');
    assert.equal(exploration.props.value, position); assert.equal(exploration.props['aria-valuetext'], label);
    await nodes(tree).find(n => n.type === 'button' && text(n) === '应用到当前会话').props.onClick();
    assert.equal(p.calls.at(-1).genes.exploration, submitted);
    assert.ok(Object.values(p.calls.at(-1).genes).every(value => [0, 50, 100].includes(value)));
  }
});

