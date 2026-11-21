// LAB 03 · Hippocampus — the Memory lab panel.
import { ago, WM_BUDGET } from './memory.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cut = (s, n) => { const a = [...String(s)]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
const HOUR = 3600e3;

const L = {
  zh: {
    stats: ['情景记忆', '洞见', '平均保持率', '上次做梦'], never: '从未',
    s1: '① 检索 · 向量相似度', s1hint: '输入任何一句话，看大脑会想起哪些过去的会议。新问题进来时，相似度 ≥ 22% 的记忆会自动浮现并交给「记忆」。',
    s1ph: '比如：你是谁 / AI 有意识吗', s1none: '还没有可检索的记忆。先问大脑几个问题吧。', s1empty: '没有足够相似的记忆。',
    sim: '相似', keep: '保持',
    s2: '② 工作记忆 · 上下文预算', s2hint: `一场会议最多容纳 ${WM_BUDGET} tokens。超出时，最早的发言会被压缩成一条摘要（问题本身始终保留）。Claude 大脑模式下，「自我」读到的正是压缩后的版本。`,
    s2none: '还没有开过会。', peak: '峰值', comp: '压缩', times: '次', now: '当前内容',
    s3: '③ 情景记忆 · 遗忘曲线', s3hint: '每场会议凝结成一颗绕头旋转的晶体。保持率 R = e^(−Δt / S)：新记忆 S = 6 小时，每被想起一次 S 翻倍（间隔效应）。保持率低于 4% 的晶体会熄灭。',
    recalls: '次唤起', hrs: '小时',
    s4: '④ 语义记忆 · 知识图谱', s4hint: '关于主人的事实（来自 config.js），以及做梦整理出的洞见（金色）。',
    s5: '⑤ 做梦 · 记忆整理', s5hint: '悉尼深夜（01:00–07:00）且新增 ≥ 3 段记忆时会自动做梦：把相似的记忆聚成一组，提炼成一条洞见，并加固被保留的记忆。Claude 大脑模式下，洞见由 Claude 撰写。',
    dream: '☾ 现在做梦', noIns: '还没有洞见。', forget: '清空全部长期记忆',
  },
  en: {
    stats: ['Episodes', 'Insights', 'Avg retention', 'Last dream'], never: 'never',
    s1: '① Retrieval · vector similarity', s1hint: 'Type anything and see which past meetings the mind recalls. When a new question arrives, memories ≥ 22% similar surface on their own and go to Memory.',
    s1ph: 'e.g. who are you / can AI be conscious', s1none: 'Nothing to search yet. Ask the mind a few questions first.', s1empty: 'Nothing similar enough.',
    sim: 'sim', keep: 'kept',
    s2: '② Working memory · context budget', s2hint: `A meeting holds at most ${WM_BUDGET} tokens. Past that, the oldest lines are folded into a summary (the question itself is pinned). With the Claude brain, Self reads exactly this compacted version.`,
    s2none: 'No meeting yet.', peak: 'Peak', comp: 'Compactions', times: '', now: 'Current contents',
    s3: '③ Episodic memory · forgetting curve', s3hint: 'Each meeting crystallises into a crystal orbiting the head. Retention R = e^(−Δt / S): a new memory starts with S = 6 h, and every recall doubles S (the spacing effect). Below 4% the crystal goes dark.',
    recalls: 'recalls', hrs: 'h',
    s4: '④ Semantic memory · knowledge graph', s4hint: 'Facts about the owner (from config.js), plus insights distilled while dreaming (gold).',
    s5: '⑤ Dreaming · consolidation', s5hint: 'Late at night in Sydney (01:00–07:00), once ≥ 3 new memories exist, the mind dreams: similar memories are grouped, each group is distilled into an insight, and what was kept gets stronger. With the Claude brain, Claude writes the insights.',
    dream: '☾ Dream now', noIns: 'No insights yet.', forget: 'Forget all long-term memory',
  },
};

function colorOf(ctx, id) { return ctx.agents.find((a) => a.id === id)?.color || '#ffc24a'; }

