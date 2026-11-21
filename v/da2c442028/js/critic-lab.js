// LAB 06 · Amygdala — the Critic lab panel.
import { critique, buildEvidence, reportLine, SUPPORT_SIM, GATE } from './critic.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cut = (s, n) => { const a = [...String(s)]; return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };

const L = {
  zh: {
    v: { supported: '有据', unverified: '无法验证', contradicted: '矛盾', opinion: '观点' },
    src: { config: '配置', tool: '工具', memory: '记忆', meeting: '会议' },
    s1: '① 上一次审查', s1hint: '每个答案离开嘴巴前都要过这一关：拆成主张，逐条找证据，抓矛盾，必要时打回修改。', none: '还没有审查过。问大脑一个问题吧。',
    conf: '置信度', mode: { rules: '规则审查', claude: 'Claude 审查' }, changes: '修改', before: '原稿', after: '放行稿', evidence: '证据',
    s2: '② 试一试：骗过审查员', s2hint: '写一段关于主人的话，故意掺点错误（城市、仓库数、温度、算式结果、编造的经历），看审查员能抓住多少。',
    sample: '我是 @csl458，住在东京，在悉尼科技大学读书。我有 50 个公开仓库，还拿过图灵奖。多智能体系统会改变世界。',
    run: '▶ 审查', fetchGh: '⌥ 先用 GitHub 工具取证', fetched: '已加入 GitHub 实时数据',
    s3: '③ 证据库', s3hint: '审查员能指着说“证据在这”的一切：配置里的事实、本场工具数据、唤起的记忆、会议发言。',
    s4: '④ 审查规则', rules: [
      `主张拆分：按句末标点切成独立主张；带数字、人名地名、链接、引号名称的算“事实性主张”，其余算观点。`,
      `语义支撑：主张与任一证据的向量相似度 ≥ ${SUPPORT_SIM}，或其中的实体都能在证据里找到 → 有据。`,
      '矛盾检查：主人所在城市、GitHub 仓库数和关注者数、实时温度（±2°C）、计算器结果，与证据不符 → 矛盾，并给出修正值。',
      `打回条件：有矛盾；或关于主人的主张无法验证；或事实性主张的置信度 < ${Math.round(GATE * 100)}%。`,
      '修改策略：能纠正的改成证据里的值，不能纠正的删掉，无法验证的标注「未经证实」。Claude 大脑模式下由 Claude 逐条判定并改写。',
    ],
  },
  en: {
    v: { supported: 'grounded', unverified: 'unverifiable', contradicted: 'contradicted', opinion: 'opinion' },
    src: { config: 'config', tool: 'tool', memory: 'memory', meeting: 'meeting' },
    s1: '① Last review', s1hint: 'Every answer passes this gate before it leaves the mouth: split into claims, each one grounded, contradictions caught, sent back when needed.', none: 'Nothing reviewed yet. Ask the mind something.',
    conf: 'Confidence', mode: { rules: 'rule-based review', claude: 'Claude review' }, changes: 'Changes', before: 'Draft', after: 'Cleared', evidence: 'Evidence',
    s2: '② Try to fool the critic', s2hint: 'Write something about the owner and slip in mistakes (city, repo count, temperature, a sum, an invented credential). See how many it catches.',
    sample: 'I\'m @csl458, based in Tokyo, studying at the University of Technology Sydney. I have 50 public repos and won the Turing Award. Multi-agent systems will change the world.',
    run: '▶ Review', fetchGh: '⌥ Gather GitHub evidence first', fetched: 'Live GitHub data added',
    s3: '③ Evidence', s3hint: 'Everything the critic can point to: facts from config, this meeting\'s tool data, recalled memories, what was said in the meeting.',
    s4: '④ Rules', rules: [
      'Claim splitting: sentence punctuation splits the answer into claims; ones with numbers, names, places, links or quoted names are factual, the rest are opinions.',
      `Semantic support: vector similarity ≥ ${SUPPORT_SIM} with any evidence, or every entity found in the evidence → grounded.`,
      'Contradiction checks: the owner\'s city, GitHub repo and follower counts, live temperature (±2°C), calculator results → contradicted, with the corrected value.',
      `Send back when: anything is contradicted; or a claim about the owner can't be verified; or factual confidence < ${Math.round(GATE * 100)}%.`,
      'Revision: correct what the evidence can correct, drop what it can\'t, mark the unverifiable as unverified. With the Claude brain, Claude judges each claim and rewrites.',
    ],
  },
};

