// LAB 04 · Prefrontal cortex — the Orchestration lab panel.
import { TOPOLOGIES, TOPOLOGY_IDS, buildDag, dagMetrics, dagSVG, topologyGlyph, phaseLabel } from './orchestration.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cut = (s, n) => { const a = [...String(s)]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };

const L = {
  zh: {
    s1: '① 编排拓扑', s1hint: '同一群人格，换一种组织方式，就是另一个大脑。选中后，下一次提问就按它来跑（模拟大脑和 Claude 大脑都支持）。',
    current: '当前',
    s2: '② 上一场的执行图', s2hint: '每个点是一次发言（菱形是委派），箭头是“谁读了谁的输出”。高亮的是关键路径：决定了整场会议最少要几步。',
    none: '还没有开过会。选一个拓扑，然后问点什么。',
    m: { nodes: '节点', depth: '深度', width: '最大并行', messages: '消息', tokens: 'tokens', voices: '参与人格', votes: '投票' },
    crit: '关键路径', timing: '各阶段耗时', mode: '大脑', sim: '模拟', live: 'Claude', replay: 'replay',
    s3: '③ A/B 对比', s3hint: '用模拟大脑把同一个问题按两种拓扑各跑一遍（即时，不花钱），对比执行图和指标。',
    run: '▶ 运行对比', q: '问题', better: '更少', answer: '答案',
  },
  en: {
    s1: '① Topology', s1hint: 'Same voices, organised differently, is a different mind. The one you pick runs your next question (with the simulated brain or Claude).',
    current: 'current',
    s2: '② Last meeting\'s execution graph', s2hint: 'Each dot is one message (diamonds are dispatches); an edge means "read that output". The highlighted edges are the critical path: the fewest steps the meeting could have taken.',
    none: 'No meeting yet. Pick a topology and ask something.',
    m: { nodes: 'nodes', depth: 'depth', width: 'max parallel', messages: 'messages', tokens: 'tokens', voices: 'voices', votes: 'votes' },
    crit: 'Critical path', timing: 'Phase timings', mode: 'Brain', sim: 'simulated', live: 'Claude', replay: 'replay',
    s3: '③ A/B compare', s3hint: 'Runs the same question through two topologies with the simulated brain (instant, free) and compares the graphs and numbers.',
    run: '▶ Compare', q: 'Question', better: 'lower', answer: 'Answer',
  },
};

function metricsRow(m, t) {
  return `<div class="mstats six">${['nodes', 'depth', 'width', 'messages', 'tokens', 'voices'].map((k) => `<div><b>${m[k]}</b><span>${t.m[k]}</span></div>`).join('')}</div>`;
}

