import { OWNER } from './config.js';
import { T } from './i18n.js';
import { CORE, STYLES, PALETTE, GLYPHS, corePosition, implantPosition, implantToAgent, sanitizeImplant, encodeAgent, decodeAgent } from './agents.js';
import { simMeeting, isCJK, IDLE, DREAMS } from './sim.js';
import { llmMeeting, MODELS, summariseCluster, makeLLMBrain, claudeToolPhase } from './llm.js';
import { TOOLS, TOOL_BY_ID, planTools, executeTool, toolEvents, toolLog } from './tools.js';
import { REGIONS, renderLab, bindLab } from './atlas.js';
import { formName } from './forms.js';
import { MemoryStore, WorkingMemory, ago } from './memory.js';
import { TOPOLOGIES, runTopology, simBrain, buildDag, dagMetrics, dagSVG, phaseLabel } from './orchestration.js';

// WebGL renderer when the browser can do it (and three.js loads); the canvas renderer otherwise.
let MindRenderer;
try {
  if (new URLSearchParams(location.search).has('2d')) throw new Error('2d requested');
  const probe = document.createElement('canvas');
  if (!(probe.getContext('webgl2') || probe.getContext('webgl'))) throw new Error('no webgl');
  ({ MindRenderer } = await import('./renderer3d.js'));
} catch {
  ({ MindRenderer } = await import('./renderer2d.js'));
  document.documentElement.classList.add('r2d');
}

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s，。)]+|github\.com\/[\w-]+)/g, (m) => `<a href="${m.startsWith('http') ? m : 'https://' + m}" target="_blank" rel="noopener">${m}</a>`);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a) => a[Math.floor(Math.random() * a.length)];