function gauge(p) {
  const r = 34, c = 2 * Math.PI * r, col = p >= 0.8 ? '#5dffa0' : p >= 0.5 ? '#ffc24a' : '#ff5470';
  return `<svg viewBox="0 0 90 90" class="gauge"><circle cx="45" cy="45" r="${r}" class="gtrack"/><circle cx="45" cy="45" r="${r}" class="gval" style="stroke:${col};stroke-dasharray:${(p * c).toFixed(1)} ${c.toFixed(1)}"/><text x="45" y="50" text-anchor="middle" style="fill:${col}">${Math.round(p * 100)}%</text></svg>`;
}

function claimList(rv, lang) {
  const t = L[lang];
  return `<ul class="claims">${rv.claims.map((c) => `<li class="${c.verdict}"><span class="vchip">${t.v[c.verdict]}</span><div><p>${esc(c.text)}</p><small>${esc(c.reason || '')}${c.evidence?.text && c.verdict === 'supported' ? ` — “${esc(cut(c.evidence.text, 60))}”` : ''}</small></div></li>`).join('')}</ul>`;
}

function diff(original, revised, changes) {
  let a = esc(original), b = esc(revised);
  for (const ch of changes) {
    if (ch.from) a = a.replace(esc(ch.from), `<del>${esc(ch.from)}</del>`);
    if (ch.to) b = b.replace(esc(ch.to), `<ins>${esc(ch.to)}</ins>`);
  }
  return { a, b };
}

function result(rv, original, lang) {
  const t = L[lang];
  const finalText = rv.needsRevision ? rv.revised : original;
  const d = diff(original, finalText, rv.changes);
  return `<div class="crhead">${gauge(rv.confidence)}<div><b>${t.conf}</b><p>${esc(reportLine(rv, lang))}</p><small>${t.mode[rv.mode] || rv.mode} · ${t.evidence} ${rv.evidenceCount}</small></div></div>
    ${claimList(rv, lang)}
    ${rv.needsRevision ? `<div class="diff"><div><em>${t.before}</em><p>${d.a}</p></div><div><em>${t.after}</em><p>${d.b}</p></div></div>` : ''}`;
}

export function renderCriticLab(lang, ctx) {
  const t = L[lang];
  const lr = ctx.lastReview;
  const ev = lr?.evidence || buildEvidence({ owner: ctx.owner });
  const evList = ev.slice(0, 18).map((e) => `<li><span class="src ${e.src}">${t.src[e.src]}</span><b>${esc(e.label)}</b> ${esc(cut(e.text, 80))}</li>`).join('');
  return `
    <h3>${t.s1}</h3><p class="hint">${t.s1hint}</p>
    ${lr ? `<p class="muted">“${esc(cut(lr.q || '', 40))}”</p>${result(lr.review, lr.original, lang)}` : `<p class="muted">${t.none}</p>`}
    <h3>${t.s2}</h3><p class="hint">${t.s2hint}</p>
    <textarea class="lab-input" id="cr-text" rows="4">${esc(t.sample)}</textarea>
    <div class="lab-actions"><button class="primary tiny" id="cr-run" type="button">${t.run}</button><button class="ghost tiny" id="cr-gh" type="button">${t.fetchGh}</button></div>
    <div id="cr-out"></div>
    <h3>${t.s3}</h3><p class="hint">${t.s3hint}</p><ul class="evlist" id="cr-ev">${evList}</ul>
    <h3>${t.s4}</h3><ol class="rules">${t.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>`;
}

export function bindCriticLab(root, lang, ctx) {
  const t = L[lang];
  let extra = [];
  const run = () => {
    const text = root.querySelector('#cr-text').value.trim(); if (!text) return;
    const ev = buildEvidence({ owner: ctx.owner, toolResults: [...(ctx.lastReview?.toolResults || []), ...extra], insights: ctx.insights });
    const rv = critique(text, ev, { owner: ctx.owner, lang: /[㐀-鿿]/.test(text) ? 'zh' : 'en' });
    root.querySelector('#cr-out').innerHTML = result(rv, text, lang);
    root.querySelector('#cr-ev').innerHTML = ev.slice(0, 18).map((e) => `<li><span class="src ${e.src}">${t.src[e.src]}</span><b>${esc(e.label)}</b> ${esc(cut(e.text, 80))}</li>`).join('');
    ctx.onReviewPreview?.(rv);
  };
  root.querySelector('#cr-run').addEventListener('click', run);
  root.querySelector('#cr-gh').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const r = await ctx.onTryTool('github', {});
    if (r.ok) { extra = [{ ...r, tool: 'github', name: 'github_profile', data: { tool: 'github', ...r.data } }]; e.target.textContent = '✓ ' + t.fetched; }
    else { e.target.disabled = false; }
    run();
  });
}
