// Orchestration: five ways to run the same group of agents, written once against a "brain" interface
// (simulated or Claude), plus DAG building, metrics and drawing for the execution graph.
import { routeScores, simVoice, recallEvents, simMeeting } from './sim.js';
import { tokens } from './memory.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const PHASES = {
  perceive: { zh: '感知', en: 'Perceive' }, diverge: { zh: '发散', en: 'Diverge' }, clash: { zh: '交锋', en: 'Clash' },
  vote: { zh: '表决', en: 'Vote' }, synth: { zh: '合成', en: 'Synthesise' },
  relay: { zh: '接力', en: 'Relay' }, plan: { zh: '拆解', en: 'Plan' }, work: { zh: '执行', en: 'Work' }, aggregate: { zh: '汇总', en: 'Aggregate' },
  open: { zh: '立论', en: 'Open' }, rebut: { zh: '反驳', en: 'Rebut' }, judge: { zh: '裁决', en: 'Judge' },
  post: { zh: '张贴', en: 'Post' }, converge: { zh: '收敛', en: 'Converge' },
};
export const phaseLabel = (k, lang) => PHASES[k]?.[lang] || k;

export const TOPOLOGIES = {
  council: {
    phases: ['perceive', 'diverge', 'clash', 'vote', 'synth'],
    name: { zh: '议会', en: 'Council' }, icon: '◎',
    desc: { zh: '所有人格各自发言、互相反驳、投票，「自我」按票数合成。观点最多元，消息也最多。', en: 'Everyone proposes, rebuts and votes; Self synthesises by the vote. Most diverse, most messages.' },
  },
  pipeline: {
    phases: ['perceive', 'relay', 'synth'],
    name: { zh: '流水线', en: 'Pipeline' }, icon: '→',
    desc: { zh: '像接力赛：每个人格只看上一棒的输出，在它的基础上推进一步。依赖链最长，没有并行。', en: 'A relay: each voice sees only the previous leg and pushes it one step further. Longest chain, no parallelism.' },
  },
  hierarchy: {
    phases: ['perceive', 'plan', 'work', 'aggregate'],
    name: { zh: '层级', en: 'Hierarchy' }, icon: '⋔',
    desc: { zh: '「自我」当编排者：把问题拆成子任务，派给最合适的人格并行执行，再汇总。最省消息，并行度高。', en: 'Self orchestrates: splits the question into subtasks, dispatches them to the best voices in parallel, then aggregates. Fewest messages, high parallelism.' },
  },
  debate: {
    phases: ['perceive', 'open', 'rebut', 'judge'],
    name: { zh: '辩论', en: 'Debate' }, icon: '⇄',
    desc: { zh: '路由选出正方，「怀疑」当反方，立论、反驳，其他人格当观众投票，「自我」裁决。最能暴露分歧。', en: 'The router picks the proposer, Skeptic opposes; opening, rebuttal, the audience votes, Self rules. Best at surfacing disagreement.' },
  },
  blackboard: {
    phases: ['perceive', 'post', 'converge'],
    name: { zh: '黑板', en: 'Blackboard' }, icon: '▦',
    desc: { zh: '问题写在共享黑板上，没有指挥：哪个人格被“激活”就上来写，每一条都能看到之前所有内容，直到收敛。', en: 'The question goes on a shared board with no conductor: whichever voice is activated writes next, seeing everything posted so far, until it converges.' },
  },
};
export const TOPOLOGY_IDS = Object.keys(TOPOLOGIES);

const ROLE_TASK = {
  curious: { zh: '弄清这个问题背后真正在问什么', en: 'Work out what is really being asked' },
  skeptic: { zh: '找出风险和站不住的假设', en: 'Find the risks and shaky assumptions' },
  dreamer: { zh: '提出一个大胆的另类角度', en: 'Offer one bold alternative angle' },
  builder: { zh: '给出一个今天就能做的具体方案', en: 'Draft a concrete plan doable today' },
  memory: { zh: '调出与主人相关的事实', en: 'Pull the relevant facts about the owner' },
  jester: { zh: '让答案更有人味', en: 'Make the answer more human' },
};
const roleTask = (a, lang) => ROLE_TASK[a.id]?.[lang] || (lang === 'zh' ? '用你的风格补充一个视角' : 'Add a perspective in your own style');

