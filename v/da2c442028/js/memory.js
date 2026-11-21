// The memory system, for real: vector retrieval, a forgetting curve, a working-memory budget with
// compaction, and "dreaming" (consolidating similar episodes into insights). Pure logic, no DOM.

const DIM = 256;
const HOUR = 3600e3;
export const WM_BUDGET = 180; // tokens the meeting may hold before it has to compact
const INITIAL_STRENGTH_H = 6; // a fresh memory loses ~63% of its retention in 6 hours…
const FADE = 0.04; // …and below this retention it no longer orbits the head

const CJK = /[぀-ヿ㐀-鿿가-힯]/;
const STOP_EN = new Set('a an the is are was were be been am i you he she it we they me my your our their this that these those to of in on at for with and or but if so do does did can could should would will what who whom why how when where which there here not no yes just about as by from into than then too very really any some incoming meeting everyone time voices table first someone asks new input all let live model online think independently'.split(' '));
const STOP_ZH = new Set(['收到', '问题', '到一', '一个', '个问', '各位', '开会', '新输', '输入', '全员', '就位', '谁先', '先说', '有人', '人问', '接入', '真实', '模型', '独立', '思考', '什么', '怎么', '为什么', '你是', '是谁', '我的', '你的', '我们', '你们', '一个', '这个', '那个', '可以', '如何', '吗', '呢', '的', '了', '是', '我', '你', '他', '她', '它', '在', '有', '和', '吧', '啊', '会', '要', '该', '能', '不', '也', '都', '就', '还', '么', '怎', '谁']);

