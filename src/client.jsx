import React, { useState } from 'react';
import { GENES, presetGenes } from '../shared/public/core.js';
import { compilePolicy } from '../shared/public/evidence-policy.js';
import { GENE_HELP } from './gene-help.js';
import { GENE_LEVELS, geneLevelIndex, discreteGeneDraft } from './gene-levels.js';
export const inject = ['slots', 'remote', 'remote.commands'];
function GenePanel({ sessionId, execute }) {
  const [open, setOpen] = useState(false), [view, setView] = useState(null), [genes, setGenes] = useState(() => discreteGeneDraft(presetGenes()));
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState('high');
  const [helpGeneId, setHelpGeneId] = useState(null);
  const helpGene = GENES.find(g => g.id === helpGeneId);
  const help = helpGene && GENE_HELP[helpGene.id];
  const helpPanelId = `ge-help-${sessionId || 'draft'}`;
  const draftGenes = discreteGeneDraft(genes);
  const nextPolicy = compilePolicy(draftGenes, { reasoningEffort: reasoningEffort ?? 'high', budget: { mode: 'host' } });
  const applied = view?.run?.enabled && view.run.mode === 'preferences' && GENES.every(g => view.run.genes[g.id] === draftGenes[g.id]);
  async function call(op) {
    setBusy(true); setError('');
    try {
      const result = await execute(sessionId, { op, ...(op === 'apply' ? { genes: draftGenes } : {}), expectedRevision: view?.run?.revision || 0 });
      setView(result); if (op === 'get') { setGenes(discreteGeneDraft(result.run?.genes || result.defaults)); setReasoningEffort(result.defaultSettings.reasoningEffort ?? null); }
    } catch (e) { setView(null); setError(e.message); } finally { setBusy(false); }
  }
  return <span className="ge-root"><button className="ge-trigger" onClick={() => { setOpen(!open); if (!open) call('get'); }}>◉ Gene Editing</button>
    {open && <section className="ge-panel" aria-label="Gene Editing" onKeyDown={e => { if (e.key === 'Escape') setHelpGeneId(null); }}><header><h2>Gene Editing</h2><button aria-label="关闭面板" onClick={() => setOpen(false)}>×</button></header>
      <div className="ge-settings"><span>当前会话{applied && <span className="ge-applied" role="status">已应用</span>}</span></div>
      <div className="ge-genes">{GENES.map(g => <div className="ge-gene" key={g.id}><div className="ge-gene-name"><span>{g.code} <b>{g.name}</b></span><button type="button" className="ge-info" aria-label={`查看${g.name}工作逻辑`} title={`查看${g.name}工作逻辑`} aria-expanded={helpGeneId === g.id} aria-controls={helpGeneId === g.id ? helpPanelId : undefined} onClick={() => setHelpGeneId(helpGeneId === g.id ? null : g.id)}>i</button></div><output>{GENE_LEVELS[geneLevelIndex(draftGenes[g.id])].label}</output><input aria-label={g.name} aria-valuetext={GENE_LEVELS[geneLevelIndex(draftGenes[g.id])].label} type="range" min="0" max="2" step="1" disabled={view?.status === 'running'} value={geneLevelIndex(draftGenes[g.id])} style={{ accentColor: g.color }} onChange={e => setGenes({ ...draftGenes, [g.id]: GENE_LEVELS[+e.target.value].value })} /><div className="ge-ticks" aria-hidden="true">{GENE_LEVELS.map(level => <span key={level.id} className={nextPolicy.levels[g.id] === level.id ? 'ge-tick-active' : ''}>{level.label}</span>)}</div></div>)}</div>
      {helpGene && <section className="ge-help" id={helpPanelId} aria-label={`${helpGene.name}工作逻辑`}>
        <header><strong>{helpGene.code} {helpGene.name} · 工作逻辑</strong><button type="button" aria-label="收起工作逻辑" onClick={() => setHelpGeneId(null)}>×</button></header>
        <ol className="ge-levels">{GENE_LEVELS.map((level, index) => <li key={level.id} data-level={level.id} className={nextPolicy.levels[helpGene.id] === level.id ? 'ge-level-active' : ''}><span>{level.label}{nextPolicy.levels[helpGene.id] === level.id && <b>当前</b>}</span><div>{help.tiers[index]}</div></li>)}</ol>
        <p>{help.note || '当前会话通过模型指令调整这项回答偏好。'}</p>
        <details><summary>将应用的指令</summary><p className="ge-directive">{nextPolicy.preferences[helpGene.id]}</p></details>
      </section>}
      <div className="ge-buttons"><button disabled={busy || !view || view.status === 'running'} onClick={() => call('apply')}>应用到当前会话</button><button disabled={busy || !view?.run?.enabled || view.run.historicalReadOnly || view.status === 'running'} onClick={() => call('stop')}>停用 Gene</button></div>
      {error && <p role="alert" className="ge-error">{error}</p>}
    </section>}
  </span>;
}
const css = `
.ge-root{position:relative}.ge-trigger{font-size:12px}
.ge-panel{position:fixed;right:24px;top:70px;width:min(480px,calc(100vw - 48px));box-sizing:border-box;max-height:calc(100vh - 96px);overflow:auto;z-index:1000;background:var(--background,#17201e);color:var(--foreground,#edf3ed);border:1px solid #527364;border-radius:14px;padding:20px;box-shadow:0 18px 60px #0008;font:13px system-ui}
.ge-panel header{display:flex;justify-content:space-between;align-items:center;gap:12px}.ge-panel h2{margin:0;font-size:24px}.ge-panel p{line-height:1.6;opacity:.85}
.ge-panel button{padding:7px 9px;border:1px solid #567266;border-radius:6px;background:transparent;color:inherit;cursor:pointer}.ge-panel button:focus-visible,.ge-panel input:focus-visible,.ge-panel summary:focus-visible{outline:2px solid #9ed2bb;outline-offset:3px}
.ge-panel button:disabled{opacity:.4;cursor:default}
.ge-settings{display:flex;align-items:center;margin-top:18px;color:#b5c5bd}
.ge-genes{display:grid;grid-template-columns:1fr 1fr;gap:18px 22px;margin:22px 0}.ge-gene{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px}.ge-gene-name{display:flex;align-items:center;gap:7px;white-space:nowrap}.ge-gene input{grid-column:span 2;width:100%;margin:0}.ge-gene b{font-weight:500;margin-left:4px}.ge-gene output{color:#c2cfc7;font-variant-numeric:tabular-nums}
.ge-ticks{grid-column:span 2;display:flex;justify-content:space-between;color:#93a59b;font-size:11px;line-height:1;margin-top:-2px}.ge-tick-active{color:#d2f4e0;font-weight:600}
.ge-panel .ge-info{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:22px;height:22px;border-radius:50%;padding:0;color:#b8d0c3;font:italic 13px Georgia,serif}.ge-info:hover,.ge-info[aria-expanded=true]{background:#9ed2bb20;border-color:#9ed2bb;color:#e5fff1}
.ge-help{border:1px solid #527364;border-radius:9px;padding:12px;margin:0 0 18px;background:#a1c7b308}.ge-help header{font-size:13px}.ge-help header button{border:0;padding:0 5px;font-size:18px}.ge-help p{font-size:12px;margin:9px 0}.ge-levels{list-style:none;padding:0;margin:12px 0;display:grid;gap:4px}.ge-levels li{display:grid;grid-template-columns:38px 1fr;gap:8px;padding:8px;border-left:2px solid transparent;border-radius:4px;font-size:12px;line-height:1.55}.ge-levels li>span{font-size:11px;color:#b5c5bd}.ge-levels b{display:block;font-size:11px;color:#c4f2d9;font-weight:500}.ge-level-active{background:#9ed2bb14;border-left-color:#9ed2bb!important}.ge-help details{font-size:12px;margin-top:10px}.ge-help summary{cursor:pointer;color:#b5c5bd}.ge-help .ge-directive{overflow-wrap:anywhere;background:#0002;padding:8px;border-radius:5px}
.ge-applied{margin-left:10px;color:#c4f2d9;font-size:11px}.ge-buttons{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0 0}.ge-error{color:#f3a39a!important}
@media(max-width:440px){.ge-panel{right:12px;width:calc(100vw - 24px);padding:16px}.ge-genes{column-gap:12px}.ge-gene-name{gap:4px}}
`;
export function apply(ctx) {
  ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); return () => style.remove(); });
  async function execute(sessionId, input) {
    const response = await ctx.remote.commands.execute(sessionId, `/gene ${JSON.stringify(input)}`, []);
    if (!response.ok) throw new Error(response.error?.message || 'Command transport failed.');
    const result = response.value?.result;
    if (result?.kind !== 'success') throw new Error(result?.text || 'Gene command unavailable.');
    return JSON.parse(result.text);
  }
  for (const name of ['conversation.session.header.actions', 'conversation.hero.options']) ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'gene-editing', order: 35, inject: () => ({ execute }) }, GenePanel));
}
