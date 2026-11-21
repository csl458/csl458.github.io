// The brain atlas: each region of the head is one mechanism of a multi-agent system, with a lab panel.
import { routeScores } from './sim.js';
import { renderMemoryLab, bindMemoryLab } from './memory-lab.js';
import { renderOrchLab, bindOrchLab } from './orch-lab.js';
import { renderToolsLab, bindToolsLab } from './tools-lab.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const REGIONS = [
  {
    id: 'router', pos: [0, 0.18, -0.05], color: '#4ff0ff', lab: '02', status: 'live',
    organ: { zh: '丘脑', en: 'Thalamus' }, name: { zh: '路由', en: 'Router' },
    lead: { zh: '每个问题进来，先经过这里：给每个人格打分，softmax 成权重，决定谁先发言、谁说了算。', en: 'Every question passes through here first: each voice gets a score, softmax turns scores into weights, and the weights decide who speaks first and whose take wins.' },
  },
  {
    id: 'memory', pos: [0.4, -0.08, -0.08], color: '#ffc24a', lab: '03', status: 'live',
    organ: { zh: '海马体', en: 'Hippocampus' }, name: { zh: '记忆', en: 'Memory' },
    lead: { zh: '大脑怎么记住、想起、遗忘和整理：向量检索唤起相似的过去，遗忘曲线让旧记忆褪色，工作记忆在超出预算时压缩，深夜做梦把重复的记忆提炼成洞见。', en: 'How the mind remembers, recalls, forgets and consolidates: vector search brings back similar pasts, a forgetting curve fades old memories, working memory compacts when it runs over budget, and dreams distil repeats into insights.' },
  },
  {
    id: 'orchestration', pos: [0, 0.52, 0.55], color: '#5dffa0', lab: '04', status: 'live',
    organ: { zh: '前额叶', en: 'Prefrontal cortex' }, name: { zh: '编排', en: 'Orchestration' },
    lead: { zh: '决定会议怎么开：谁先、谁并行、谁读谁的输出、怎么收敛。五种编排拓扑，每一种都真的能跑，可以切换、看执行图、做 A/B 对比。', en: 'Decides how the meeting runs: who goes first, who runs in parallel, who reads whose output, how it converges. Five real orchestration topologies to switch between, inspect as a graph, and A/B compare.' },
  },
  {
    id: 'tools', pos: [0, -0.42, -0.55], color: '#ff9b4a', lab: '05', status: 'live',
    organ: { zh: '小脑', en: 'Cerebellum' }, name: { zh: '工具', en: 'Tools' },
    lead: { zh: '让人格伸出触须，抓取头外的工具。五个真实工具绕着头飘浮：GitHub、维基百科、天气、计算器、世界时钟。会议开始前先取证，结果进入每个人格的上下文和最终答案；Claude 大脑模式下是真正的 tool use 循环。', en: 'Lets voices reach outside the head. Five real tools float around it: GitHub, Wikipedia, weather, a calculator and a world clock. Facts are gathered before the meeting and flow into every voice\'s context and the answer; with the Claude brain it is a real tool-use loop.' },
  },
  {
    id: 'critic', pos: [-0.34, -0.12, 0.32], color: '#ff5470', lab: '06', status: 'next',
    organ: { zh: '杏仁核', en: 'Amygdala' }, name: { zh: '评审', en: 'Critic' },
    lead: { zh: '答案出口前的免疫系统：对照记忆里的事实打分，标出可能编造的句子。', en: 'The immune system at the exit: scores the answer against remembered facts and flags anything that might be made up.' },
  },
  {
    id: 'trace', pos: [0, 0.3, -0.88], color: '#a98bff', lab: '07', status: 'live',
    organ: { zh: '枕叶', en: 'Occipital lobe' }, name: { zh: '可观测性', en: 'Observability' },
    lead: { zh: '大脑看见自己：每场会议都留下完整的 trace，可以回放、可以导出。', en: 'The mind watching itself: every meeting leaves a full trace you can replay or export.' },
  },
];

const L = {
  zh: { live: '运行中', next: '建造中', lab: 'LAB', try: '试一试：输入任何问题，看路由怎么分配', temp: '温度', topk: 'Top-k', cat: '意图', lead: '主导', facts: '语义记忆 · 关于主人', episodes: '情景记忆 · 过去的会议', none: '还没有会议。问点什么吧。', forget: '清空情景记忆', ctx: '工作记忆', phases: '上一场会议的阶段耗时', noRun: '还没有跑过会议。', replay: '▶ 回放上一场', export: '⤓ 导出 JSON', events: '事件', mode: '大脑', planned: '计划中的工具', plannedCritic: '计划中的检查', sim: '模拟', liveBrain: 'Claude', voices: '人格', durations: '总耗时', since: '前' },
  en: { live: 'Live', next: 'Building', lab: 'LAB', try: 'Try it: type any question and watch the routing', temp: 'Temperature', topk: 'Top-k', cat: 'Intent', lead: 'Lead', facts: 'Semantic memory · facts about the owner', episodes: 'Episodic memory · past meetings', none: 'No meetings yet. Ask something.', forget: 'Forget episodes', ctx: 'Working memory', phases: 'Phase timings of the last meeting', noRun: 'No meeting has run yet.', replay: '▶ Replay last meeting', export: '⤓ Export JSON', events: 'events', mode: 'Brain', planned: 'Planned tools', plannedCritic: 'Planned checks', sim: 'Simulated', liveBrain: 'Claude', voices: 'voices', durations: 'Total', since: 'ago' },
};

