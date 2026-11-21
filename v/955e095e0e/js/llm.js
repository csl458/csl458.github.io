// The real brain: every voice is its own Claude call, run in parallel rounds.
import { recallEvents } from './sim.js';
import { TOOLS, TOOL_BY_NAME, executeTool } from './tools.js';
// The visitor's API key stays in their own browser (localStorage) and is sent only to api.anthropic.com.

const SDK_URL = 'https://esm.sh/@anthropic-ai/sdk@1.12.0';
export const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
];
// Server-side refusal fallbacks are available on Opus 5.5 and Sonnet 5.5, not on Haiku 5.5.
const HAS_FALLBACKS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

let clientPromise = null, clientKey = null;
async function getClient(apiKey) {
  if (!clientPromise || clientKey !== apiKey) {
    clientKey = apiKey;
    clientPromise = import(SDK_URL).then((m) => {
      const Anthropic = m.default || m.Anthropic;
      return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
    });
  }
  return clientPromise;
}

function ownerBrief(owner) {
  return [
    `GitHub: @${owner.handle} (${owner.github})`,
    `Location: ${owner.location.en}. Affiliation: ${owner.affiliation.en}.`,
    `Focus: ${owner.focus.en}.`,
    owner.email ? `Email: ${owner.email}` : 'Email: not public.',
    ...(owner.links || []).map((l) => `${l.label}: ${l.url}`),
  ].join('\n');
}

function systemFor(agent, roster, owner) {
  return `${agent.persona}

You are one voice inside the mind of @${owner.handle}. This web page is their living business card: visitors ask the mind a question and watch the voices hold a meeting before Self answers.
The voices in the room: ${roster}.
Facts about @${owner.handle} (only these are true; never invent others):
${ownerBrief(owner)}

Rules: stay in character. Reply in the same language as the visitor's question. Be vivid and concise (one or two sentences, under 45 words). No markdown.`;
}

async function call(client, { model, system, user, schema, maxTokens = 3000 }) {
  const params = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
  };
  let res;
  if (HAS_FALLBACKS.has(model)) {
    res = await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } else {
    res = await client.messages.create(params);
  }
  if (res.stop_reason === 'refusal') return { refused: true };
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export class LLMError extends Error {}

