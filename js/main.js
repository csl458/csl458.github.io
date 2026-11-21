import { OWNER } from './config.js';
import { T } from './i18n.js';
import { CORE, STYLES, PALETTE, GLYPHS, corePosition, implantPosition, implantToAgent, sanitizeImplant, encodeAgent, decodeAgent } from './agents.js';
import { MindRenderer } from './renderer.js';
import { simMeeting, isCJK, IDLE, DREAMS } from './sim.js';
import { llmMeeting, MODELS } from './llm.js';

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
const stats = Object.assign({ thoughts: 0, agents: {} }, store.get('stats', {}));
let busy = false, speed = 1, booted = false;
let agents = [];
const t = () => T[lang];

// ── mind ──
const renderer = new MindRenderer($('#mind'));
window.__mind = renderer; // handy for poking at it from devtools
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
  const bar = $('#phasebar'); bar.innerHTML = '';
  for (const k of Object.keys(t().phases)) { const li = el('li'); li.dataset.k = k; li.title = t().phases[k]; bar.append(li); }
  tick();
}

// ── minutes ──
const log = $('#log');
function push(node) {
  log.append(node);
  while (log.children.length > 160) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}
function logLine(a, text, { to, kind, idle } = {}) {
  const target = to && to !== '*' && byId(to);
  const n = el('div', `line${kind === 'hit' || kind === 'reply' ? ' hit' : ''}${idle ? ' idle' : ''}`);
  n.innerHTML = `<span class="g" style="color:${a.color}">${esc(a.glyph)}</span><div><span class="who" style="color:${a.color}">${esc(nm(a))}${target ? ` <em>→ ${esc(nm(target))}</em>` : ''}</span><p>${esc(text)}</p></div>`;
  push(n);
}
function setPhase(k) {
  const keys = Object.keys(t().phases);
  const idx = keys.indexOf(k);
  $('#phasebar').querySelectorAll('li').forEach((li, i) => { li.className = i < idx ? 'done' : i === idx ? 'on' : ''; });
  $('#phase').textContent = k ? t().phases[k] : '';
  if (k) push(el('div', 'sep', esc(t().phases[k])));
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
  switch (ev.type) {
    case 'phase':
      setPhase(ev.key);
      if (ev.key === 'vote') { liveTally = {}; renderTally(liveTally); }
      await wait(380);
      break;
    case 'thinking':
      renderer.setThinking(ev.ids);
      break;
    case 'say': {
      const a = byId(ev.from); if (!a) break;
      const thinkingNow = agents.filter((x) => renderer.agents.get(x.id)?.thinking && x.id !== ev.from).map((x) => x.id);
      renderer.setThinking(thinkingNow);
      renderer.setSpeaking(ev.from);
      renderer.flash(ev.from, 0.8);
      bump(ev.from, 'm');
      logLine(a, ev.text, ev);
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
      if (ev.winner) { bump(ev.winner, 'w'); renderer.wave(ev.winner); renderTally(tally); }
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

async function ask(raw) {
  const q = raw.trim();
  if (busy || !q) return;
  busy = true; speed = 1;
  $('#ask-btn').disabled = true; $('#ask-btn').textContent = t().thinking;
  $('#btn-skip').hidden = false;
  $('#minutes').classList.add('live');
  $('#minutes').classList.remove('collapsed');
  $('#answer').hidden = true; document.body.classList.remove('has-answer'); $('#agent-card').hidden = true; hush();
  renderTally(null); liveTally = null;
  renderer.sleepTarget = 0; renderer.focusTarget = 1;
  push(el('div', 'ask', `<b style="font-family:var(--mono);font-size:10px;letter-spacing:.2em;color:var(--cyan)">INPUT</b><br>${esc(q)}`));
  $('#q').value = '';

  // the question flies in through the ear
  renderer.burst('outside', 'earR', 14, { color: '#4ff0ff', dur: 0.9, lift: 0.3, gap: 0.05, size: 1.2 });
  await wait(1100);
  renderer.burst('earR', 'self', 8, { color: '#4ff0ff', dur: 0.6, lift: 0.08, gap: 0.04 });
  await wait(650);
  renderer.wave('self', '#4ff0ff');

  const qlang = isCJK(q) ? 'zh' : /[a-z]/i.test(q) ? 'en' : lang;
  const ctx = { lang: qlang, owner: OWNER, timeStr, asleep, apiKey, model: brain.model };
  try {
    if (brain.mode === 'live' && apiKey) await play(llmMeeting(q, agents, ctx));
    else await play(simMeeting(q, agents, ctx));
  } catch (e) {
    renderer.setThinking([]);
    push(el('div', 'err', esc(t().errorPrefix + (e.message || e))));
    toast(t().fallback);
    await play(simMeeting(q, agents, ctx));
  } finally {
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
let idleIdx = Math.floor(Math.random() * 20);
function idleBeat() {
  if (busy || !booted || document.hidden || !$('#answer').hidden) return;
  if (asleep) {
    const d = byId('dreamer'); if (!d) return;
    const text = rand(DREAMS[lang]);
    renderer.burst('dreamer', rand(agents).id, 2, { color: d.color, size: 0.7, dur: 1.6 });
    say('dreamer', text, 3200); renderer.setSpeaking('dreamer');
    setTimeout(() => { if (!busy) { hush(); renderer.setSpeaking(null); } }, 3200);
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
  const id = renderer.hitTest(e.clientX, e.clientY);
  if (!id) { card.hidden = true; return; }
  const a = byId(id); const s = stats.agents[id] || { m: 0, w: 0 };
  card.style.setProperty('--ac', a.color);
  card.querySelector('.ac-glyph').textContent = a.glyph;
  card.querySelector('.ac-name').textContent = nm(a) + (a.core ? '' : ` · ${STYLES[a.style].label[lang]}`);
  card.querySelector('.ac-stats').textContent = t().stats(s.m, s.w);
  card.querySelector('.ac-role').textContent = a.role[lang];
  const acts = card.querySelector('.ac-actions'); acts.innerHTML = '';
  if (!a.core) {
    const share = el('button', 'ghost tiny', esc(t().share)); share.onclick = () => copyShare(a.implant);
    const rm = el('button', 'ghost tiny', esc(t().remove)); rm.onclick = () => removeImplant(a);
    acts.append(share, rm);
  }
  card.hidden = false;
  const x = clamp(e.clientX + 16, 8, innerWidth - 276), y = clamp(e.clientY - 20, 8, innerHeight - 220);
  card.style.left = x + 'px'; card.style.top = y + 'px';
  renderer.flash(id, 1); renderer.wave(id);
});
document.addEventListener('pointerdown', (e) => { if (!card.contains(e.target) && e.target !== $('#mind')) card.hidden = true; });

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