// ── tokens & keywords ──
export function tokens(text) {
  let cjk = 0, other = 0;
  for (const ch of String(text)) { if (CJK.test(ch)) cjk++; else other++; }
  return cjk + Math.ceil(other / 4);
}
function terms(text) {
  const s = String(text).toLowerCase();
  const out = [];
  for (const w of s.match(/[a-z0-9][a-z0-9'’-]*/g) || []) if (!STOP_EN.has(w) && w.length > 1) out.push(w);
  for (const run of s.match(/[぀-ヿ㐀-鿿가-힯]+/g) || []) {
    const chars = [...run];
    for (let i = 0; i < chars.length - 1; i++) { const bi = chars[i] + chars[i + 1]; if (!STOP_ZH.has(bi) && !STOP_ZH.has(chars[i]) && !STOP_ZH.has(chars[i + 1])) out.push(bi); }
    if (chars.length === 1 && !STOP_ZH.has(chars[0])) out.push(chars[0]);
  }
  return out;
}
export function keywords(texts, k = 3, minCount = 1) {
  const f = new Map();
  for (const t of texts) for (const w of new Set(terms(t))) f.set(w, (f.get(w) || 0) + 1);
  return [...f.entries()].filter((e) => e[1] >= minCount).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, k).map((e) => e[0]);
}

// ── embedding: hashed word + character n-grams, L2-normalised (cosine = dot product) ──
function fnv(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function embed(text) {
  const v = new Float32Array(DIM);
  const s = String(text).toLowerCase();
  const add = (g, w) => { const h = fnv(g); v[h % DIM] += (h & 0x100 ? 1 : -1) * w; };
  for (const w of terms(s)) add('w:' + w, 1.5);
  for (const w of s.match(/[a-z0-9]+/g) || []) { const p = `^${w}$`; for (let i = 0; i < p.length - 2; i++) add('c:' + p.slice(i, i + 3), 0.5); }
  for (const ch of s) if (CJK.test(ch)) add('h:' + ch, 0.6);
  let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
export function cosine(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }

// ── long-term store: episodes (meetings) + insights (dreams) ──
export class MemoryStore {
  constructor(load, save) {
    this.save_ = save;
    const raw = load() || {};
    this.episodes = (raw.episodes || []).filter((e) => e && e.q).slice(-80);
    this.insights = (raw.insights || []).slice(-24);
    this.lastDream = raw.lastDream || 0;
    this.vec = new Map();
  }
  save() { this.save_({ episodes: this.episodes, insights: this.insights, lastDream: this.lastDream }); }
  vecOf(e) { if (!this.vec.has(e.id)) this.vec.set(e.id, embed(e.q)); return this.vec.get(e.id); }

  // Ebbinghaus-style decay: R = exp(-Δt / S); every recall doubles S (the spacing effect).
  retention(e, now = Date.now()) { return Math.exp(-(now - (e.seen || e.ts)) / ((e.s || INITIAL_STRENGTH_H) * HOUR)); }
  alive(now = Date.now()) { return this.episodes.filter((e) => this.retention(e, now) >= FADE); }

  add({ q, a, winner, lang }) {
    const e = { id: 'ep_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), q: q.slice(0, 200), a: (a || '').slice(0, 300), winner, lang, ts: Date.now(), seen: Date.now(), s: INITIAL_STRENGTH_H, n: 0 };
    this.episodes.push(e);
    if (this.episodes.length > 80) this.episodes.splice(0, this.episodes.length - 80);
    this.save();
    return e;
  }
  search(query, k = 5, exclude) {
    const qv = embed(query);
    return this.episodes
      .filter((e) => e.id !== exclude)
      .map((e) => ({ e, score: cosine(qv, this.vecOf(e)), r: this.retention(e) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, k);
  }
  // What surfaces on its own when a question arrives: similar enough, and not forgotten.
  recall(query, k = 3, min = 0.22) {
    const hits = this.search(query, 12).filter((h) => h.score >= min && h.r >= FADE).slice(0, k);
    const now = Date.now();
    for (const h of hits) { h.e.s = (h.e.s || INITIAL_STRENGTH_H) * 2; h.e.seen = now; h.e.n = (h.e.n || 0) + 1; }
    if (hits.length) this.save();
    return hits;
  }
  forget() { this.episodes = []; this.insights = []; this.lastDream = 0; this.vec.clear(); this.save(); }
  newSinceDream() { return this.episodes.filter((e) => e.ts > this.lastDream).length; }

  // Dreaming: group similar episodes, distil each group into one insight, and strengthen what was kept.
  clusters(min = 0.3) {
    const eps = this.alive(), used = new Set(), out = [];
    for (const e of eps) {
      if (used.has(e.id)) continue;
      const group = [e]; used.add(e.id);
      for (const f of eps) if (!used.has(f.id) && cosine(this.vecOf(e), this.vecOf(f)) >= min) { group.push(f); used.add(f.id); }
      if (group.length >= 2) out.push(group);
    }
    return out;
  }
  async dream(lang, summarise) {
    const groups = this.clusters();
    const made = [];
    for (const g of groups) {
      const qs = g.map((e) => e.q);
      let text = null;
      if (summarise) { try { text = await summarise(qs, lang); } catch { text = null; } }
      // the most central question of the group stands for all of them
      const rep = g.map((e) => ({ e, c: g.reduce((s, f) => s + cosine(this.vecOf(e), this.vecOf(f)), 0) })).sort((a, b) => b.c - a.c)[0].e.q;
      const kw = keywords(qs, 3, 2);
      if (!text) {
        text = lang === 'zh'
          ? `反复被问到：「${rep}」${kw.length ? `，共同关键词 ${kw.map((w) => `「${w}」`).join('')}` : ''}（${g.length} 场会议）`
          : `Asked again and again: "${rep}"${kw.length ? `, shared terms ${kw.map((w) => `"${w}"`).join(', ')}` : ''} (${g.length} meetings)`;
      }
      const ins = { id: 'in_' + Date.now().toString(36) + made.length, text, from: g.map((e) => e.id), ts: Date.now(), kw: kw.length ? kw : [rep.slice(0, 12)] };
      made.push(ins);
      for (const e of g) e.s = (e.s || INITIAL_STRENGTH_H) * 1.5;
    }
    this.insights.push(...made);
    this.insights = this.insights.slice(-24);
    this.lastDream = Date.now();
    this.save();
    return { groups, insights: made };
  }
}

// ── working memory: the current meeting's context, with a token budget ──
export class WorkingMemory {
  constructor(budget = WM_BUDGET) { this.budget = budget; this.reset(); }
  reset(question) {
    this.items = question ? [{ who: 'input', text: question, tokens: tokens(question), pinned: true }] : [];
    this.timeline = [{ total: this.total(), compact: false }];
    this.compactions = 0; this.peak = this.total();
  }
  total() { return this.items.reduce((s, i) => s + i.tokens, 0); }
  // Returns { n, summary } when this push forced a compaction.
  push(who, name, text, lang) {
    this.items.push({ who, name, text, tokens: tokens(text) });
    this.peak = Math.max(this.peak, this.total());
    let event = null;
    if (this.total() > this.budget) {
      const fold = [];
      for (const it of this.items) {
        if (it.pinned || it.summary) continue;
        fold.push(it);
        const rest = this.total() - fold.reduce((s, x) => s + x.tokens, 0);
        if (rest <= this.budget * 0.55) break;
      }
      if (fold.length >= 2) {
        const names = [...new Set(fold.map((x) => x.name))];
        const kw = keywords(fold.map((x) => x.text), 3);
        const summary = lang === 'zh'
          ? `[摘要·${fold.length}条] ${names.join('、')}谈到 ${kw.map((w) => `「${w}」`).join('')}`
          : `[summary·${fold.length} lines] ${names.join(', ')} discussed ${kw.map((w) => `"${w}"`).join(', ')}`;
        const keep = this.items.filter((x) => !fold.includes(x));
        const at = keep.findIndex((x) => !x.pinned && !x.summary);
        keep.splice(at < 0 ? keep.length : at, 0, { who: 'summary', text: summary, tokens: tokens(summary), summary: true });
        this.items = keep;
        this.compactions++;
        event = { n: fold.length, summary };
      }
    }
    this.timeline.push({ total: this.total(), compact: !!event });
    return event;
  }
  toText() { return this.items.map((i) => (i.pinned ? `Question: ${i.text}` : i.summary ? i.text : `${i.name}: ${i.text}`)).join('\n'); }
  snapshot() { return { budget: this.budget, items: this.items.map((i) => ({ ...i })), timeline: [...this.timeline], compactions: this.compactions, peak: this.peak }; }
}

export function ago(ts, lang, now = Date.now()) {
  const s = Math.max(1, Math.round((now - ts) / 1000));
  const [v, u] = s < 60 ? [s, lang === 'zh' ? '秒' : 's'] : s < 3600 ? [Math.round(s / 60), lang === 'zh' ? '分钟' : 'm'] : s < 86400 ? [Math.round(s / 3600), lang === 'zh' ? '小时' : 'h'] : [Math.round(s / 86400), lang === 'zh' ? '天' : 'd'];
  return lang === 'zh' ? `${v}${u}前` : `${v}${u} ago`;
}