// Async generator yielding the same event shapes as simMeeting().
export async function* llmMeeting(question, agents, ctx) {
  const { lang, owner, apiKey, model } = ctx;
  const client = await getClient(apiKey);
  const zh = lang === 'zh';
  const roster = agents.map((a) => `${a.id} ("${a.name.en}")`).join(', ');
  const voices = agents.filter((a) => a.id !== 'self');
  const self = agents.find((a) => a.id === 'self');
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const short = question.length > 22 ? question.slice(0, 21) + '…' : question;
  const q = question.slice(0, 600);

  yield { type: 'phase', key: 'perceive' };
  yield { type: 'say', from: 'self', to: '*', text: zh ? `收到：「${short}」。接入真实模型，各位请独立思考。` : `Incoming: "${short}". Live model online — think independently, everyone.` };
  for (const ev of recallEvents(ctx.recalled, lang, byId.memory)) yield ev;
  // Only Memory gets the recalled episodes; the others think without them.
  const recalledText = (ctx.recalled || []).map((r) => `- ${r.agoText}: "${r.q}"${r.winnerName ? ` (won by ${r.winnerName})` : ''}${r.a ? ` → the mind answered: "${r.a.slice(0, 160)}"` : ''}`).join('\n');

  // ── Round 1: every voice proposes, in parallel, without seeing the others.
  yield { type: 'phase', key: 'diverge' };
  yield { type: 'thinking', ids: voices.map((a) => a.id) };
  const r1 = await Promise.allSettled(voices.map((a) => call(client, {
    model,
    system: systemFor(a, roster, owner),
    user: `Visitor's question: """${q}"""\n\n${a.id === 'memory' && recalledText ? `Similar past meetings surfaced from your long-term memory:\n${recalledText}\n\n` : ''}${toolFacts(ctx)}Give your opening take as this voice.`,
    schema: { type: 'object', properties: { proposal: { type: 'string' } }, required: ['proposal'], additionalProperties: false },
  })));
  const firstErr = r1.find((r) => r.status === 'rejected');
  if (firstErr && r1.every((r) => r.status === 'rejected')) throw new LLMError(errText(firstErr.reason, zh));
  const proposals = {};
  for (let i = 0; i < voices.length; i++) {
    const v = r1[i].status === 'fulfilled' ? r1[i].value : null;
    const text = v?.proposal || (v?.refused ? (zh ? '（这个念头被拦截了）' : '(this thought was withheld)') : (zh ? '（走神了）' : '(drifted off)'));
    proposals[voices[i].id] = text;
    yield { type: 'say', from: voices[i].id, to: 'self', text, kind: 'proposal' };
  }

  // ── Round 2: each voice reads the room, reacts to one other voice, and votes.
  yield { type: 'phase', key: 'clash' };
  yield { type: 'thinking', ids: voices.map((a) => a.id) };
  const table = voices.map((a) => `- ${a.id} (${a.name.en}): ${proposals[a.id]}`).join('\n');
  const r2 = await Promise.allSettled(voices.map((a) => {
    const others = voices.filter((o) => o.id !== a.id).map((o) => o.id);
    return call(client, {
      model,
      system: systemFor(a, roster, owner),
      user: `Visitor's question: """${q}"""\n\nOpening takes from the room:\n${table}\n\nReact to exactly one other voice (agree, rebut, or tease) and vote for the take — not your own — that the mind should go with.`,
      schema: {
        type: 'object',
        properties: { reply_to: { type: 'string', enum: others }, reaction: { type: 'string' }, vote: { type: 'string', enum: others } },
        required: ['reply_to', 'reaction', 'vote'], additionalProperties: false,
      },
    });
  }));
  const tally = Object.fromEntries(voices.map((a) => [a.id, 0]));
  const votes = [];
  for (let i = 0; i < voices.length; i++) {
    const v = r2[i].status === 'fulfilled' ? r2[i].value : null;
    if (!v || !v.reaction || !byId[v.reply_to]) continue;
    yield { type: 'say', from: voices[i].id, to: v.reply_to, text: v.reaction, kind: 'hit' };
    if (byId[v.vote] && v.vote !== voices[i].id) votes.push([voices[i].id, v.vote]);
  }
  yield { type: 'phase', key: 'vote' };
  for (const [from, to] of votes) { tally[to]++; yield { type: 'vote', from, for: to }; }
  const ranked = Object.entries(tally).sort((x, y) => y[1] - x[1]);
  const winner = ranked[0][0];

  // ── Round 3: Self synthesises, honouring the vote.
  yield { type: 'phase', key: 'synth' };
  yield { type: 'thinking', ids: ['self'] };
  // Self reads the meeting from working memory — exactly what's left after any compaction.
  const debate = ctx.workingMemory?.() || voices.map((a) => `- ${a.name.en}: ${proposals[a.id]}`).join('\n');
  const tallyText = ranked.map(([id, n]) => `${byId[id].name.en}=${n}`).join(', ');
  let answer;
  try {
    const r3 = await call(client, {
      model,
      maxTokens: 4000,
      system: systemFor(self, roster, owner).replace('under 45 words', 'under 90 words'),
      user: `Visitor's question: """${q}"""\n\n${toolFacts(ctx)}Your working memory of the meeting (older lines may already be compressed into [summary] entries):\n${debate}\n\nVote tally: ${tallyText}. Winning voice: ${byId[winner].name.en}.\n\nNow answer the visitor directly, in first person as the whole mind, building mainly on the winning take while keeping anything true the others added.`,
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
    });
    answer = r3.answer || (r3.refused ? (zh ? '这个问题，我的大脑决定保持沉默。' : 'On this one, the mind chooses silence.') : r3.raw);
  } catch (e) {
    throw new LLMError(errText(e, zh));
  }
  yield { type: 'answer', text: answer, winner, tally };
}

function errText(e, zh) {
  const s = e?.status;
  if (s === 401) return zh ? 'API key 无效。' : 'Invalid API key.';
  if (s === 429) return zh ? '请求太频繁（429），稍后再试。' : 'Rate limited (429). Try again shortly.';
  if (s === 400) return (zh ? '请求被拒绝：' : 'Request rejected: ') + (e?.error?.error?.message || e.message || '');
  return (zh ? '连接大脑失败：' : 'Could not reach the model: ') + (e?.message || String(e));
}

// Dreaming with a real model: distil a group of similar questions into one short insight.
export async function summariseCluster(questions, lang, { apiKey, model }) {
  const client = await getClient(apiKey);
  const r = await call(client, {
    model,
    maxTokens: 2000,
    system: 'You consolidate memories while the mind sleeps. Given questions visitors kept asking, write ONE short insight (max 24 words) about what people want to know and why. Write in ' + (lang === 'zh' ? 'Chinese' : 'English') + '. No markdown.',
    user: questions.map((q) => `- ${q}`).join('\n'),
    schema: { type: 'object', properties: { insight: { type: 'string' } }, required: ['insight'], additionalProperties: false },
  });
  return r.insight || null;
}