function ago(ts, lang) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  const [v, u] = s < 60 ? [s, lang === 'zh' ? '秒' : 's'] : s < 3600 ? [Math.round(s / 60), lang === 'zh' ? '分钟' : 'm'] : s < 86400 ? [Math.round(s / 3600), lang === 'zh' ? '小时' : 'h'] : [Math.round(s / 86400), lang === 'zh' ? '天' : 'd'];
  return lang === 'zh' ? `${v}${u}前` : `${v}${u} ago`;
}

function bars(weights, agents, lang, topk) {
  const sorted = Object.entries(weights).sort((a, b) => b[1] - a[1]);
  return sorted.map(([id, w], i) => {
    const a = agents.find((x) => x.id === id); if (!a) return '';
    const on = i < topk;
    return `<div class="wrow${on ? ' on' : ''}"><span style="color:${a.color}">${esc(a.glyph)} ${esc(a.name[lang])}</span><span class="bar"><i style="width:${(w * 100).toFixed(1)}%;background:${a.color}"></i></span><b>${(w * 100).toFixed(0)}%</b></div>`;
  }).join('');
}

export function renderLab(region, lang, ctx) {
  const t = L[lang];
  const head = `<div class="lab-head" style="--rc:${region.color}">
    <div class="lab-kicker">${t.lab} ${region.lab} · ${esc(region.organ[lang])} <span class="lab-status ${region.status}">${region.status === 'live' ? t.live : t.next}</span></div>
    <h2>${esc(region.name[lang])}</h2><p>${esc(region.lead[lang])}</p></div>`;
  let body = '';
  if (region.id === 'router') {
    const q = ctx.lastQuestion || (lang === 'zh' ? '你是谁？' : 'Who are you?');
    body = `<label class="lab-label">${t.try}</label>
      <input class="lab-input" id="rt-q" value="${esc(q)}" maxlength="200" />
      <div class="lab-sliders"><label>${t.temp} <output id="rt-tv">0.7</output><input type="range" id="rt-t" min="0.1" max="2" step="0.05" value="0.7"></label>
      <label>${t.topk} <output id="rt-kv">3</output><input type="range" id="rt-k" min="1" max="${Math.max(1, ctx.agents.length - 1)}" step="1" value="3"></label></div>
      <div class="lab-meta" id="rt-meta"></div><div class="weights" id="rt-w"></div>`;
  } else if (region.id === 'memory') {
    body = renderMemoryLab(lang, ctx);
  } else if (region.id === 'orchestration') {
    body = renderOrchLab(lang, ctx);
  } else if (region.id === 'trace') {
    const tr = ctx.lastTrace;
    if (!tr) body = `<p class="muted">${t.noRun}</p>`;
    else {
      const rows = tr.events.filter((e) => e.type !== 'thinking').slice(0, 60).map((e) => {
        const a = ctx.agents.find((x) => x.id === e.from);
        const label = e.type === 'phase' ? `<b>${esc(ctx.phaseName(e.key))}</b>` : e.type === 'vote' ? `${esc(a?.name[lang] || e.from)} → ${esc(ctx.agents.find((x) => x.id === e.for)?.name[lang] || e.for)}` : `<span style="color:${a?.color || '#fff'}">${esc(a?.name[lang] || e.from || 'Self')}</span> ${esc((e.text || '').slice(0, 48))}${(e.text || '').length > 48 ? '…' : ''}`;
        return `<li><code>${((e.t - tr.start) / 1000).toFixed(2)}s</code><span class="ty">${e.type}</span>${label}</li>`;
      }).join('');
      body = `<p class="muted">“${esc(tr.q)}” · ${tr.events.length} ${t.events}</p><ol class="trace">${rows}</ol>
        <div class="lab-actions"><button class="primary tiny" id="tr-replay">${t.replay}</button><button class="ghost tiny" id="tr-export">${t.export}</button></div>`;
    }
  } else if (region.id === 'tools') {
    body = renderToolsLab(lang, ctx);
  } else if (region.id === 'critic') {
    const items = lang === 'zh' ? ['对照语义记忆核对每句话', '给答案一个置信度', '高亮可能编造的内容', '必要时打回重开会议'] : ['Check every sentence against semantic memory', 'Give the answer a confidence score', 'Highlight anything that may be invented', 'Send it back for another meeting if needed'];
    body = `<h3>${t.plannedCritic}</h3><ul class="planned">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  }
  return head + `<div class="lab-body">${body}</div>`;
}

export function bindLab(root, region, lang, ctx) {
  if (region.id === 'router') {
    const q = root.querySelector('#rt-q'), tS = root.querySelector('#rt-t'), kS = root.querySelector('#rt-k');
    const draw = () => {
      const temp = +tS.value, k = +kS.value;
      root.querySelector('#rt-tv').textContent = temp.toFixed(2);
      root.querySelector('#rt-kv').textContent = k;
      const r = routeScores(q.value || '?', ctx.agents, temp);
      const leadA = ctx.agents.find((a) => a.id === r.lead);
      root.querySelector('#rt-meta').innerHTML = `${L[lang].cat}: <b>${esc(r.cat)}</b>${leadA ? ` · ${L[lang].lead}: <b style="color:${leadA.color}">${esc(leadA.name[lang])}</b>` : ''}`;
      root.querySelector('#rt-w').innerHTML = bars(r.weights, ctx.agents, lang, k);
      ctx.onRoute?.(r.weights, k);
    };
    q.addEventListener('input', draw); tS.addEventListener('input', draw); kS.addEventListener('input', draw);
    draw();
  }
  if (region.id === 'memory') bindMemoryLab(root, lang, ctx);
  if (region.id === 'orchestration') bindOrchLab(root, lang, ctx);
  if (region.id === 'tools') bindToolsLab(root, lang, ctx);
  root.querySelector('#tr-replay')?.addEventListener('click', () => ctx.onReplay?.());
  root.querySelector('#tr-export')?.addEventListener('click', () => ctx.onExport?.());
}