// ── persistence (best-effort; the page works without it) ──
const store = {
  get(k, d) { try { const v = localStorage.getItem('som.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('som.' + k, JSON.stringify(v)); } catch {} },
};

let lang = store.get('lang', (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
let implants = (store.get('implants', []) || []).map(sanitizeImplant).slice(0, 6);
let brain = Object.assign({ mode: 'sim', model: MODELS[0].id }, store.get('brain', {}));
let apiKey = store.get('key', '');
let topology = store.get('topology', 'council');
if (!TOPOLOGIES[topology]) topology = 'council';
const stats = Object.assign({ thoughts: 0, agents: {} }, store.get('stats', {}));
let busy = false, speed = 1, booted = false;
let agents = [];
const t = () => T[lang];

// ── mind ──
let renderer;
try { renderer = new MindRenderer($('#mind')); }
catch (err) {
  console.warn('WebGL renderer failed, using canvas:', err);
  const fresh = $('#mind').cloneNode(false); $('#mind').replaceWith(fresh); // a canvas can't switch from webgl to 2d
  ({ MindRenderer } = await import('./renderer2d.js'));
  document.documentElement.classList.add('r2d');
  renderer = new MindRenderer(fresh);
}
window.__mind = renderer; // handy for poking at it from devtools
// the canvas fallback has no creatures or camera moves: give it harmless stand-ins
if (!renderer.materialize) {
  Object.assign(renderer, {
    materialize() {}, release() {}, isStaged: () => false, focusOn() {}, stageWorld: null,
    setCrystals() {}, flashCrystal() {}, crystalAt: () => null,
    project(p) { const q = this.proj?.(p); return q ? { x: q.x, y: q.y, front: q.z > -0.2 } : { x: -999, y: -999, front: false }; },
  });
}
let lastTrace = null, trace = null, lastQuestion = '';

// ── memory: long-term store + the current meeting's working memory ──
const memory = new MemoryStore(() => store.get('memory', null), (d) => store.set('memory', d));
{ // carry over the plain history list kept by the previous version
  const old = store.get('history', null);
  if (old?.length && !memory.episodes.length) {
    for (const h of old.slice(-20)) { const e = memory.add({ q: h.q, a: '', winner: h.winner, lang: isCJK(h.q) ? 'zh' : 'en' }); e.ts = e.seen = h.ts || Date.now(); }
    memory.save();
  }
  try { localStorage.removeItem('som.history'); } catch {}
}
const wm = new WorkingMemory();
let wmLast = store.get('wm', null), meetingLang = 'en', labFocus = null;
function syncCrystals() {
  renderer.setCrystals([
    ...memory.episodes.map((e) => ({ id: e.id, color: agents.find((a) => a.id === e.winner)?.color || '#ffc24a', retention: memory.retention(e) })),
    ...memory.insights.map((i) => ({ id: i.id, color: '#ffd98a', retention: 1, insight: true })),
    ...TOOLS.map((tl) => ({ id: 'tool_' + tl.id, color: tl.color, retention: 1, tool: true, fixed: tl.pos })),
  ]);
}
function updateCtxBar(flash) {
  const tot = wm.total(), f = tot / wm.budget;
  const bar = $('#ctxbar');
  bar.querySelector('i').style.width = Math.min(100, f * 100) + '%';
  bar.classList.toggle('hot', f > 0.85);
  $('#ctxnum').textContent = `${tot}/${wm.budget}`;
  if (flash) { bar.classList.remove('compact'); void bar.offsetWidth; bar.classList.add('compact'); }
}
function buildAgents(bornId) {
  agents = [
    ...CORE.map((a, i) => ({ ...a, pos: corePosition(i) })),
    ...implants.map((imp, k) => ({ ...implantToAgent(imp, k), pos: implantPosition(k) })),
  ];
  renderer.setAgents(agents.map((a) => ({ ...a, born: a.id === bornId })));
  $('#nagents').textContent = agents.length;
}
const byId = (id) => agents.find((a) => a.id === id);
const nm = (a) => (a ? a.name[lang] : '?');

// ── time & sleep ──
const params = new URLSearchParams(location.search);
let asleep = false, timeStr = '';
function tick() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: OWNER.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const hh = +parts.find((p) => p.type === 'hour').value, mm = parts.find((p) => p.type === 'minute').value;
  timeStr = `${String(hh % 24).padStart(2, '0')}:${mm}`;
  const forced = params.get('sleep');
  asleep = forced != null ? forced === '1' : hh >= OWNER.sleep.from && hh < OWNER.sleep.to;
  renderer.sleepTarget = asleep && !busy ? 1 : 0;
  $('#clock').textContent = timeStr;
  $('#sleepstate').textContent = asleep ? t().asleep : t().awake;
  // night consolidation: Sydney is asleep and there's enough new experience to sort through
  if (booted && asleep && !busy && !dreaming && memory.newSinceDream() >= 3 && Date.now() - memory.lastDream > 30 * 60e3) runDream(true);
}

// ── language ──
function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach((n) => { const v = t()[n.dataset.t]; if (typeof v === 'string') n.textContent = v; });
  $('#q').placeholder = t().placeholder;
  $('#owner-name').textContent = OWNER.tagline[lang];
  $('#owner-tag').textContent = OWNER.subtitle[lang];
  $('#owner-loc').textContent = `◎ ${OWNER.location[lang]} · ${OWNER.affiliation[lang].replace(/^.*\((\w+)\).*$/, '$1')}`;
  const gh = $('#owner-gh'); gh.href = OWNER.github; gh.textContent = '@' + OWNER.handle;
  $('#owner-links').innerHTML = [
    ...(OWNER.email ? [`<a href="mailto:${esc(OWNER.email)}">email</a>`] : []),
    ...OWNER.links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`),
  ].join(' ');
  $('#about-text').textContent = t().about(OWNER);
  $('#brain-mode').textContent = brain.mode === 'live' && apiKey ? t().brainLive : t().brainSim;
  const chips = $('#chips'); chips.innerHTML = '';
  for (const c of t().chips) { const b = el('button', '', esc(c)); b.type = 'button'; b.onclick = () => { $('#q').value = c; ask(c); }; chips.append(b); }
  buildPhasebar(busy && trace?.topology || topology);
  $('#topo-mode').textContent = TOPOLOGIES[topology].name[lang];
  if (typeof labelMarkers === 'function') { labelMarkers(); refreshLab(); }
  tick();
}
let phaseKeys = TOPOLOGIES.council.phases;
function buildPhasebar(kind) {
  phaseKeys = TOPOLOGIES[kind]?.phases || TOPOLOGIES.council.phases;
  const bar = $('#phasebar'); bar.innerHTML = '';
  for (const k of phaseKeys) { const li = el('li'); li.dataset.k = k; li.title = phaseLabel(k, lang); bar.append(li); }
}

// ── minutes ──
const log = $('#log');
function push(node) {
  log.append(node);
  while (log.children.length > 160) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}
function logLine(a, text, { to, kind, idle } = {}) {
  const target = to === 'board' ? { name: { zh: '▦ 黑板', en: '▦ Board' } } : to && to !== '*' && byId(to);
  const n = el('div', `line${kind === 'hit' || kind === 'reply' ? ' hit' : ''}${idle ? ' idle' : ''}`);
  n.innerHTML = `<span class="g" style="color:${a.color}">${esc(a.glyph)}</span><div><span class="who" style="color:${a.color}">${esc(nm(a))}${target ? ` <em>→ ${esc(nm(target))}</em>` : ''}</span><p>${esc(text)}</p></div>`;
  push(n);
}
function setPhase(k) {
  // a phase this topology doesn't list (the tool phase) is slotted in after the current one
  if (k && !phaseKeys.includes(k)) {
    const cur = [...$('#phasebar').querySelectorAll('li')].findIndex((li) => li.classList.contains('on'));
    phaseKeys = [...phaseKeys.slice(0, cur + 1), k, ...phaseKeys.slice(cur + 1)];
    const bar = $('#phasebar'); bar.innerHTML = '';
    for (const key of phaseKeys) { const li = el('li'); li.dataset.k = key; li.title = phaseLabel(key, lang); bar.append(li); }
  }
  const idx = phaseKeys.indexOf(k);
  $('#phasebar').querySelectorAll('li').forEach((li, i) => { li.className = i < idx ? 'done' : i === idx ? 'on' : ''; });
  $('#phase').textContent = k ? phaseLabel(k, lang) : '';
  if (k) push(el('div', 'sep', esc(phaseLabel(k, lang))));
}
function updateLiveDag() {
  if (!trace) return;
  const dag = buildDag(trace.events);
  const last = dag.nodes[dag.nodes.length - 1];
  $('#dagbox').innerHTML = dagSVG(dag, agents, { width: 400, mini: true, active: last?.id });
}

// ── speech bubble ──
const bubble = $('#bubble');
let bubbleOwner = null, bubbleTimer = null;
function say(id, text, ms) {
  const a = byId(id); if (!a) return;
  bubbleOwner = id;
  bubble.style.setProperty('--bc', a.color);
  bubble.querySelector('b').textContent = `${a.glyph} ${nm(a)}`;
  const span = bubble.querySelector('span');
  bubble.hidden = false;
  const chars = [...text];
  const typeMs = Math.min(ms * 0.65, chars.length * (isCJK(text) ? 45 : 18));
  const t0 = performance.now();
  clearInterval(bubbleTimer);
  bubbleTimer = setInterval(() => {
    const k = Math.min(chars.length, Math.ceil(((performance.now() - t0) / Math.max(1, typeMs * speed)) * chars.length));
    span.textContent = chars.slice(0, k).join('');
    if (k >= chars.length) clearInterval(bubbleTimer);
  }, 30);
}
function hush() { bubbleOwner = null; bubble.hidden = true; clearInterval(bubbleTimer); }
(function trackBubble() {
  if (bubbleOwner) {
    const s = renderer.screenOf(bubbleOwner);
    if (s) {
      const flip = s.x > innerWidth * 0.62;
      bubble.classList.toggle('flip', flip);
      bubble.style.left = `${s.x + (flip ? -s.r : s.r)}px`;
      bubble.style.top = `${s.y - s.r}px`;
    }
  }
  requestAnimationFrame(trackBubble);
})();

// ── toast ──
let toastT;
function toast(msg) { const n = $('#toast'); n.textContent = msg; n.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => n.classList.remove('on'), 2600); }

// ── stats ──
function bump(id, key) {
  stats.agents[id] = stats.agents[id] || { m: 0, w: 0 };
  stats.agents[id][key]++;
  if (key === 'm') stats.thoughts++;
  $('#nthoughts').textContent = stats.thoughts.toLocaleString();
  store.set('stats', stats);
}

// ── tally ──
function renderTally(tally) {
  const box = $('#tally'); box.innerHTML = '';
  if (!tally) return;
  const max = Math.max(1, ...Object.values(tally));
  for (const [id, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    const a = byId(id); if (!a) continue;
    const row = el('div', 'row', `<span style="color:${a.color}">${esc(nm(a))}</span><span class="bar"><i style="background:${a.color}"></i></span><span>${n}</span>`);
    box.append(row);
    requestAnimationFrame(() => (row.querySelector('i').style.width = `${(n / max) * 100}%`));
  }
}

// ── the meeting player ──
const wait = (ms) => new Promise((r) => setTimeout(r, ms * speed));
let liveTally = null;

async function handle(ev) {
  if (trace) { trace.events.push({ ...ev, t: performance.now() }); if (['say', 'dispatch', 'answer', 'recall'].includes(ev.type)) updateLiveDag(); }
  switch (ev.type) {
    case 'tool_call': {
      // a voice reaches out of the head to a tool satellite
      const a = byId(ev.from), tl = TOOL_BY_ID[ev.tool]; if (!a || !tl) break;
      renderer.setThinking([ev.from]);
      renderer.burst(ev.from, 'tool_' + tl.id, 7, { color: a.color, dur: 0.8, lift: 0.3, gap: 0.05 });
      setTimeout(() => renderer.flashCrystal('tool_' + tl.id, 2), 750);
      showToolChip(tl, 'busy');
      const args = JSON.stringify(ev.input || {});
      push(el('div', 'sysrow tool', `⌁ ${esc(t().toolCall(nm(a), tl.name[lang]))}<small><code>${esc(tl.def.name)}(${esc(args.length > 80 ? args.slice(0, 79) + '…' : args)})</code></small>`));
      await wait(700);
      break;
    }
    case 'tool_result': {
      const a = byId(ev.from), tl = TOOL_BY_ID[ev.tool]; if (!a || !tl) break;
      renderer.burst('tool_' + tl.id, ev.from, ev.ok ? 9 : 3, { color: ev.ok ? tl.color : '#ff5470', dur: 0.8, lift: 0.3, gap: 0.04, size: 1.1 });
      renderer.setThinking([]);
      showToolChip(tl, ev.ok ? 'ok' : 'fail', ev.ms);
      const row = el('div', `sysrow tool ${ev.ok ? '' : 'bad'}`, `${ev.ok ? '✓' : '✗'} ${esc(tl.name[lang])} · ${ev.ms ?? '—'}ms<small>${esc(ev.summary || '')}</small>`);
      push(row);
      await wait(700);
      break;
    }
    case 'dispatch': {
      // the orchestrator hands a subtask to a worker
      const a = byId(ev.to); if (!a) break;
      renderer.burst('self', ev.to, 5, { color: '#eaf6ff', dur: 0.7, lift: 0.12, gap: 0.05 });
      renderer.flash(ev.to, 0.8);
      push(el('div', 'sysrow orch', `⇢ ${esc(t().dispatched(nm(a)))}<small>${esc(ev.text)}</small>`));
      const c = wm.push('self', byId('self').name[meetingLang], `→ ${a.name[meetingLang]}: ${ev.text}`, meetingLang);
      updateCtxBar(!!c);
      await wait(650);
      break;
    }
    case 'phase':
      setPhase(ev.key);
      if (ev.key === 'vote') { liveTally = {}; renderTally(liveTally); }
      await wait(380);
      break;
    case 'thinking':
      renderer.setThinking(ev.ids);
      break;
    case 'recall': {
      // similar past meetings light up on their orbit and stream into Memory
      const mem = byId('memory');
      for (const id of ev.ids) {
        renderer.flashCrystal(id, 1.6);
        renderer.burst(id, 'memory', 6, { color: '#ffc24a', dur: 1.0, lift: 0.15, gap: 0.05 });
      }
      push(el('div', 'sysrow mem', `◷ ${esc(t().recalled(ev.ids.length))}`));
      if (mem) renderer.flash('memory', 1);
      await wait(1100);
      break;
    }
    case 'say': {
      const a = byId(ev.from); if (!a) break;
      const thinkingNow = agents.filter((x) => renderer.agents.get(x.id)?.thinking && x.id !== ev.from).map((x) => x.id);
      renderer.setThinking(thinkingNow);
      renderer.setSpeaking(ev.from);
      renderer.flash(ev.from, 0.8);
      bump(ev.from, 'm');
      logLine(a, ev.text, ev);
      { // every line spends working memory; past the budget the oldest lines get folded into a summary
        const c = wm.push(ev.from, a.name[meetingLang], ev.text, meetingLang);
        updateCtxBar(!!c);
        if (c) push(el('div', 'sysrow wmc', `⟲ ${esc(t().compacted(c.n))}<small>${esc(c.summary)}</small>`));
      }
      const ms = clamp(700 + [...ev.text].length * (isCJK(ev.text) ? 70 : 32), 1500, 4600);
      say(ev.from, ev.text, ms);
      if (ev.to === '*') for (const o of agents) { if (o.id !== ev.from) renderer.burst(ev.from, o.id, 2, { color: a.color, delay: 0.2, size: 0.8 }); }
      else if (ev.to) renderer.burst(ev.from, ev.to, 4, { color: a.color, delay: 0.25, dur: 0.85 });
      await wait(ms);
      renderer.setSpeaking(null);
      break;
    }
    case 'vote': {
      const a = byId(ev.from), b = byId(ev.for); if (!a || !b) break;
      renderer.pulse(ev.from, ev.for, { color: a.color, dur: 0.7, size: 1.3 });
      liveTally = liveTally || {};
      liveTally[ev.for] = (liveTally[ev.for] || 0) + 1;
      push(el('div', 'vote', `<span style="color:${a.color}">${esc(nm(a))}</span> ${esc(t().voted)} <span style="color:${b.color}">${esc(nm(b))}</span>`));
      renderTally(liveTally);
      await wait(420);
      break;
    }
    case 'answer': {
      hush();
      const tally = ev.tally || liveTally || {};
      const total = Object.values(tally).reduce((s, n) => s + n, 0);
      const top = Math.max(0, ...Object.values(tally));
      $('#consensus').textContent = total ? Math.round((top / total) * 100) + '%' : '—';
      if (trace) trace.answer = ev.text;
      if (ev.winner) {
        bump(ev.winner, 'w'); renderTally(tally);
        if (trace) trace.winner = ev.winner;
        // the winning voice materialises before the mind answers
        renderer.materialize(ev.winner, 5600);
        setTimeout(() => renderer.wave(ev.winner), 900);
        await wait(1300);
      }
      // everyone converges on Self, then the answer leaves through the mouth
      for (const o of agents) if (o.id !== 'self') renderer.burst(o.id, 'self', 3, { color: o.color, dur: 0.8, size: 0.9 });
      renderer.setSpeaking('self');
      await wait(950);
      renderer.wave('self', '#ffffff');
      renderer.burst('self', 'mouth', 10, { color: '#eaf6ff', dur: 0.6, lift: 0.05, gap: 0.04 });
      await wait(650);
      renderer.burst('mouth', 'front', 16, { color: '#9feaff', dur: 0.9, lift: 0.1, gap: 0.03, size: 1.4 });
      await wait(350);
      const self = byId('self');
      const fin = el('div', 'final');
      fin.innerHTML = `<span class="who" style="color:${self.color};font-family:var(--mono);font-size:11px">${esc(self.glyph)} ${esc(nm(self))}</span><p style="margin:4px 0 0">${linkify(ev.text)}</p>`;
      push(fin);
      bump('self', 'm');
      await typeAnswer(ev.text);
      renderer.setSpeaking(null);
      break;
    }
  }
}

async function typeAnswer(text) {
  const box = $('#answer'), p = $('#answer-text');
  box.hidden = false; p.textContent = ''; document.body.classList.add('has-answer');
  const chars = [...text];
  const per = isCJK(text) ? 26 : 11;
  for (let i = 0; i < chars.length; i += speed < 1 ? 6 : 1) {
    p.textContent = chars.slice(0, i + 1).join('');
    await new Promise((r) => setTimeout(r, per * speed));
  }
  p.innerHTML = linkify(text);
}

async function play(events) {
  for await (const ev of events) await handle(ev);
}

// ── tool chips: a small label that pops up next to a tool satellite while it's being used ──
const chips = new Map();
function showToolChip(tl, state, ms) {
  let c = chips.get(tl.id);
  if (!c) { c = el('div', 'toolchip'); document.body.append(c); chips.set(tl.id, c); }
  c.style.setProperty('--tc', tl.color);
  c.className = `toolchip ${state}`;
  c.innerHTML = `<b>${esc(tl.icon)}</b>${esc(tl.name[lang])}${state === 'busy' ? '<i class="spin"></i>' : state === 'ok' ? ` ✓ <small>${ms}ms</small>` : ' ✗'}`;
  c.hidden = false;
  clearTimeout(c._t);
  if (state !== 'busy') c._t = setTimeout(() => (c.hidden = true), 2600);
}
(function trackChips() {
  for (const [id, c] of chips) {
    if (c.hidden) continue;
    const s = renderer.project(TOOL_BY_ID[id].pos);
    c.style.transform = `translate(${s.x + 14}px, ${s.y - 14}px)`;
  }
  requestAnimationFrame(trackChips);
})();

// Yields the meeting's events, splicing the tool phase in right before the first phase after "perceive".
async function* injectAfterPerceive(gen, toolGen) {
  let done = false;
  for await (const ev of gen) {
    if (!done && ev.type === 'phase' && ev.key !== 'perceive') { done = true; yield* toolGen; }
    yield ev;
  }
  if (!done) yield* toolGen;
}

async function ask(raw, replayEvents) {
  const q = raw.trim();
  if (busy || !q) return;
  busy = true; speed = 1;
  closeRegion();
  renderer.release();
  lastQuestion = q;
  const kind = replayEvents ? (lastTrace?.topology || 'council') : topology;
  trace = { q, topology: kind, mode: replayEvents ? 'replay' : brain.mode === 'live' && apiKey ? 'live' : 'sim', start: performance.now(), events: [], ts: Date.now() };
  buildPhasebar(kind);
  $('#dagbox').innerHTML = '';
  $('#ask-btn').disabled = true; $('#ask-btn').textContent = t().thinking;
  $('#btn-skip').hidden = false;
  $('#minutes').classList.add('live');
  $('#minutes').classList.remove('collapsed');
  $('#answer').hidden = true; document.body.classList.remove('has-answer'); $('#agent-card').hidden = true; hush();
  renderTally(null); liveTally = null;
  renderer.sleepTarget = 0; renderer.focusTarget = 1;
  push(el('div', 'ask', `<b style="font-family:var(--mono);font-size:10px;letter-spacing:.2em;color:var(--cyan)">INPUT</b><br>${esc(q)}`));
  $('#q').value = '';

  const live = brain.mode === 'live' && apiKey;
  // simulated brain: the rule router plans tool calls now, and they run while the question flies in
  const toolPlan = replayEvents || live ? [] : planTools(q, OWNER);
  const qlang0 = isCJK(q) ? 'zh' : /[a-z]/i.test(q) ? 'en' : lang;
  const toolRuns = Promise.all(toolPlan.map((p) => executeTool(p.tool, p.input, { lang: qlang0, owner: OWNER }, 'meeting').then((r) => ({ ...p, name: TOOL_BY_ID[p.tool].def.name, ...r }))));

  // the question flies in through the ear
  renderer.burst('outside', 'earR', 14, { color: '#4ff0ff', dur: 0.9, lift: 0.3, gap: 0.05, size: 1.2 });
  await wait(1100);
  renderer.burst('earR', 'self', 8, { color: '#4ff0ff', dur: 0.6, lift: 0.08, gap: 0.04 });
  await wait(650);
  renderer.wave('self', '#4ff0ff');

  const qlang = qlang0;
  meetingLang = qlang;
  wm.reset(q); updateCtxBar();
  // long-term recall: similar, not-yet-forgotten meetings surface (and get stronger for it)
  const recalled = replayEvents ? [] : memory.recall(q).map((h) => ({
    id: h.e.id, q: h.e.q, a: h.e.a, score: h.score, agoText: ago(h.e.ts, qlang),
    winnerName: agents.find((x) => x.id === h.e.winner)?.name[qlang] || '',
  }));
  const ctx = { lang: qlang, owner: OWNER, timeStr, asleep, apiKey, model: brain.model, recalled, workingMemory: () => wm.toText(), toolResults: [] };
  // tool results must exist before the simulated meeting is scripted, so its answer can use them
  ctx.toolResults = await toolRuns;
  const okNotes = ctx.toolResults.filter((r) => r.ok).map((r) => r.note);
  if (okNotes.length) ctx.toolNote = okNotes.join(' ');
  // the tool phase slots in right after "perceive", before the voices start talking
  const toolGen = replayEvents ? null : live ? claudeToolPhase(q, agents, ctx) : ctx.toolResults.length ? toolEvents(ctx.toolResults, qlang, agents) : null;
  const withTools = (gen) => (toolGen ? injectAfterPerceive(gen, toolGen) : gen);
  try {
    if (replayEvents) await play(replayEvents.map(({ t: _t, ...ev }) => ev).filter((ev) => !ev.from || byId(ev.from)));
    else if (kind === 'council') await play(withTools(live ? llmMeeting(q, agents, ctx) : simMeeting(q, agents, ctx)));
    else {
      const b = live ? await makeLLMBrain(q, agents, ctx, simBrain(q, agents, ctx).weights) : simBrain(q, agents, ctx);
      await play(withTools(runTopology(kind, q, agents, ctx, b)));
    }
  } catch (e) {
    renderer.setThinking([]);
    push(el('div', 'err', esc(t().errorPrefix + (e.message || e))));
    toast(t().fallback);
    trace.events = []; wm.reset(q); updateCtxBar(); buildPhasebar(kind);
    const okFetched = ctx.toolResults.filter((r) => r.ok);
    ctx.toolNote = okFetched.map((r) => r.note).filter(Boolean).join(' ') || undefined;
    const fb = kind === 'council' ? simMeeting(q, agents, ctx) : runTopology(kind, q, agents, ctx, simBrain(q, agents, ctx));
    await play(okFetched.length ? injectAfterPerceive(fb, toolEvents(okFetched, qlang, agents)) : fb);
  } finally {
    trace.end = performance.now();
    wmLast = wm.snapshot(); if (!replayEvents) store.set('wm', wmLast);
    if (!replayEvents) {
      lastTrace = trace;
      if (trace.answer) {
        // the meeting crystallises into a long-term memory that joins the orbit
        const e = memory.add({ q, a: trace.answer, winner: trace.winner || null, lang: qlang });
        syncCrystals();
        renderer.burst('self', e.id, 10, { color: byId(trace.winner)?.color || '#ffc24a', dur: 1.1, lift: 0.35, gap: 0.04, size: 1.1 });
        setTimeout(() => renderer.flashCrystal(e.id, 1.8), 1100);
        push(el('div', 'sysrow mem', `◆ ${esc(t().crystallized)}`));
      }
    }
    trace = null;
    busy = false; speed = 1;
    renderer.setThinking([]); renderer.setSpeaking(null); renderer.focusTarget = 0;
    setPhase(null);
    $('#ask-btn').disabled = false; $('#ask-btn').textContent = t().ask;
    $('#btn-skip').hidden = true;
    $('#minutes').classList.remove('live');
    tick();
  }
}

// ── idle life ──
let idleIdx = Math.floor(Math.random() * 20), beats = 2;
function idleBeat() {
  if (busy || !booted || document.hidden || !$('#answer').hidden || renderer.stageId || labOpen || !card.hidden) return;
  if (asleep) {
    const d = byId('dreamer'); if (!d) return;
    const text = rand(DREAMS[lang]);
    renderer.burst('dreamer', rand(agents).id, 2, { color: d.color, size: 0.7, dur: 1.6 });
    say('dreamer', text, 3200); renderer.setSpeaking('dreamer');
    setTimeout(() => { if (!busy) { hush(); renderer.setSpeaking(null); } }, 3200);
    return;
  }
  // every few beats, one voice steps out and shows its true form
  if (++beats % 4 === 0 && !renderer.stageId && !document.querySelector('dialog[open]') && !labOpen) {
    const a = rand(agents);
    const text = `「${formName(a, lang)}」—— ${a.role[lang]}`;
    renderer.materialize(a.id, 6200);
    setTimeout(() => { if (busy || renderer.stageId !== a.id) return; say(a.id, text, 4200); renderer.setSpeaking(a.id); }, 1200);
    setTimeout(() => { if (!busy && bubbleOwner === a.id) { hush(); renderer.setSpeaking(null); } }, 5600);
    return;
  }
  const imps = agents.filter((a) => !a.core);
  let from, to, text;
  if (imps.length && Math.random() < 0.3) {
    const a = rand(imps); from = a.id; to = 'self'; text = rand(STYLES[a.style].say[lang]).replace('{q}', '…');
  } else {
    const line = IDLE[lang][idleIdx++ % IDLE[lang].length];
    [from, to, text] = line;
  }
  const a = byId(from); if (!a) return;
  renderer.burst(from, to, 3, { color: a.color, dur: 0.9 });
  renderer.setSpeaking(from);
  say(from, text, 2800);
  logLine(a, text, { to, idle: true });
  setTimeout(() => { if (!busy) { hush(); renderer.setSpeaking(null); } }, 2800);
}
setInterval(idleBeat, 7200);

// ── agent card ──
const card = $('#agent-card');
$('#mind').addEventListener('click', (e) => {
  // a memory crystal: open the Memory lab on that episode
  const cid = !renderer.hitTest(e.clientX, e.clientY) && renderer.crystalAt(e.clientX, e.clientY);
  if (cid && !busy) {
    labFocus = cid;
    renderer.flashCrystal(cid, 1.5);
    // a tool satellite opens the Tools lab; a memory crystal opens the Memory lab
    openRegion(REGIONS.find((r) => r.id === (cid.startsWith('tool_') ? 'tools' : 'memory')));
    return;
  }
  const id = renderer.hitTest(e.clientX, e.clientY);
  if (!id) { card.hidden = true; return; }
  const a = byId(id); const s = stats.agents[id] || { m: 0, w: 0 };
  card.style.setProperty('--ac', a.color);
  card.querySelector('.ac-glyph').textContent = a.glyph;
  card.querySelector('.ac-name').textContent = nm(a) + (a.core ? '' : ` · ${STYLES[a.style].label[lang]}`);
  card.querySelector('.ac-stats').textContent = `${t().formLabel}: ${formName(a, lang)} · ${t().stats(s.m, s.w)}`;
  card.querySelector('.ac-role').textContent = a.role[lang];
  const acts = card.querySelector('.ac-actions'); acts.innerHTML = '';
  if (!a.core) {
    const share = el('button', 'ghost tiny', esc(t().share)); share.onclick = () => copyShare(a.implant);
    const rm = el('button', 'ghost tiny', esc(t().remove)); rm.onclick = () => removeImplant(a);
    acts.append(share, rm);
  }
  card.hidden = false;
  // step the voice out into its creature form, and park the card beside it
  if (!busy) { renderer.materialize(id); hush(); }
  let x = e.clientX + 16, y = e.clientY - 20;
  if (!busy && renderer.stageWorld) {
    const st = renderer.toScreen(renderer.stageWorld());
    const r = renderer.pxRadius(renderer.stageWorld(), 0.62);
    x = st.x + r * 0.95; y = st.y - r * 0.6;
    if (x + 320 > innerWidth) x = st.x - r * 0.95 - 320;
  }
  card.style.left = clamp(x, 8, innerWidth - 326) + 'px'; card.style.top = clamp(y, 8, innerHeight - 240) + 'px';
  renderer.flash(id, 1); renderer.wave(id);
});
function hideCard() { if (card.hidden) return; card.hidden = true; if (!busy) renderer.release(); }
document.addEventListener('pointerdown', (e) => { if (!card.contains(e.target) && e.target !== $('#mind')) hideCard(); });
$('#mind').addEventListener('pointerdown', (e) => { if (!renderer.hitTest(e.clientX, e.clientY)) hideCard(); });

// ── brain atlas ──
let atlasOn = false, labOpen = null, routeTimer = null;
const markers = $('#atlas-markers');
for (const r of REGIONS) {
  const b = el('button', 'marker'); b.type = 'button'; b.dataset.id = r.id; b.style.setProperty('--rc', r.color);
  b.innerHTML = `<i></i><span></span>`;
  b.onclick = () => openRegion(r);
  markers.append(b);
}
function labelMarkers() {
  markers.querySelectorAll('.marker').forEach((b) => {
    const r = REGIONS.find((x) => x.id === b.dataset.id);
    b.querySelector('span').textContent = `${r.lab} · ${r.name[lang]}`;
    b.title = `${r.organ[lang]} · ${r.name[lang]}`;
  });
}
(function trackMarkers() {
  if (atlasOn && booted) {
    markers.querySelectorAll('.marker').forEach((b) => {
      const r = REGIONS.find((x) => x.id === b.dataset.id);
      const s = renderer.project(r.pos);
      b.style.transform = `translate(${s.x}px, ${s.y}px)`;
      b.classList.toggle('back', !s.front);
      b.classList.toggle('on', labOpen === r.id);
    });
  }
  requestAnimationFrame(trackMarkers);
})();
function setAtlas(on) {
  atlasOn = on;
  document.body.classList.toggle('atlas', on);
  $('#btn-atlas').classList.toggle('on', on);
  if (!on) closeRegion();
}
function labCtx() {
  return {
    agents, lastTrace, lastQuestion, memory, wmLast, focusId: labFocus, handle: '@' + OWNER.handle,
    onRecallPreview(ids) { for (const id of ids) renderer.flashCrystal(id, 1.3); },
    owner: OWNER,
    async onTryTool(id, input) {
      const tl = TOOL_BY_ID[id];
      const from = byId(tl.owner) ? tl.owner : 'self';
      renderer.burst(from, 'tool_' + id, 6, { color: byId(from).color, dur: 0.7, lift: 0.3, gap: 0.05 });
      showToolChip(tl, 'busy');
      const r = await executeTool(id, input, { lang, owner: OWNER }, 'lab');
      renderer.burst('tool_' + id, from, r.ok ? 8 : 3, { color: r.ok ? tl.color : '#ff5470', dur: 0.7, lift: 0.3, gap: 0.04 });
      renderer.flashCrystal('tool_' + id, 2);
      showToolChip(tl, r.ok ? 'ok' : 'fail', r.ms);
      return r;
    },
    onPreviewTool(id) { renderer.flashCrystal('tool_' + id, 1.2); },
    onDream() { runDream(false); },
    phaseName: (k) => phaseLabel(k, lang),
    topology,
    onTopology(k) {
      if (!TOPOLOGIES[k]) return;
      topology = k; store.set('topology', k);
      $('#topo-mode').textContent = TOPOLOGIES[k].name[lang];
      if (!busy) buildPhasebar(k);
      refreshLab();
    },
    // A/B: run the same question through two topologies with the simulated brain, instantly
    async onCompare(q, kinds) {
      const qlang = isCJK(q) ? 'zh' : /[a-z]/i.test(q) ? 'en' : lang;
      const out = [];
      for (const k of kinds) {
        const ctx = { lang: qlang, owner: OWNER, timeStr, asleep: false, recalled: [] };
        const events = [];
        for await (const ev of runTopology(k, q, agents, ctx, simBrain(q, agents, ctx))) events.push(ev);
        const dag = buildDag(events);
        out.push({ kind: k, events, dag, metrics: dagMetrics(dag, events), answer: events.find((e) => e.type === 'answer')?.text || '' });
      }
      return out;
    },
    facts: [
      ['GitHub', '@' + OWNER.handle],
      [lang === 'zh' ? '城市' : 'City', OWNER.location[lang]],
      [lang === 'zh' ? '机构' : 'Affiliation', OWNER.affiliation[lang]],
      [lang === 'zh' ? '方向' : 'Focus', OWNER.focus[lang]],
      ...(OWNER.email ? [['Email', OWNER.email]] : []),
    ],
    onForget() { memory.forget(); syncCrystals(); refreshLab(); },
    onReplay() { if (lastTrace && !busy) ask(lastTrace.q, lastTrace.events); },
    onExport() {
      if (!lastTrace) return;
      const data = { question: lastTrace.q, mode: lastTrace.mode, startedAt: new Date(lastTrace.ts).toISOString(), durationMs: Math.round(lastTrace.end - lastTrace.start), events: lastTrace.events.map((e) => ({ ...e, t: Math.round(e.t - lastTrace.start) })) };
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = `uplink-trace-${lastTrace.ts}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
    onRoute(weights, k) {
      clearTimeout(routeTimer);
      routeTimer = setTimeout(() => {
        const r = REGIONS.find((x) => x.id === 'router');
        Object.entries(weights).sort((x, y) => y[1] - x[1]).slice(0, k).forEach(([id, w]) => {
          const a = byId(id); if (a) renderer.burst(r.pos, id, Math.max(2, Math.round(w * 14)), { color: a.color, dur: 0.8, lift: 0.12, gap: 0.04, size: 0.6 + w });
        });
      }, 250);
    },
  };
}
function refreshLab() {
  const r = REGIONS.find((x) => x.id === labOpen); if (!r) return;
  const box = $('#lab-body');
  box.innerHTML = renderLab(r, lang, labCtx());
  bindLab(box, r, lang, labCtx());
}
// ── dreaming: cluster similar memories, distil each cluster into an insight ──
let dreaming = false;
async function runDream(auto) {
  if (dreaming || busy) return;
  dreaming = true;
  const live = brain.mode === 'live' && apiKey;
  const groupsPreview = memory.clusters();
  // every memory that's about to be consolidated drifts into Memory first
  groupsPreview.flat().forEach((e, i) => setTimeout(() => {
    renderer.flashCrystal(e.id, 1.4);
    renderer.burst(e.id, 'memory', 4, { color: '#ffd98a', dur: 1.2, lift: 0.2, gap: 0.06 });
  }, i * 140));
  if (groupsPreview.length && !labOpen) renderer.materialize('memory', 4200);
  const res = await memory.dream(lang, live ? (qs, l) => summariseCluster(qs, l, { apiKey, model: brain.model }) : null);
  await new Promise((r) => setTimeout(r, 400 + groupsPreview.flat().length * 140));
  syncCrystals();
  for (const ins of res.insights) setTimeout(() => { renderer.burst('memory', ins.id, 10, { color: '#ffd98a', dur: 1.1, lift: 0.3, gap: 0.04 }); renderer.flashCrystal(ins.id, 2); }, 300);
  const mem = byId('memory');
  if (res.insights.length) {
    push(el('div', 'sysrow dream', `☾ ${esc(t().dreamDone(res.insights.length, auto))}`));
    for (const ins of res.insights) if (mem) logLine(mem, ins.text, { idle: auto });
  } else push(el('div', 'sysrow dream', `☾ ${esc(t().dreamNone)}`));
  toast(res.insights.length ? t().dreamDone(res.insights.length, auto) : t().dreamNone);
  dreaming = false;
  refreshLab();
}

function openRegion(r) {
  if (busy) return;
  if (!atlasOn) setAtlas(true);
  labOpen = r.id;
  hideCard(); hush();
  renderer.focusOn(r.pos, r.color);
  $('#lab').style.setProperty('--rc', r.color);
  $('#lab').hidden = false;
  document.body.classList.add('lab-open');
  refreshLab();
}
function closeRegion() {
  if (!labOpen) return;
  labOpen = null; labFocus = null;
  renderer.focusOn(null);
  $('#lab').hidden = true;
  document.body.classList.remove('lab-open');
}
$('#btn-atlas').onclick = () => setAtlas(!atlasOn);
$('#btn-topo').onclick = () => openRegion(REGIONS.find((r) => r.id === 'orchestration'));
$('#lab-close').onclick = closeRegion;
addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeRegion(); hideCard(); } });