// ── the simulated brain ──
export function simBrain(question, agents, ctx) {
  const v = simVoice(question, agents, ctx, 'topology');
  const lang = ctx.lang, nm = (a) => a?.name[lang] || '?';
  const weights = routeScores(question, agents).weights;
  return {
    kind: 'sim', weights,
    async say(a, mode, info = {}) {
      if (mode === 'relay') return (info.prevAgent ? (lang === 'zh' ? `接着「${nm(info.prevAgent)}」：` : `Building on ${nm(info.prevAgent)}: `) : '') + v.propose(a);
      if (mode === 'rebut') return v.hit(a, info.opponent);
      return v.propose(a);
    },
    async plan(voices) {
      const top = voices.slice().sort((x, y) => (weights[y.id] || 0) - (weights[x.id] || 0)).slice(0, 3);
      return top.map((a) => ({ to: a.id, task: roleTask(a, lang) }));
    },
    async judge(pro, con) {
      const wp = (weights[pro.id] || 0.1) + v.rng() * 0.2, wc = (weights[con.id] || 0.1) + v.rng() * 0.2;
      const w = wp >= wc ? pro : con, l = w === pro ? con : pro;
      return { winner: w.id, verdict: lang === 'zh' ? `我判「${nm(w)}」胜：论证更完整，「${nm(l)}」的质疑有价值，但没能推翻它。` : `${nm(w)} wins: the stronger case. ${nm(l)}'s objections were worth hearing but didn't overturn it.` };
    },
    async answer({ winner, winnerText, votesText }) { return v.final(winner, winnerText, votesText); },
    opening: () => v.opening(),
  };
}

const say = (from, to, text, kind, id, deps) => ({ type: 'say', from, to, text, kind, node: { id, deps } });
const announce = {
  pipeline: { zh: '这次走流水线：每一棒都在上一棒的基础上推进。', en: 'Pipeline this time: each leg builds on the one before.' },
  hierarchy: { zh: '这次由我来拆解任务，分派给最合适的人格。', en: 'This time I\'ll split the work and hand it to the best voices.' },
  blackboard: { zh: '问题写在黑板上了。谁有想法，谁上来写。', en: 'The question is on the board. Whoever has something, write it up.' },
};