// A Claude-backed "brain" for the orchestration topologies (pipeline, hierarchy, debate, blackboard).
// Every say() is one independent call with that voice's own persona.
export async function makeLLMBrain(question, agents, ctx, weights) {
  const { lang, owner, apiKey, model } = ctx;
  const client = await getClient(apiKey);
  const zh = lang === 'zh';
  const roster = agents.map((a) => `${a.id} ("${a.name.en}")`).join(', ');
  const self = agents.find((a) => a.id === 'self');
  const q = question.slice(0, 600);
  const textSchema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
  const recalledText = (ctx.recalled || []).map((r) => `- ${r.agoText}: "${r.q}"${r.a ? ` → "${r.a.slice(0, 140)}"` : ''}`).join('\n');
  const guard = async (p) => {
    try { const r = await p; return r; } catch (e) { throw new LLMError(errText(e, zh)); }
  };
  const one = async (agent, user, schema = textSchema, maxTokens = 3000) => {
    const r = await guard(call(client, { model, maxTokens, system: systemFor(agent, roster, owner), user, schema }));
    if (r.refused) return { refused: true };
    return r;
  };
  return {
    kind: 'live', weights,
    opening: () => (zh ? `收到：「${question.slice(0, 20)}」。` : `Incoming: "${question.slice(0, 20)}".`),
    async say(a, mode, info = {}) {
      const mem = a.id === 'memory' && recalledText ? `Similar past meetings from your long-term memory:\n${recalledText}\n\n` : '';
      let task;
      if (mode === 'relay') task = info.prevAgent ? `You are one leg of a relay. The previous voice (${info.prevAgent.name.en}) handed you this:\n"${info.prev}"\n\nBuild on it — don't repeat it — adding what only you can add.` : 'You run the first leg of a relay. Frame the question for the voices after you.';
      else if (mode === 'work') task = `Self (the orchestrator) assigned you this subtask: "${info.task}". Do only that.`;
      else if (mode === 'open') task = info.side === 'pro' ? 'This is a debate and you are the proposer. Give your opening case for the most useful answer, from your angle.' : 'This is a debate and you are the opposition. Give your opening challenge: what is wrong, risky or missing in the obvious answer?';
      else if (mode === 'rebut') task = `Debate. Your opponent (${info.opponent.name.en}) just said:\n"${info.opponentText}"\n\nRebut it directly.`;
      else if (mode === 'post') task = info.board ? `There is a shared blackboard. Everything posted so far:\n${info.board}\n\nAdd ONE new post that is not already on the board.` : 'There is a shared blackboard with only the question on it. Post your first contribution.';
      else task = 'Give your take as this voice.';
      const r = await one(a, `Visitor's question: """${q}"""\n\n${mem}${toolFacts(ctx)}${task}`);
      return r.text || (zh ? '（这个念头被拦截了）' : '(this thought was withheld)');
    },
    async plan(voices) {
      const ids = voices.map((v) => v.id);
      const r = await one(self, `Visitor's question: """${q}"""\n\nYou are the orchestrator. Split the work into 2 or 3 subtasks and assign each to the single best voice (${voices.map((v) => `${v.id} = ${v.name.en}`).join(', ')}). Each subtask is one short imperative sentence, in the visitor's language. Use each voice at most once.`, {
        type: 'object',
        properties: { subtasks: { type: 'array', items: { type: 'object', properties: { task: { type: 'string' }, assignee: { type: 'string', enum: ids } }, required: ['task', 'assignee'], additionalProperties: false } } },
        required: ['subtasks'], additionalProperties: false,
      });
      return (r.subtasks || []).map((s) => ({ to: s.assignee, task: s.task }));
    },
    async judge(pro, con, transcript) {
      const r = await one(self, `Visitor's question: """${q}"""\n\nThe debate:\n${transcript.map(([a, t]) => `${a.name.en}: ${t}`).join('\n')}\n\nYou are the judge. Pick the side whose case gives the visitor the better answer, and say why in one sentence (in the visitor's language).`, {
        type: 'object', properties: { winner: { type: 'string', enum: [pro.id, con.id] }, verdict: { type: 'string' } }, required: ['winner', 'verdict'], additionalProperties: false,
      });
      return { winner: r.winner || pro.id, verdict: r.verdict || '' };
    },
    async answer({ winner, winnerText, parts, board }) {
      const wm = ctx.workingMemory?.();
      const context = wm || (parts ? parts.map(([a, task, t]) => `${a.name.en} (${task}): ${t}`).join('\n') : board || winnerText);
      const winnerName = agents.find((a) => a.id === winner)?.name.en || winner;
      const r = await guard(call(client, {
        model, maxTokens: 4000,
        system: systemFor(self, roster, owner).replace('under 45 words', 'under 90 words'),
        user: `Visitor's question: """${q}"""\n\n${toolFacts(ctx)}Your working memory of the meeting (older lines may be compressed into [summary] entries):\n${context}\n\nThe strongest contribution came from ${winnerName}. Now answer the visitor directly, in first person as the whole mind, building mainly on it while keeping anything true the others added.`,
        schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
      }));
      return r.answer || (r.refused ? (zh ? '这个问题，我的大脑决定保持沉默。' : 'On this one, the mind chooses silence.') : r.raw);
    },
  };
}