// ── implants ──
function addImplant(raw) {
  const imp = sanitizeImplant(raw);
  if (implants.length >= 6) { toast(t().full); return false; }
  implants.push(imp); store.set('implants', implants);
  const k = implants.length - 1;
  const id = implantToAgent(imp, k).id;
  buildAgents(id);
  renderer.burst('front', id, 12, { color: imp.color, dur: 1.1, lift: 0.4, gap: 0.04, size: 1.3 });
  setTimeout(() => { renderer.wave(id); renderer.flash(id, 1.4); }, 1200);
  setTimeout(() => {
    const self = byId('self');
    if (!busy && self) { say('self', t().welcome(imp.label), 2600); renderer.setSpeaking('self'); logLine(self, t().welcome(imp.label), { to: id }); setTimeout(() => { if (!busy) { hush(); renderer.setSpeaking(null); } }, 2600); }
  }, 1500);
  toast(t().implanted(imp.label));
  return true;
}
function removeImplant(a) {
  const idx = implants.indexOf(a.implant);
  if (idx < 0) return;
  implants.splice(idx, 1); store.set('implants', implants);
  buildAgents(); card.hidden = true; toast(t().removed(a.implant.label));
}
function shareUrl(imp) { return `${location.origin}${location.pathname}#implant=${encodeAgent(imp)}`; }
async function copyShare(imp) {
  const url = shareUrl(imp);
  try { await navigator.clipboard.writeText(url); toast(t().copied); } catch { prompt('URL', url); }
}