// Runs one topology. Yields the same event shapes as simMeeting (plus `dispatch`, and `node` for the DAG).
export async function* runTopology(kind, question, agents, ctx, brain) {
  if (kind === 'council') { for (const ev of simMeeting(question, agents, ctx)) yield ev; return; }
  const lang = ctx.lang, nm = (a) => a?.name[lang] || '?';
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const voices = agents.filter((a) => a.id !== 'self');
  const w = brain.weights || routeScores(question, agents).weights;
  const ranked = voices.slice().sort((x, y) => (w[y.id] || 0) - (w[x.id] || 0));
  const opening = brain.opening ? brain.opening() : (lang === 'zh' ? `收到：「${question.slice(0, 20)}」。` : `Incoming: "${question.slice(0, 20)}".`);

  yield { type: 'phase', key: 'perceive' };
  if (kind === 'debate') {
    var pro = ranked.find((a) => a.id !== 'skeptic') || ranked[0];
    var con = byId.skeptic && byId.skeptic !== pro ? byId.skeptic : ranked.find((a) => a !== pro);
    yield say('self', '*', opening + (lang === 'zh' ? `开辩论：「${nm(pro)}」正方，「${nm(con)}」反方，其他人当观众。` : ` Debate: ${nm(pro)} proposes, ${nm(con)} opposes, everyone else is the audience.`), 'open', 'root', []);
  } else yield say('self', '*', opening + announce[kind][lang], 'open', 'root', []);
  for (const ev of recallEvents(ctx.recalled, lang, byId.memory)) yield ev;

  if (kind === 'pipeline') {
    yield { type: 'phase', key: 'relay' };
    const order = ['curious', 'memory', 'dreamer', 'builder'];
    const chain = [...order.map((id) => byId[id]).filter(Boolean), ...voices.filter((a) => !a.core), byId.skeptic].filter(Boolean).slice(0, 6);
    let prev = 'root', prevText = question, prevAgent = null; const texts = {};
    for (let i = 0; i < chain.length; i++) {
      const a = chain[i];
      yield { type: 'thinking', ids: [a.id] };
      const text = await brain.say(a, 'relay', { question, prev: prevText, prevAgent });
      texts[a.id] = text;
      yield say(a.id, chain[i + 1]?.id || 'self', text, 'relay', 'r' + i, [prev]);
      prev = 'r' + i; prevText = text; prevAgent = a;
    }
    yield { type: 'phase', key: 'synth' };
    yield { type: 'thinking', ids: ['self'] };
    const winner = chain.slice().sort((x, y) => (w[y.id] || 0) - (w[x.id] || 0))[0].id;
    const text = await brain.answer({ winner, winnerText: texts[winner], question });
    yield { type: 'answer', text, winner, node: { id: 'ans', deps: [prev] } };
    return;
  }

  if (kind === 'hierarchy') {
    yield { type: 'phase', key: 'plan' };
    yield { type: 'thinking', ids: ['self'] };
    let plan = (await brain.plan(voices, question)).filter((s) => byId[s.to] && s.to !== 'self');
    const seen = new Set(); plan = plan.filter((s) => !seen.has(s.to) && seen.add(s.to)).slice(0, 3);
    if (!plan.length) plan = ranked.slice(0, 2).map((a) => ({ to: a.id, task: roleTask(a, lang) }));
    const circled = ['①', '②', '③'];
    yield say('self', '*', (lang === 'zh' ? `拆成 ${plan.length} 个子任务：` : `${plan.length} subtasks: `) + plan.map((s, i) => `${circled[i]}${nm(byId[s.to])} → ${s.task}`).join(lang === 'zh' ? '；' : '; '), 'plan', 'plan', ['root']);
    yield { type: 'phase', key: 'work' };
    for (let i = 0; i < plan.length; i++) yield { type: 'dispatch', from: 'self', to: plan[i].to, text: plan[i].task, node: { id: 'd' + i, deps: ['plan'] } };
    yield { type: 'thinking', ids: plan.map((s) => s.to) };
    const results = await Promise.all(plan.map((s) => brain.say(byId[s.to], 'work', { question, task: s.task })));
    for (let i = 0; i < plan.length; i++) yield say(plan[i].to, 'self', results[i], 'work', 'w' + i, ['d' + i]);
    yield { type: 'phase', key: 'aggregate' };
    yield { type: 'thinking', ids: ['self'] };
    const text = await brain.answer({ winner: plan[0].to, winnerText: results[0], question, parts: plan.map((s, i) => [byId[s.to], s.task, results[i]]) });
    yield { type: 'answer', text, winner: plan[0].to, node: { id: 'ans', deps: plan.map((_, i) => 'w' + i) } };
    return;
  }

  if (kind === 'debate') {
    yield { type: 'phase', key: 'open' };
    yield { type: 'thinking', ids: [pro.id, con.id] };
    const [o1, o2] = await Promise.all([brain.say(pro, 'open', { question, side: 'pro' }), brain.say(con, 'open', { question, side: 'con' })]);
    yield say(pro.id, con.id, o1, 'open', 'o1', ['root']);
    yield say(con.id, pro.id, o2, 'open', 'o2', ['root']);
    yield { type: 'phase', key: 'rebut' };
    yield { type: 'thinking', ids: [pro.id] };
    const b1 = await brain.say(pro, 'rebut', { question, opponent: con, opponentText: o2 });
    yield say(pro.id, con.id, b1, 'hit', 'b1', ['o2', 'o1']);
    yield { type: 'thinking', ids: [con.id] };
    const b2 = await brain.say(con, 'rebut', { question, opponent: pro, opponentText: b1 });
    yield say(con.id, pro.id, b2, 'hit', 'b2', ['b1', 'o2']);
    yield { type: 'phase', key: 'judge' };
    const tally = { [pro.id]: 0, [con.id]: 0 };
    if (brain.kind === 'sim') { // the audience votes (simulated brain only, to keep live runs cheap)
      for (const a of voices.filter((x) => x !== pro && x !== con)) {
        const pPro = (w[pro.id] + 0.15) / (w[pro.id] + w[con.id] + 0.3);
        const pick = Math.abs(Math.sin((a.id.length + question.length) * 9.7)) < pPro ? pro : con;
        tally[pick.id]++; yield { type: 'vote', from: a.id, for: pick.id };
      }
    }
    yield { type: 'thinking', ids: ['self'] };
    const j = await brain.judge(pro, con, [[pro, o1], [con, o2], [pro, b1], [con, b2]], tally);
    const winner = byId[j.winner] ? j.winner : pro.id;
    tally[winner] = (tally[winner] || 0) + 1;
    yield say('self', winner, j.verdict, 'verdict', 'j', ['b1', 'b2']);
    const text = await brain.answer({ winner, winnerText: winner === pro.id ? o1 : o2, question, votesText: `${tally[winner]}/${tally[pro.id] + tally[con.id]}` });
    yield { type: 'answer', text, winner, tally, node: { id: 'ans', deps: ['j'] } };
    return;
  }

  if (kind === 'blackboard') {
    yield { type: 'phase', key: 'post' };
    const board = [], posted = {}, act = {};
    let prevRound = ['root'];
    for (let round = 0; round < 2; round++) {
      // activation: how relevant the router thinks you are, minus fatigue for having already written
      for (const a of voices) act[a.id] = (w[a.id] || 0) + 0.12 * Math.abs(Math.sin((a.id.length * 7 + round * 13 + question.length) * 1.7)) - 0.3 * (posted[a.id] || 0);
      const writers = voices.slice().sort((x, y) => act[y.id] - act[x.id]).slice(0, round === 0 ? 3 : 2);
      yield { type: 'thinking', ids: writers.map((a) => a.id) };
      const boardText = board.map(([a, t]) => `${a.name.en}: ${t}`).join('\n');
      const texts = await Promise.all(writers.map((a) => brain.say(a, 'post', { question, board: boardText })));
      const ids = [];
      for (let i = 0; i < writers.length; i++) {
        const id = `p${round}_${i}`;
        board.push([writers[i], texts[i]]); posted[writers[i].id] = (posted[writers[i].id] || 0) + 1;
        yield say(writers[i].id, 'board', texts[i], 'post', id, prevRound);
        ids.push(id);
      }
      prevRound = [...prevRound.filter((x) => x !== 'root'), ...ids];
    }
    yield { type: 'phase', key: 'converge' };
    yield { type: 'thinking', ids: ['self'] };
    const best = board.slice().sort((x, y) => (w[y[0].id] || 0) - (w[x[0].id] || 0))[0];
    const text = await brain.answer({ winner: best[0].id, winnerText: best[1], question, board: board.map(([a, t]) => `${a.name.en}: ${t}`).join('\n') });
    yield { type: 'answer', text, winner: best[0].id, node: { id: 'ans', deps: prevRound } };
  }
}

