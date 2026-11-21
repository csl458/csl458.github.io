// The real brain: every voice is its own Claude call, run in parallel rounds.
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

  // ── Round 1: every voice proposes, in parallel, without seeing the others.
  yield { type: 'phase', key: 'diverge' };
  yield { type: 'thinking', ids: voices.map((a) => a.id) };
  const r1 = await Promise.allSettled(voices.map((a) => call(client, {
    model,
    system: systemFor(a, roster, owner),
    user: `Visitor's question: """${q}"""\n\nGive your opening take as this voice.`,
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
  const debate = voices.map((a) => `- ${a.name.en}: ${proposals[a.id]}`).join('\n');
  const tallyText = ranked.map(([id, n]) => `${byId[id].name.en}=${n}`).join(', ');
  let answer;
  try {
    const r3 = await call(client, {
      model,
      maxTokens: 4000,
      system: systemFor(self, roster, owner).replace('under 45 words', 'under 90 words'),
      user: `Visitor's question: """${q}"""\n\nThe meeting:\n${debate}\n\nVote tally: ${tallyText}. Winning voice: ${byId[winner].name.en}.\n\nNow answer the visitor directly, in first person as the whole mind, building mainly on the winning take while keeping anything true the others added.`,
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