function wmChart(snap, lang) {
  const W = 380, H = 96, P = 6;
  const tl = snap.timeline, n = Math.max(2, tl.length);
  const max = Math.max(snap.budget * 1.15, ...tl.map((p) => p.total));
  const x = (i) => P + (i / (n - 1)) * (W - 2 * P), y = (v) => H - P - (v / max) * (H - 2 * P);
  const pts = tl.map((p, i) => `${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join(' ');
  const marks = tl.map((p, i) => (p.compact ? `<line x1="${x(i)}" x2="${x(i)}" y1="${P}" y2="${H - P}" class="cmark"/><circle cx="${x(i)}" cy="${y(p.total)}" r="3.5" class="cdot"/>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="working memory over the meeting">
    <line x1="${P}" x2="${W - P}" y1="${y(snap.budget)}" y2="${y(snap.budget)}" class="budget"/>
    <text x="${W - P}" y="${y(snap.budget) - 4}" class="ctext" text-anchor="end">${lang === 'zh' ? '预算' : 'budget'} ${snap.budget}</text>
    <polyline points="${P},${H - P} ${pts} ${x(tl.length - 1)},${H - P}" class="area"/>
    <polyline points="${pts}" class="line"/>${marks}</svg>`;
}

function forgetChart(store, ctx, lang) {
  const W = 380, H = 130, P = 8, now = Date.now();
  const eps = store.episodes.slice(-12);
  const start = Math.min(now - 2 * HOUR, ...eps.map((e) => e.seen || e.ts)), end = now + 24 * HOUR;
  const x = (t) => P + ((t - start) / (end - start)) * (W - 2 * P), y = (r) => H - P - r * (H - 2 * P - 10);
  const curves = eps.map((e) => {
    const S = (e.s || 6) * HOUR, t0 = e.seen || e.ts, c = colorOf(ctx, e.winner);
    const pts = [];
    for (let k = 0; k <= 40; k++) { const t = t0 + (k / 40) * (end - t0); pts.push(`${x(t).toFixed(1)},${y(Math.exp(-(t - t0) / S)).toFixed(1)}`); }
    const r = store.retention(e, now);
    return `<polyline points="${pts.join(' ')}" class="fc" style="stroke:${c}"/><circle cx="${x(now)}" cy="${y(r)}" r="3" style="fill:${c}"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="forgetting curves">
    <line x1="${x(now)}" x2="${x(now)}" y1="${P}" y2="${H - P}" class="nowline"/>
    <text x="${x(now) + 4}" y="${P + 10}" class="ctext">${lang === 'zh' ? '现在' : 'now'}</text>
    <text x="${W - P}" y="${H - P - 4}" class="ctext" text-anchor="end">+24${lang === 'zh' ? '小时' : 'h'}</text>
    <line x1="${P}" x2="${W - P}" y1="${y(0.04)}" y2="${y(0.04)}" class="budget"/>
    ${curves}</svg>`;
}

function graph(store, ctx, lang) {
  const W = 380, H = 280, cx = W / 2, cy = H / 2;
  const facts = ctx.facts.flatMap(([k, v]) => (/[、,，]/.test(v) && k !== 'GitHub' ? v.split(/[、,，]\s*/).map((p) => [k, p.replace(/^(以及|and)\s*/, '')]) : [[k, v]]));
  const ins = store.insights.slice(-8);
  let s = '';
  const nodes = [];
  facts.forEach(([k, v], i) => {
    const a = (i / facts.length) * Math.PI * 2 - Math.PI / 2;
    nodes.push({ x: cx + Math.cos(a) * 92, y: cy + Math.sin(a) * 78, t: cut(v, 12), k, c: '#7fd8ff' });
  });
  ins.forEach((it, i) => {
    const a = (i / Math.max(1, ins.length)) * Math.PI * 2 - Math.PI / 2 + 0.3;
    const host = nodes.length ? nodes[i % nodes.length] : { x: cx, y: cy };
    nodes.push({ x: cx + Math.cos(a) * 150, y: cy + Math.sin(a) * 118, t: cut((it.kw || []).join(' · ') || it.text, 12), c: '#ffd98a', from: host, ins: true, title: it.text });
  });
  for (const n of nodes) {
    const f = n.from || { x: cx, y: cy };
    s += `<line x1="${f.x}" y1="${f.y}" x2="${n.x}" y2="${n.y}" class="edge${n.ins ? ' ins' : ''}"/>`;
  }
  for (const n of nodes) {
    s += `<g><title>${esc(n.title || `${n.k}: ${n.t}`)}</title><circle cx="${n.x}" cy="${n.y}" r="${n.ins ? 4 : 5}" style="fill:${n.c}"/>
      <text x="${n.x}" y="${n.y + (n.y < cy ? -9 : 15)}" text-anchor="middle" class="gtext" style="fill:${n.c}">${esc(n.t)}</text></g>`;
  }
  s += `<circle cx="${cx}" cy="${cy}" r="9" class="hub"/><text x="${cx}" y="${cy + 24}" text-anchor="middle" class="gtext hubt">${esc(ctx.handle)}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="chart graph" role="img" aria-label="knowledge graph">${s}</svg>`;
}

export function renderMemoryLab(lang, ctx) {
  const t = L[lang], st = ctx.memory;
  const eps = st.episodes;
  const avg = eps.length ? eps.reduce((s, e) => s + st.retention(e), 0) / eps.length : 0;
  const stats = [eps.length, st.insights.length, eps.length ? Math.round(avg * 100) + '%' : '—', st.lastDream ? ago(st.lastDream, lang) : t.never];
  const snap = ctx.wmLast;
  const list = eps.slice(-12).reverse().map((e) => {
    const r = st.retention(e), c = colorOf(ctx, e.winner);
    return `<li data-ep="${e.id}" class="${ctx.focusId === e.id ? 'focus' : ''}"><i style="background:${c}"></i><div><p>${esc(cut(e.q, 40))}</p><small>${ago(e.ts, lang)} · S=${(e.s || 6).toFixed(0)}${t.hrs}${e.n ? ` · ${e.n} ${t.recalls}` : ''}</small></div><span class="rbar"><b style="width:${(r * 100).toFixed(0)}%;background:${c}"></b></span><em>${Math.round(r * 100)}%</em></li>`;
  }).join('');
  const insights = st.insights.slice(-6).reverse().map((i) => `<li><p>${esc(i.text)}</p><small>${ago(i.ts, lang)}</small></li>`).join('');
  return `
    <div class="mstats">${stats.map((v, i) => `<div><b>${esc(v)}</b><span>${t.stats[i]}</span></div>`).join('')}</div>
    <h3>${t.s1}</h3><p class="hint">${t.s1hint}</p>
    <input class="lab-input" id="mem-q" placeholder="${esc(t.s1ph)}" maxlength="200" value="${esc(ctx.lastQuestion || '')}" />
    <ol class="hits" id="mem-hits"></ol>
    <h3>${t.s2}</h3><p class="hint">${t.s2hint}</p>
    ${snap ? `${wmChart(snap, lang)}<p class="muted">${t.peak} ${snap.peak} / ${snap.budget} tokens · ${t.comp} ${snap.compactions}${t.times}</p>
      <details class="wm"><summary>${t.now}</summary><ul>${snap.items.map((i) => `<li class="${i.summary ? 'sum' : i.pinned ? 'pin' : ''}"><code>${i.tokens}</code>${esc(i.pinned ? '❯ ' + i.text : i.summary ? i.text : `${i.name}: ${i.text}`)}</li>`).join('')}</ul></details>` : `<p class="muted">${t.s2none}</p>`}
    <h3>${t.s3}</h3><p class="hint">${t.s3hint}</p>
    ${eps.length ? forgetChart(st, ctx, lang) + `<ul class="eplist">${list}</ul>` : `<p class="muted">${t.s1none}</p>`}
    <h3>${t.s4}</h3><p class="hint">${t.s4hint}</p>${graph(st, ctx, lang)}
    <h3>${t.s5}</h3><p class="hint">${t.s5hint}</p>
    <div class="lab-actions"><button class="primary tiny" id="mem-dream">${t.dream}</button></div>
    ${insights ? `<ul class="inslist">${insights}</ul>` : `<p class="muted">${t.noIns}</p>`}
    ${eps.length || st.insights.length ? `<div class="lab-actions"><button class="ghost tiny" id="mem-forget">${t.forget}</button></div>` : ''}`;
}

export function bindMemoryLab(root, lang, ctx) {
  const t = L[lang], st = ctx.memory;
  const q = root.querySelector('#mem-q'), out = root.querySelector('#mem-hits');
  let timer;
  const run = () => {
    if (!st.episodes.length) { out.innerHTML = `<li class="muted">${t.s1none}</li>`; return; }
    const v = q.value.trim();
    if (!v) { out.innerHTML = ''; return; }
    const hits = st.search(v, 5).filter((h) => h.score > 0.05);
    out.innerHTML = hits.length ? hits.map((h) => {
      const c = colorOf(ctx, h.e.winner);
      return `<li data-ep="${h.e.id}"><span class="score" style="--p:${Math.max(0, h.score) * 100}%;--c:${c}"><b>${Math.round(h.score * 100)}%</b></span><div><p>${esc(cut(h.e.q, 42))}</p><small>${ago(h.e.ts, lang)} · ${t.keep} ${Math.round(h.r * 100)}%</small></div></li>`;
    }).join('') : `<li class="muted">${t.s1empty}</li>`;
    ctx.onRecallPreview?.(hits.filter((h) => h.score >= 0.15).map((h) => h.e.id));
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 160); });
  run();
  root.querySelectorAll('[data-ep]').forEach((li) => li.addEventListener('click', () => ctx.onRecallPreview?.([li.dataset.ep])));
  out.addEventListener('click', (e) => { const li = e.target.closest('[data-ep]'); if (li) ctx.onRecallPreview?.([li.dataset.ep]); });
  root.querySelector('#mem-dream')?.addEventListener('click', (e) => { e.target.disabled = true; ctx.onDream?.(); });
  root.querySelector('#mem-forget')?.addEventListener('click', () => ctx.onForget?.());
  root.querySelector('.eplist li.focus')?.scrollIntoView({ block: 'center' });
}