// ── the execution graph ──
export function buildDag(events) {
  const nodes = [], byId = {}, lastBy = {};
  let root = null, last = null;
  events.forEach((ev, i) => {
    if (!['say', 'dispatch', 'answer', 'recall'].includes(ev.type)) return;
    const id = ev.node?.id || 'e' + i;
    let deps = ev.node?.deps;
    const agent = ev.type === 'answer' ? 'self' : ev.type === 'recall' ? 'memory' : ev.from;
    if (!deps) {
      if (ev.type === 'answer') deps = nodes.filter((n) => !nodes.some((m) => m.deps.includes(n.id))).map((n) => n.id);
      else if (!root) deps = [];
      else if (ev.type === 'recall' || ev.kind === 'proposal') deps = [root];
      else if (ev.kind === 'hit') deps = [lastBy[ev.to], lastBy[ev.from]].filter(Boolean);
      else if (ev.kind === 'reply' || ev.kind === 'recall') deps = [last];
      else deps = [lastBy[ev.from] || root];
    }
    deps = [...new Set(deps.filter((d) => byId[d] && d !== id))];
    const n = { id, agent, type: ev.type, kind: ev.kind || ev.type, text: ev.text || '', deps, to: ev.to, i };
    n.depth = deps.length ? Math.max(...deps.map((d) => byId[d].depth)) + 1 : 0;
    nodes.push(n); byId[id] = n;
    if (!root) root = id;
    lastBy[agent] = id; last = id;
  });
  // critical path: walk back from the deepest node through its deepest dependency
  const crit = new Set();
  let cur = nodes.slice().sort((a, b) => b.depth - a.depth || b.i - a.i)[0];
  while (cur) { crit.add(cur.id); cur = cur.deps.map((d) => byId[d]).sort((a, b) => b.depth - a.depth)[0]; }
  return { nodes, byId, crit };
}

