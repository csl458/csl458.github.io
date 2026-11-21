// LAB 05 · Cerebellum — the Tools lab panel.
import { TOOLS, TOOL_BY_ID, planTools, toolLog } from './tools.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cut = (s, n) => { const a = [...String(s)]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };

const L = {
  zh: {
    s1: '① 工具箱', s1hint: '五个真实工具，都从你的浏览器直接调用公开接口，不经过任何服务器、不需要 key。每个工具都附带一份 Claude 工具定义（JSON Schema），Claude 大脑模式下就是用它做真正的 tool use。',
    owner: '常用者', schema: 'Claude 工具定义', input: '输入', run: '▶ 调用', running: '调用中…', ms: '毫秒',
    s2: '② 工具路由', s2hint: '模拟大脑用规则决定一个问题需要哪些工具；Claude 大脑则由 Claude 自己决定调不调、调哪个、传什么参数。试试：「悉尼天气怎么样」「123*456 等于多少」「什么是强化学习」「东京现在几点」「你在做什么项目」。',
    none: '这个问题不需要工具。', calls: '会调用',
    s3: '③ 调用记录', s3hint: '这次访问里所有的工具调用：会议中的、Claude 发起的、以及你在上面手动试的。', empty: '还没有调用。',
    origin: { meeting: '会议', claude: 'Claude', lab: '手动' },
  },
  en: {
    s1: '① Toolbox', s1hint: 'Five real tools, called straight from your browser to public APIs: no server in between, no keys. Each carries a Claude tool definition (JSON Schema); with the Claude brain, that is what real tool use runs on.',
    owner: 'Usually used by', schema: 'Claude tool definition', input: 'Input', run: '▶ Call', running: 'Calling…', ms: 'ms',
    s2: '② Tool routing', s2hint: 'The simulated brain decides with rules which tools a question needs; the Claude brain lets Claude decide whether to call, which tool, and with what arguments. Try: "What\'s the weather in Sydney", "123*456", "what is reinforcement learning", "what time is it in Tokyo", "what are you working on".',
    none: 'No tools needed for this one.', calls: 'Would call',
    s3: '③ Call log', s3hint: 'Every tool call in this visit: from meetings, initiated by Claude, or tried by hand above.', empty: 'No calls yet.',
    origin: { meeting: 'meeting', claude: 'Claude', lab: 'manual' },
  },
};

function logHTML(lang) {
  const t = L[lang];
  if (!toolLog.length) return `<p class="muted">${t.empty}</p>`;
  return `<ul class="tlog">${toolLog.slice(0, 12).map((e) => {
    const tl = TOOL_BY_ID[e.tool];
    return `<li class="${e.ok ? '' : 'bad'}"><b style="color:${tl.color}">${esc(tl.icon)}</b><div><p>${esc(cut(e.summary, 90))}</p><small>${esc(tl.def.name)}(${esc(cut(JSON.stringify(e.input || {}), 50))}) · ${e.ms}${t.ms} · ${t.origin[e.origin] || e.origin}</small></div><em>${e.ok ? '✓' : '✗'}</em></li>`;
  }).join('')}</ul>`;
}

export function renderToolsLab(lang, ctx) {
  const t = L[lang];
  const cards = TOOLS.map((tl) => {
    const owner = ctx.agents.find((a) => a.id === tl.owner);
    const sample = JSON.stringify(tl.sample(lang));
    return `<div class="toolcard${ctx.focusId === 'tool_' + tl.id ? ' focus' : ''}" style="--tc:${tl.color}" data-tool="${tl.id}">
      <div class="th"><b>${esc(tl.icon)}</b><div><strong>${esc(tl.name[lang])}</strong><code>${esc(tl.def.name)}</code></div>${owner ? `<span class="own" style="color:${owner.color}">${esc(owner.glyph)} ${esc(owner.name[lang])}</span>` : ''}</div>
      <p>${esc(tl.desc[lang])}</p>
      <details><summary>${t.schema}</summary><pre>${esc(JSON.stringify(tl.def, null, 2))}</pre></details>
      <div class="tryrow"><input class="lab-input" value="${esc(sample)}" spellcheck="false" aria-label="${t.input}" /><button class="primary tiny" type="button">${t.run}</button></div>
      <div class="tout"></div>
    </div>`;
  }).join('');
  return `
    <h3>${t.s1}</h3><p class="hint">${t.s1hint}</p><div class="toolcards">${cards}</div>
    <h3>${t.s2}</h3><p class="hint">${t.s2hint}</p>
    <input class="lab-input" id="tr-q" value="${esc(ctx.lastQuestion || (lang === 'zh' ? '悉尼天气怎么样？' : 'What\'s the weather in Sydney?'))}" maxlength="200" />
    <div id="tr-plan" class="tplan"></div>
    <h3>${t.s3}</h3><p class="hint">${t.s3hint}</p><div id="tr-log">${logHTML(lang)}</div>`;
}

export function bindToolsLab(root, lang, ctx) {
  const t = L[lang];
  root.querySelectorAll('.toolcard').forEach((card) => {
    const id = card.dataset.tool, tl = TOOL_BY_ID[id];
    const btn = card.querySelector('button'), inp = card.querySelector('input'), out = card.querySelector('.tout');
    const go = async () => {
      let input;
      try { input = JSON.parse(inp.value || '{}'); } catch { out.innerHTML = `<p class="err">JSON ✗</p>`; return; }
      btn.disabled = true; btn.textContent = t.running;
      const r = await ctx.onTryTool(id, input);
      btn.disabled = false; btn.textContent = t.run;
      out.innerHTML = `<p class="${r.ok ? 'ok' : 'err'}">${r.ok ? '✓' : '✗'} ${esc(r.summary)} <small>${r.ms}${t.ms}</small></p><details><summary>tool_result</summary><pre>${esc(JSON.stringify(r.ok ? r.data : { error: r.summary }, null, 2).slice(0, 2400))}</pre></details>`;
      root.querySelector('#tr-log').innerHTML = logHTML(lang);
    };
    btn.addEventListener('click', go);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  });
  const q = root.querySelector('#tr-q'), plan = root.querySelector('#tr-plan');
  let timer;
  const route = () => {
    const p = planTools(q.value, ctx.owner);
    plan.innerHTML = p.length
      ? `<span>${t.calls}</span>` + p.map((x) => { const tl = TOOL_BY_ID[x.tool]; return `<code style="--tc:${tl.color}">${esc(tl.icon)} ${esc(tl.def.name)}(${esc(JSON.stringify(x.input))})</code>`; }).join('')
      : `<span class="muted">${t.none}</span>`;
    for (const x of p) ctx.onPreviewTool?.(x.tool);
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(route, 180); });
  route();
  root.querySelector('.toolcard.focus')?.scrollIntoView({ block: 'center' });
}