// implant dialog
const dlgI = $('#dlg-implant');
const draft = { label: '', glyph: GLYPHS[0], color: PALETTE[5], style: 'poet', desc: '' };
function swatches(box, items, key, render) {
  box.innerHTML = '';
  for (const it of items) {
    const b = el('button'); b.type = 'button'; render(b, it);
    b.classList.toggle('on', draft[key] === it);
    b.onclick = () => { draft[key] = it; box.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
    box.append(b);
  }
}
function openImplant() {
  draft.glyph = rand(GLYPHS); draft.color = rand(PALETTE); draft.style = rand(Object.keys(STYLES));
  $('#im-name').value = ''; $('#im-desc').value = ''; $('#im-desc').placeholder = t().descPh;
  swatches($('#im-glyphs'), GLYPHS, 'glyph', (b, g) => (b.textContent = g));
  swatches($('#im-colors'), PALETTE, 'color', (b, c) => (b.style.background = c));
  const sb = $('#im-styles'); sb.innerHTML = '';
  for (const k of Object.keys(STYLES)) {
    const b = el('button', draft.style === k ? 'on' : '', esc(STYLES[k].label[lang])); b.type = 'button';
    b.onclick = () => { draft.style = k; sb.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
    sb.append(b);
  }
  dlgI.showModal(); drawSeed();
}
function readDraft() { return { ...draft, label: $('#im-name').value.trim() || (lang === 'zh' ? '回声' : 'Echo'), desc: $('#im-desc').value.trim() }; }
dlgI.addEventListener('close', () => { if (dlgI.returnValue === 'ok') addImplant(readDraft()); });
$('#im-share').onclick = () => copyShare(sanitizeImplant(readDraft()));
function drawSeed() {
  const cv = $('#seed'), c = cv.getContext('2d');
  const loop = (now) => {
    if (!dlgI.open) return;
    const t0 = now / 1000;
    c.clearRect(0, 0, 160, 160);
    c.globalCompositeOperation = 'lighter';
    const col = draft.color, r = 22 + Math.sin(t0 * 2) * 3;
    const g = c.createRadialGradient(80, 80, 0, 80, 80, 70);
    g.addColorStop(0, col + 'aa'); g.addColorStop(0.4, col + '33'); g.addColorStop(1, col + '00');
    c.fillStyle = g; c.beginPath(); c.arc(80, 80, 70, 0, Math.PI * 2); c.fill();
    c.fillStyle = col; c.beginPath(); c.arc(80, 80, r * 0.7, 0, Math.PI * 2); c.fill();
    c.strokeStyle = col; c.lineWidth = 1.2;
    for (let k = 0; k < 3; k++) { const s = t0 * 1.5 + (k * Math.PI * 2) / 3; c.beginPath(); c.arc(80, 80, 44, s, s + 0.9); c.stroke(); }
    for (let k = 0; k < 14; k++) { const a = t0 * 0.6 + k; const rr = 30 + ((t0 * 20 + k * 13) % 40); c.fillStyle = col + '88'; c.fillRect(80 + Math.cos(a) * rr, 80 + Math.sin(a) * rr, 1.6, 1.6); }
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = '#021018'; c.font = '600 18px "JetBrains Mono", monospace'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(draft.glyph, 80, 81);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// incoming persona from a shared link
function checkIncoming() {
  const m = location.hash.match(/implant=([\w-]+)/);
  if (!m) return;
  const imp = decodeAgent(m[1]);
  history.replaceState(null, '', location.pathname + location.search);
  if (!imp) return;
  $('#incoming-text').textContent = t().incoming(imp.label);
  $('#incoming').hidden = false;
  $('#incoming-yes').onclick = () => { $('#incoming').hidden = true; addImplant(imp); };
  $('#incoming-no').onclick = () => ($('#incoming').hidden = true);
}

// ── brain dialog ──
const dlgB = $('#dlg-brain');
const sel = $('#model');
for (const m of MODELS) sel.append(new Option(m.label, m.id));
function syncLiveFields() { $('#live-fields').style.opacity = dlgB.querySelector('input[name=mode]:checked')?.value === 'live' ? 1 : 0.4; }
$('#btn-brain').onclick = () => {
  dlgB.querySelector(`input[value=${brain.mode}]`).checked = true;
  $('#api-key').value = apiKey; sel.value = brain.model; syncLiveFields(); dlgB.showModal();
};
dlgB.querySelectorAll('input[name=mode]').forEach((r) => (r.onchange = syncLiveFields));
$('#key-clear').onclick = () => { apiKey = ''; $('#api-key').value = ''; store.set('key', ''); };
dlgB.addEventListener('close', () => {
  if (dlgB.returnValue !== 'ok') return;
  brain.mode = dlgB.querySelector('input[name=mode]:checked').value;
  brain.model = sel.value;
  apiKey = $('#api-key').value.trim();
  if (brain.mode === 'live' && !apiKey) { brain.mode = 'sim'; toast(t().keyNeeded); }
  store.set('brain', brain); store.set('key', apiKey);
  applyLang();
});

// ── misc wiring ──
$('#ask').addEventListener('submit', (e) => { e.preventDefault(); ask($('#q').value); });
$('#btn-skip').onclick = () => { speed = 0.12; };
$('#btn-implant').onclick = openImplant;
$('#btn-about').onclick = () => $('#dlg-about').showModal();
$('#btn-lang').onclick = () => { lang = lang === 'zh' ? 'en' : 'zh'; store.set('lang', lang); applyLang(); };
$('#answer-close').onclick = () => { $('#answer').hidden = true; document.body.classList.remove('has-answer'); };
$('#btn-collapse').onclick = () => $('#minutes').classList.toggle('collapsed');
addEventListener('keydown', (e) => { if (e.key === '/' && document.activeElement !== $('#q') && !document.querySelector('dialog[open]')) { e.preventDefault(); $('#q').focus(); } });
if (innerWidth <= 960) $('#minutes').classList.add('collapsed');

// ── boot ──
async function boot() {
  buildAgents();
  syncCrystals();
  setInterval(syncCrystals, 60e3); // retention keeps decaying while the page is open
  applyLang();
  $('#nthoughts').textContent = stats.thoughts.toLocaleString();
  setInterval(tick, 15000);
  const lines = lang === 'zh'
    ? ['> 挂载皮层 ........ ok', `> 唤醒 ${agents.length} 个人格 ... ok`, '> 校准分歧阈值 .... ok', `> 悉尼 ${timeStr} · ${asleep ? '进入睡眠' : '清醒'}`, '> NEURAL UPLINK 已建立']
    : ['> mounting cortex ........ ok', `> waking ${agents.length} voices ....... ok`, '> calibrating disagreement ok', `> sydney ${timeStr} · ${asleep ? 'asleep' : 'awake'}`, '> NEURAL UPLINK established'];
  const pre = $('#boot-log');
  const quick = params.has('nointro');
  for (const l of lines) { pre.textContent += l + '\n'; if (!quick) await new Promise((r) => setTimeout(r, 260)); }
  if (!quick) await new Promise((r) => setTimeout(r, 300));
  $('#boot').classList.add('done');
  renderer.assemble = 0;
  booted = true;
  checkIncoming();
  setTimeout(() => {
    if (busy) return;
    const self = byId('self');
    const hello = asleep
      ? (lang === 'zh' ? `嘘……悉尼现在 ${timeStr}，大家在睡觉。但你可以把我们叫醒。` : `Shh… it's ${timeStr} in Sydney, everyone's asleep. You can still wake us.`)
      : (lang === 'zh' ? '有访客。欢迎——随便问我点什么，我们会为你开一场会。' : 'A visitor. Welcome — ask me anything and we\'ll hold a meeting about it.');
    say('self', hello, 3600); renderer.setSpeaking('self'); logLine(self, hello, { idle: true });
    setTimeout(() => { if (!busy) { hush(); renderer.setSpeaking(null); } }, 3600);
  }, 2600);
  const q = params.get('q');
  if (q) setTimeout(() => ask(q), 3200);
}
boot();