export function dagMetrics(dag, events) {
  const layers = {};
  for (const n of dag.nodes) layers[n.depth] = (layers[n.depth] || 0) + 1;
  const says = events.filter((e) => e.type === 'say' || e.type === 'dispatch');
  const voices = new Set(dag.nodes.map((n) => n.agent));
  return {
    nodes: dag.nodes.length,
    edges: dag.nodes.reduce((s, n) => s + n.deps.length, 0),
    depth: dag.nodes.length ? Math.max(...dag.nodes.map((n) => n.depth)) + 1 : 0,
    width: Math.max(0, ...Object.values(layers)),
    messages: says.length,
    tokens: events.reduce((s, e) => s + (e.text && (e.type === 'say' || e.type === 'answer' || e.type === 'dispatch') ? tokens(e.text) : 0), 0),
    voices: voices.size,
    votes: events.filter((e) => e.type === 'vote').length,
  };
}

export function dagSVG(dag, agents, { width = 400, height = 0, mini = false, active } = {}) {
  if (!dag.nodes.length) return '';
  const maxD = Math.max(...dag.nodes.map((n) => n.depth));
  const layers = {};
  for (const n of dag.nodes) (layers[n.depth] = layers[n.depth] || []).push(n);
  const maxW = Math.max(...Object.values(layers).map((l) => l.length));
  const H = height || Math.max(mini ? 56 : 120, maxW * (mini ? 16 : 30) + (mini ? 14 : 30));
  const P = mini ? 8 : 16, R = mini ? 3.6 : 6;
  const pos = {};
  for (const [d, l] of Object.entries(layers)) l.forEach((n, k) => {
    pos[n.id] = { x: P + (maxD ? (d / maxD) * (width - 2 * P) : (width - 2 * P) / 2), y: P + ((k + 0.5) / l.length) * (H - 2 * P) };
  });
  const col = (id) => (id === 'board' ? '#cfd8e3' : agents.find((a) => a.id === id)?.color || '#ffffff');
  let s = '';
  for (const n of dag.nodes) for (const d of n.deps) {
    const a = pos[d], b = pos[n.id], mx = (a.x + b.x) / 2;
    const hot = dag.crit.has(n.id) && dag.crit.has(d);
    s += `<path d="M${a.x.toFixed(1)} ${a.y.toFixed(1)} C${mx.toFixed(1)} ${a.y.toFixed(1)} ${mx.toFixed(1)} ${b.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}" class="dedge${hot ? ' crit' : ''}" style="stroke:${col(n.agent)}"/>`;
  }
  for (const n of dag.nodes) {
    const p = pos[n.id], c = col(n.agent);
    const big = n.type === 'answer' || n.depth === 0;
    const shape = n.type === 'dispatch'
      ? `<rect x="${(p.x - R).toFixed(1)}" y="${(p.y - R).toFixed(1)}" width="${2 * R}" height="${2 * R}" rx="1.5" transform="rotate(45 ${p.x.toFixed(1)} ${p.y.toFixed(1)})" style="fill:${c}"/>`
      : `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${big ? R * 1.35 : R}" style="fill:${c}"${n.id === active ? ' class="dnew"' : ''}/>`;
    const name = agents.find((a) => a.id === n.agent)?.name;
    s += `<g><title>${esc((name ? name.zh + ' / ' + name.en : n.agent) + ' · ' + n.kind + '\n' + n.text.slice(0, 120))}</title>${shape}${big && !mini ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${R * 2.1}" class="dring" style="stroke:${c}"/>` : ''}</g>`;
  }
  return `<svg viewBox="0 0 ${width} ${H}" class="dag${mini ? ' mini' : ''}" role="img" aria-label="execution graph">${s}</svg>`;
}

// Tiny schematic for each topology card.
export function topologyGlyph(kind) {
  const c = (x, y, r = 4, f = '#7fd8ff') => `<circle cx="${x}" cy="${y}" r="${r}" fill="${f}"/>`;
  const l = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  let s = '';
  if (kind === 'council') { const pts = [0, 1, 2, 3, 4].map((k) => [40 + Math.cos(k * 1.2566 - 1.57) * 22, 26 + Math.sin(k * 1.2566 - 1.57) * 18]); pts.forEach(([x, y], i) => { s += l(40, 26, x, y) + l(x, y, ...pts[(i + 2) % 5]); }); pts.forEach(([x, y]) => (s += c(x, y, 3.5))); s += c(40, 26, 5, '#fff'); }
  if (kind === 'pipeline') { const xs = [8, 24, 40, 56, 72]; xs.forEach((x, i) => { if (i) s += l(xs[i - 1], 26, x, 26); }); xs.forEach((x, i) => (s += c(x, 26, i === 4 ? 5 : 3.5, i === 4 ? '#fff' : undefined))); }
  if (kind === 'hierarchy') { s += l(14, 26, 40, 10) + l(14, 26, 40, 26) + l(14, 26, 40, 42) + l(40, 10, 68, 26) + l(40, 26, 68, 26) + l(40, 42, 68, 26); s += c(14, 26, 5, '#fff') + c(40, 10) + c(40, 26) + c(40, 42) + c(68, 26, 5, '#fff'); }
  if (kind === 'debate') { s += l(18, 14, 62, 14) + l(18, 38, 62, 38) + l(18, 14, 62, 38) + l(62, 14, 18, 38) + l(62, 38, 74, 26); s += c(18, 14, 4, '#5dffa0') + c(62, 14, 4, '#ff5470') + c(18, 38, 4, '#5dffa0') + c(62, 38, 4, '#ff5470') + c(74, 26, 5, '#fff'); }
  if (kind === 'blackboard') { s += `<rect x="30" y="16" width="20" height="20" rx="3" fill="none" stroke="#cfd8e3"/>`; [[10, 10], [70, 10], [10, 42], [70, 42], [40, 4]].forEach(([x, y]) => { s += l(x, y, 40, 26) + c(x, y, 3.5); }); }
  return `<svg viewBox="0 0 80 52" class="tglyph">${s}</svg>`;
}