export function renderOrchLab(lang, ctx) {
  const t = L[lang];
  const cards = TOPOLOGY_IDS.map((k) => {
    const T = TOPOLOGIES[k], on = ctx.topology === k;
    return `<button class="tcard${on ? ' on' : ''}" data-topo="${k}" type="button">${topologyGlyph(k)}<b>${T.icon} ${esc(T.name[lang])}${on ? ` <em>${t.current}</em>` : ''}</b><span>${esc(T.desc[lang])}</span></button>`;
  }).join('');

  let last = `<p class="muted">${t.none}</p>`;
  const tr = ctx.lastTrace;
  if (tr) {
    const dag = buildDag(tr.events), m = dagMetrics(dag, tr.events);
    const phases = TOPOLOGIES[tr.topology || 'council'].phases;
    const dur = {}; let prev = null;
    for (const e of tr.events) if (e.type === 'phase') { if (prev) dur[prev.key] = e.t - prev.t; prev = e; }
    if (prev) dur[prev.key] = tr.end - prev.t;
    const total = Object.values(dur).reduce((s, v) => s + v, 0) || 1;
    const name = (id) => ctx.agents.find((a) => a.id === id)?.name[lang] || id;
    const crit = dag.nodes.filter((n) => dag.crit.has(n.id)).map((n) => `<span style="color:${ctx.agents.find((a) => a.id === n.agent)?.color || '#fff'}">${esc(name(n.agent))}</span>`).join(' → ');
    last = `<p class="muted">“${esc(cut(tr.q, 40))}” · ${TOPOLOGIES[tr.topology || 'council'].icon} ${esc(TOPOLOGIES[tr.topology || 'council'].name[lang])} · ${t.mode}: ${tr.mode === 'live' ? t.live : tr.mode === 'replay' ? t.replay : t.sim}</p>
      ${dagSVG(dag, ctx.agents, { width: 400 })}
      ${metricsRow(m, t)}
      <p class="crit"><b>${t.crit}</b> ${crit}</p>
      <h3>${t.timing}</h3>
      <div class="pipeline">${phases.map((k) => `<div class="node">${esc(phaseLabel(k, lang))}<small>${dur[k] ? (dur[k] / 1000).toFixed(1) + 's' : '—'}</small></div>`).join('<i>→</i>')}</div>
      <div class="gantt">${phases.map((k) => `<span style="flex:${(dur[k] || 0) / total}" title="${esc(phaseLabel(k, lang))}"></span>`).join('')}</div>`;
  }

  const opt = (sel) => TOPOLOGY_IDS.map((k) => `<option value="${k}"${k === sel ? ' selected' : ''}>${TOPOLOGIES[k].icon} ${esc(TOPOLOGIES[k].name[lang])}</option>`).join('');
  const other = TOPOLOGY_IDS.find((k) => k !== ctx.topology && k !== 'council') || 'hierarchy';
  return `
    <h3>${t.s1}</h3><p class="hint">${t.s1hint}</p><div class="tcards">${cards}</div>
    <h3>${t.s2}</h3><p class="hint">${t.s2hint}</p>${last}
    <h3>${t.s3}</h3><p class="hint">${t.s3hint}</p>
    <input class="lab-input" id="ab-q" value="${esc(ctx.lastQuestion || (lang === 'zh' ? '我该辞职去创业吗？' : 'Should I quit my job to start a company?'))}" maxlength="200" />
    <div class="abpick"><select id="ab-a" class="lab-input">${opt(ctx.topology)}</select><span>vs</span><select id="ab-b" class="lab-input">${opt(other)}</select></div>
    <div class="lab-actions"><button class="primary tiny" id="ab-run" type="button">${t.run}</button></div>
    <div id="ab-out" class="abgrid"></div>`;
}

export function bindOrchLab(root, lang, ctx) {
  const t = L[lang];
  root.querySelectorAll('[data-topo]').forEach((b) => b.addEventListener('click', () => ctx.onTopology?.(b.dataset.topo)));
  const run = async () => {
    const q = root.querySelector('#ab-q').value.trim(); if (!q) return;
    const kinds = [root.querySelector('#ab-a').value, root.querySelector('#ab-b').value];
    const res = await ctx.onCompare(q, kinds);
    const keys = ['nodes', 'depth', 'width', 'messages', 'tokens', 'voices'];
    const lowerBetter = new Set(['depth', 'messages', 'tokens']);
    const best = (k) => { const v = res.map((r) => r.metrics[k]); return lowerBetter.has(k) ? Math.min(...v) : Math.max(...v); };
    root.querySelector('#ab-out').innerHTML = res.map((r) => `
      <div class="abcol"><b>${TOPOLOGIES[r.kind].icon} ${esc(TOPOLOGIES[r.kind].name[lang])}</b>
        ${dagSVG(r.dag, ctx.agents, { width: 200, mini: true })}
        <table>${keys.map((k) => `<tr class="${k !== 'nodes' && res[0].metrics[k] !== res[1].metrics[k] && r.metrics[k] === best(k) ? 'win' : ''}"><td>${t.m[k]}</td><td>${r.metrics[k]}</td></tr>`).join('')}</table>
        <p><em>${t.answer}</em>${esc(cut(r.answer, 90))}</p></div>`).join('');
  };
  root.querySelector('#ab-run')?.addEventListener('click', run);
}
