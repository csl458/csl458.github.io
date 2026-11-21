// The critic: splits an answer into claims, grounds each one in what the mind actually knows
// (owner facts, live tool data, recalled memories, the meeting itself), catches contradictions,
// and revises the answer before it leaves the mouth. Pure logic, no DOM.
import { embed, cosine } from './memory.js';

const CJK = /[㐀-鿿]/;
export const SUPPORT_SIM = 0.45; // semantic similarity that counts as "the evidence says this"
export const GATE = 0.5; // below this confidence (or on any contradiction) the answer is revised

const CITIES = [
  ['Sydney', '悉尼'], ['Melbourne', '墨尔本'], ['Brisbane', '布里斯班'], ['Perth', '珀斯'], ['Beijing', '北京'], ['Shanghai', '上海'], ['Shenzhen', '深圳'],
  ['Guangzhou', '广州'], ['Hangzhou', '杭州'], ['Hong Kong', '香港'], ['Taipei', '台北'], ['Tokyo', '东京'], ['Seoul', '首尔'], ['Singapore', '新加坡'],
  ['London', '伦敦'], ['Paris', '巴黎'], ['Berlin', '柏林'], ['New York', '纽约'], ['San Francisco', '旧金山'], ['Los Angeles', '洛杉矶'], ['Seattle', '西雅图'], ['Toronto', '多伦多'],
];
const cityIn = (s) => CITIES.find(([en, zh]) => new RegExp(`\\b${en}\\b`, 'i').test(s) || s.includes(zh));
const citiesIn = (s) => CITIES.filter(([en, zh]) => new RegExp(`\\b${en}\\b`, 'i').test(s) || s.includes(zh));
const ABOUT_OWNER = /(我|主人|本人|\bI\b|I'm|I am|\bmy\b|owner|@\w+)/i;
const CONJ_SPLIT = /(?<=，)(?=还|并且|而且|同时|另外|也曾|曾经)|\s+(?=and\s+(?:also\s+)?(?:won|work|worked|have|has|had|got|was|am|studied|founded|built|hold|holds)\b)/i;
const CONTINUES = /^(还|并且|而且|同时|另外|也曾|曾经|and\b)/i;
// Chinese proper nouns that make a claim factual: institutions, awards, companies, titles
const ZH_PROPER = /[一-鿿A-Za-z]{1,10}?(?:大学|学院|奖|公司|实验室|研究院|研究所|集团|基金会)|(?:博士|教授|院士|创始人|CEO|CTO)/g;

// ── evidence: everything the mind can point to ──
export function buildEvidence({ owner, toolResults = [], recalled = [], wmItems = [], insights = [] }) {
  const ev = [];
  const add = (src, label, text, data) => text && ev.push({ src, label, text: String(text), data });
  add('config', 'GitHub', `@${owner.handle} ${owner.github}`, { handle: owner.handle });
  add('config', 'location', `${owner.location.en} ${owner.location.zh}`, { city: owner.location.en });
  add('config', 'affiliation', `${owner.affiliation.en} ${owner.affiliation.zh}`);
  add('config', 'focus', `${owner.focus.en} ${owner.focus.zh}`);
  if (owner.email) add('config', 'email', owner.email);
  for (const l of owner.links || []) add('config', l.label, l.url);
  for (const r of toolResults.filter((x) => x.ok)) add('tool', r.name || r.tool, r.summary, { tool: r.tool, ...(r.data || {}) });
  for (const r of recalled) add('memory', 'episode', `${r.q} ${r.a || ''}`);
  for (const i of insights) add('memory', 'insight', i.text);
  for (const it of wmItems) if (!it.pinned) add('meeting', it.name || it.who || 'meeting', it.text);
  return ev;
}

// ── claims ──
export function splitClaims(text) {
  const out = [];
  // Chinese sentence ends, then English ones (". " before a capital), keeping the punctuation
  for (const p of String(text).replace(/\s+/g, ' ').split(/(?<=[。！？；])/)) {
    for (const s of p.split(/(?<=[.!?;])\s+(?=[A-Z@"“(])/)) {
      // compound sentences: "…，还拿过…" / "… and won …" are separate claims
      for (const sub of s.split(CONJ_SPLIT)) {
        const c = sub.trim();
        if (c.replace(/[\s。！？!?.,，；;—\-]/g, '').length >= 3) out.push(c);
      }
    }
  }
  return out;
}

function entities(s) {
  const e = new Set();
  for (const m of s.match(/@[\w-]+/g) || []) e.add(m.toLowerCase());
  for (const m of s.match(/https?:\/\/[^\s，。)）]+|github\.com\/[\w-]+/gi) || []) e.add(m.toLowerCase().replace(/^https?:\/\//, '').replace(/[.,]$/, ''));
  for (const m of s.match(/-?\d+(?:\.\d+)?/g) || []) e.add(m);
  const c = cityIn(s); if (c) e.add(c[0].toLowerCase());
  // a capitalised first word is just the start of a sentence, not a proper noun
  const body = s.replace(/^\s*["“(]?[A-Z][a-z]+(?=[\s,.'’])/, (w) => w.toLowerCase());
  for (const m of body.match(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\b/g) || []) if (!/^(I|I'm|My|The|A|An|This|That|It|We|You|By|All|Right|Wait|Fastest|These|Wikipedia|Recently|Asked)$/.test(m)) e.add(m.toLowerCase());
  for (const m of s.match(/[「“"]([^」”"]{1,20})[」”"]/g) || []) e.add(m.slice(1, -1).toLowerCase());
  for (const m of s.match(ZH_PROPER) || []) e.add(m.replace(/^(?:我是|我在|还拿过|还|曾经在|曾在|曾经|毕业于|就读于|任职于|工作于|拿过|获得过|获得|得过|当过|担任|在|于|从|是)+/, '').toLowerCase());
  return [...e];
}
const isFactual = (s) => entities(s).length > 0;

function evHas(ev, ent) {
  const low = ent.toLowerCase();
  return ev.some((x) => {
    const t = x.text.toLowerCase();
    if (t.includes(low)) return true;
    const c = CITIES.find(([en]) => en.toLowerCase() === low);
    return c ? t.includes(c[1]) : false;
  });
}

// Specific consistency checks: each returns { reason, fix?(claim) } when the claim contradicts evidence.
function contradictions(claim, ev, owner, lang) {
  const zh = lang === 'zh';
  const found = [];
  // where the owner lives
  const aboutOwner = ABOUT_OWNER.test(claim) && /(住|在|坐标|based|live|lives|living|from|located)/i.test(claim);
  // city names inside the owner's affiliation (e.g. "University of Technology Sydney") don't count
  const stripped = claim.split(owner.affiliation.zh).join(' ').split(owner.affiliation.en).join(' ').replace(/University of Technology Sydney|悉尼科技大学/gi, ' ');
  const city = citiesIn(stripped).find(([en]) => en !== owner.location.en);
  if (aboutOwner && city && !/(天气|weather|时间|time|几点|°C)/i.test(claim)) {
    found.push({ reason: zh ? `主人在${owner.location.zh}，不是${city[1]}` : `the owner is in ${owner.location.en}, not ${city[0]}`, src: 'config',
      fix: (s) => s.replace(new RegExp(`\\b${city[0]}\\b`, 'gi'), owner.location.en).replaceAll(city[1], owner.location.zh) });
  }
  const gh = ev.find((x) => x.data?.tool === 'github');
  if (gh) {
    for (const [re, key, label] of [[/(\d+)\s*(?:个)?\s*(?:公开)?\s*(?:public\s+)?(?:仓库|repos?\b|repositories)/i, 'public_repos', zh ? '公开仓库' : 'public repos'], [/(\d+)\s*(?:位|个)?\s*(?:关注者|粉丝|followers?)/i, 'followers', zh ? '关注者' : 'followers']]) {
      const m = claim.match(re);
      if (m && +m[1] !== gh.data[key]) found.push({ reason: zh ? `GitHub 实时数据：${gh.data[key]} 个${label}，不是 ${m[1]}` : `live GitHub data says ${gh.data[key]} ${label}, not ${m[1]}`, src: 'tool', fix: (s) => s.replace(m[0], m[0].replace(m[1], String(gh.data[key]))) });
    }
  }
  const w = ev.find((x) => x.data?.tool === 'weather');
  const tm = claim.match(/(-?\d+(?:\.\d+)?)\s*°\s*C/i);
  if (w && tm && Math.abs(+tm[1] - w.data.temperature) > 2 && !/(体感|feels)/i.test(claim.slice(Math.max(0, claim.indexOf(tm[0]) - 6), claim.indexOf(tm[0])))) {
    const real = Math.round(w.data.temperature);
    found.push({ reason: zh ? `实时天气是 ${real}°C，不是 ${tm[1]}°C` : `live weather says ${real}°C, not ${tm[1]}°C`, src: 'tool', fix: (s) => s.replace(tm[0], `${real}°C`) });
  }
  const calc = ev.find((x) => x.data?.tool === 'calc');
  const cm = claim.match(/(?:是|为|=|等于|equals|comes to|is)\s*(-?\d+(?:\.\d+)?)/i);
  if (calc && cm && Math.abs(+cm[1] - calc.data.result) > 1e-9 * Math.max(1, Math.abs(calc.data.result)) && /(算|计算|结果|等于|=|comes to|equals|result)/i.test(claim)) {
    found.push({ reason: zh ? `计算器给出的是 ${calc.data.result}` : `the calculator says ${calc.data.result}`, src: 'tool', fix: (s) => s.replace(cm[0], cm[0].replace(cm[1], String(calc.data.result))) });
  }
  return found;
}

// ── the review ──
export function critique(answer, ev, { owner, lang }) {
  const zh = lang === 'zh';
  const evVecs = ev.map((x) => embed(x.text));
  let prevOwner = false;
  const claims = splitClaims(answer).map((text) => {
    const owner_ = ABOUT_OWNER.test(text) || (CONTINUES.test(text) && prevOwner);
    prevOwner = owner_;
    const v = embed(text);
    let best = -1, bi = -1;
    evVecs.forEach((e, i) => { const s = cosine(v, e); if (s > best) { best = s; bi = i; } });
    const ents = entities(text);
    const missing = ents.filter((e) => !evHas(ev, e));
    const bad = contradictions(text, ev, owner, lang);
    const factual = isFactual(text);
    let verdict;
    if (bad.length) verdict = 'contradicted';
    else if (!factual) verdict = best >= SUPPORT_SIM ? 'supported' : 'opinion';
    else if (!missing.length || best >= SUPPORT_SIM + 0.15) verdict = 'supported';
    else verdict = 'unverified';
    const src = ev[bi];
    return {
      text, verdict, sim: Math.max(0, best), missing, aboutOwner: owner_,
      reason: bad.length ? bad.map((b) => b.reason).join('; ') : verdict === 'unverified' ? (zh ? `找不到证据：${missing.slice(0, 3).join('、')}` : `no evidence for: ${missing.slice(0, 3).join(', ')}`) : verdict === 'supported' ? (zh ? `依据：${src?.label}` : `grounded in: ${src?.label}`) : (zh ? '观点，不需要事实依据' : 'opinion; nothing to fact-check'),
      evidence: verdict === 'supported' && src ? { src: src.src, label: src.label, text: src.text.slice(0, 140) } : bad[0] ? { src: bad[0].src, label: '', text: bad[0].reason } : null,
      fixes: bad.map((b) => b.fix).filter(Boolean),
    };
  });
  const facts = claims.filter((c) => c.verdict !== 'opinion');
  const score = { supported: 1, unverified: 0.4, contradicted: 0 };
  const confidence = facts.length ? facts.reduce((s, c) => s + score[c.verdict], 0) / facts.length : 1;
  // anything said about the owner must be grounded: an unverifiable claim about them is sent back too
  const needsRevision = claims.some((c) => c.verdict === 'contradicted' || (c.verdict === 'unverified' && c.aboutOwner)) || (facts.length > 0 && confidence < GATE);
  // revise: correct what can be corrected, drop what can't, hedge what's unverified
  const changes = [];
  const revisedParts = claims.map((c) => {
    if (!needsRevision) return c.text;
    if (c.verdict === 'contradicted') {
      if (c.fixes.length) { const fixed = c.fixes.reduce((s, f) => f(s), c.text); changes.push({ kind: 'fix', from: c.text, to: fixed, reason: c.reason }); return fixed; }
      changes.push({ kind: 'drop', from: c.text, reason: c.reason }); return '';
    }
    if (c.verdict === 'unverified') { const hedged = c.text.replace(/([，,。.!?！？；;]?)$/, zh ? '（未经证实）$1' : ' (unverified)$1'); changes.push({ kind: 'hedge', from: c.text, to: hedged, reason: c.reason }); return hedged; }
    return c.text;
  });
  const revised = needsRevision ? revisedParts.filter(Boolean).join(zh ? '' : ' ') : answer;
  return { claims, confidence, needsRevision, revised, changes, evidenceCount: ev.length, mode: 'rules' };
}

export function reportLine(r, lang) {
  const n = (v) => r.claims.filter((c) => c.verdict === v).length;
  const pct = Math.round(r.confidence * 100);
  return lang === 'zh'
    ? `审查完毕：${r.claims.length} 条主张，${n('supported')} 条有据，${n('unverified')} 条无法验证，${n('contradicted')} 条与事实矛盾。置信度 ${pct}%。${r.needsRevision ? '打回修改。' : '放行。'}`
    : `Review done: ${r.claims.length} claims, ${n('supported')} grounded, ${n('unverified')} unverifiable, ${n('contradicted')} contradicted. Confidence ${pct}%. ${r.needsRevision ? 'Sent back for revision.' : 'Cleared.'}`;
}