// Facts gathered with tools before the meeting, shared with every voice.
function toolFacts(ctx) {
  const ok = (ctx.toolResults || []).filter((r) => r.ok);
  if (!ok.length) return '';
  return `Facts gathered with tools before the meeting (real, live data — rely on them):\n${ok.map((r) => `- ${r.name}: ${r.summary}`).join('\n')}\n\n`;
}

// The tool phase with a real model: Claude decides whether to call tools and with what input, in a
// standard tool-use loop (call → run locally → return tool_result → continue), up to 4 rounds.
export async function* claudeToolPhase(question, agents, ctx) {
  const { lang, owner, apiKey, model } = ctx;
  const client = await getClient(apiKey);
  const self = agents.find((a) => a.id === 'self');
  const roster = agents.map((a) => `${a.id} ("${a.name.en}")`).join(', ');
  const tools = TOOLS.map((t) => t.def);
  const system = systemFor(self, roster, owner) + `\n\nRight now you are gathering facts BEFORE the meeting. Call tools only if live data would materially improve the answer (the owner's GitHub activity, a factual lookup, the weather, arithmetic, the time somewhere). If no tool would help, reply "no tools needed" and call none. When you have what you need, reply with one short sentence summarising what you found.`;
  const messages = [{ role: 'user', content: `Visitor's question: """${question.slice(0, 600)}"""` }];
  ctx.toolResults = ctx.toolResults || [];
  let announced = false;
  for (let round = 0; round < 4; round++) {
    const params = { model, max_tokens: 4000, system, messages, tools, output_config: { effort: 'low' } };
    let res;
    try {
      res = HAS_FALLBACKS.has(model)
        ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
        : await client.messages.create(params);
    } catch (e) { throw new LLMError(errText(e, lang === 'zh')); }
    if (res.stop_reason === 'refusal') return;
    const calls = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !calls.length) return;
    if (!announced) { yield { type: 'phase', key: 'tools' }; announced = true; }
    const results = await Promise.all(calls.map(async (c) => {
      const t = TOOL_BY_NAME[c.name];
      if (!t) return { c, t: null, r: { ok: false, summary: 'unknown tool', data: { error: 'unknown tool' } } };
      return { c, t, r: await executeTool(t.id, c.input, { lang, owner }, 'claude') };
    }));
    for (const { c, t, r } of results) {
      if (!t) continue;
      const from = agents.some((a) => a.id === t.owner) ? t.owner : 'self';
      yield { type: 'tool_call', from, tool: t.id, input: c.input };
      yield { type: 'tool_result', from, tool: t.id, ok: r.ok, summary: r.summary, ms: r.ms };
      yield { type: 'say', from, to: 'self', kind: 'tool', text: r.ok ? (lang === 'zh' ? `我查了「${t.name.zh}」：${r.summary}` : `I checked ${t.name.en}: ${r.summary}`) : (lang === 'zh' ? `「${t.name.zh}」没回应（${r.summary}）。` : `${t.name.en} didn't answer (${r.summary}).`) };
      ctx.toolResults.push({ tool: t.id, name: t.def.name, input: c.input, ...r });
    }
    // the whole assistant turn goes back unchanged (thinking, tool_use and any fallback blocks), then all results in one user turn
    messages.push({ role: 'assistant', content: res.content });
    messages.push({ role: 'user', content: results.map(({ c, r }) => ({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(r.ok ? r.data : { error: r.summary }).slice(0, 4000), is_error: !r.ok })) });
  }
}
