// The simulated brain: a deterministic-ish meeting script built from the question.
import { STYLES } from './agents.js';

export function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6d2b79f5; let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? ''));
export const isCJK = (s) => /[぀-ヿ㐀-鿿가-힯]/.test(s);

const CATS = [
  ['greet', /^\s*(hi|hello|hey|yo|sup|你好|嗨|哈喽|在吗|早上好|晚上好)\b|^\s*(你好|嗨|哈喽|在吗)/i],
  ['identity', /(who are you|about you|yourself|your name|who is|你是谁|介绍|自我介绍|名字|你叫|你是什么人)/i],
  ['contact', /(contact|e-?mail|reach you|hire|collab|work with|联系|邮箱|合作|招聘|实习|工作机会|找你|简历|resume|cv)/i],
  ['mind', /(how do(es)? (this|you) work|this (site|page)|what is this|这个网站|这个页面|怎么运作|原理|这是什么|怎么做的)/i],
  ['work', /(what do you do|working on|project|research|stud(y|ies)|skill|tech stack|做什么|研究|项目|技能|在做|学什么|专业|方向)/i],
  ['joke', /(joke|funny|make me laugh|笑话|搞笑|逗我|好玩的)/i],
  ['ai', /(\bai\b|a\.i\.|agent|llm|gpt|claude|neural|智能体|人工智能|大模型|模型|多智能体|意识|conscious|sentien|agi|机器人)/i],
  ['meaning', /(meaning|purpose|life|death|love|happy|happiness|free will|universe|意义|人生|活着|死亡|爱情|爱|幸福|快乐|宇宙|自由意志|孤独|存在)/i],
  ['advice', /(should i|should we|how (do|can) i|advice|worth it|应该|要不要|该不该|我该|怎么办|建议|值不值|值得吗|选择|如何|怎样才能)/i],
  ['time', /(sleep|tired|night|what time|几点|睡|晚安|累了|熬夜|困)/i],
];
export function classify(q) {
  for (const [k, re] of CATS) if (re.test(q)) return k;
  return 'open';
}

// Who should "win" for each category.
const LEAD = {
  greet: 'jester', identity: 'memory', contact: 'memory', mind: 'curious', work: 'memory', joke: 'jester',
  ai: 'curious', meaning: 'dreamer', advice: 'builder', time: 'dreamer', open: null,
};

// Generic proposals per agent.
const SAY = {
  curious: {
    zh: ['先别急着回答——为什么会问「{q}」？背后真正的问题也许更有意思。', '把「{q}」倒过来问一遍：如果答案是否定的，世界会变成什么样？', '我想多挖一层：这个问题是关于事实，还是关于感受？'],
    en: ['Hold on — why ask "{q}"? The question behind it may be the interesting one.', 'Flip it: if the answer to "{q}" were no, what would the world look like?', 'One layer deeper: is this about facts, or about feelings?'],
  },
  skeptic: {
    zh: ['「{q}」的前提我不太认同，先把定义说清楚。', '任何听起来太漂亮的答案，我都不信。证据呢？', '我们知道的比我们以为的少。先承认不确定性。'],
    en: ['I don\'t buy the premise of "{q}" yet. Define the terms first.', 'Any answer that sounds this neat, I distrust. Evidence?', 'We know less than we think. Let\'s admit the uncertainty.'],
  },
  dreamer: {
    zh: ['如果把「{q}」交给一千年后的人来回答呢？', '我梦到过类似的东西：答案是一头会发光的鲸鱼。别笑，听我说完。', '也许问题本身，就是答案的一半。'],
    en: ['What if someone a thousand years from now answered "{q}"?', 'I dreamt about this once. The answer was a glowing whale. Don\'t laugh — hear me out.', 'Maybe the question is already half of the answer.'],
  },
  builder: {
    zh: ['别讨论了，做个最小实验：今天就能验证一部分。', '拆成三步：先明确目标，再找最小行动，然后迭代。', '给我一个周末，我能做个原型来回答它。'],
    en: ['Less talking. Run a tiny experiment — we can test part of this today.', 'Three steps: define the goal, find the smallest action, iterate.', 'Give me a weekend and I\'ll prototype an answer.'],
  },
  memory: {
    zh: ['查了一下存档：主人遇到这类问题，通常第一反应是去写代码。', '记录显示，上一次我们讨论类似的事，是在一个凌晨两点。', '提醒各位：主人在{loc}，现在是当地时间 {time}。'],
    en: ['Checking the archive: when the owner hits questions like this, they usually start writing code.', 'Records show we last debated something like this at 2 a.m.', 'Reminder: the owner is in {loc}. Local time is {time}.'],
  },
  jester: {
    zh: ['我提议用石头剪刀布决定。', '这个问题太深了，我先潜个水 🤿', '先说好：如果答错了，就是 Dreamer 的锅。'],
    en: ['I move that we settle this with rock-paper-scissors.', 'This question is deep. Diving in. 🤿', 'For the record: if we get it wrong, blame Dreamer.'],
  },
};

// Category-specific proposals that override the generic ones.
const SAY_CAT = {
  identity: {
    memory: { zh: ['档案调出来了：{name}，坐标{loc}，{aff}。', '关于主人的事我最清楚：{name}，在{aff}，研究方向是{focus}。'], en: ['File retrieved: {name}, based in {loc}, {aff}.', 'I keep the facts: {name}, at {aff}, into {focus}.'] },
    dreamer: { zh: ['他是谁？他是一群会吵架的念头，碰巧共用一张脸。'], en: ['Who are they? A crowd of arguing thoughts that happen to share one face.'] },
    jester: { zh: ['我们是谁？我们是 {n} 个房客，房东不收租。'], en: ['Who are we? {n} tenants. The landlord doesn\'t charge rent.'] },
  },
  contact: {
    memory: { zh: ['联络方式在档案里：GitHub → {github}{mail}。'], en: ['Contact on file: GitHub → {github}{mail}.'] },
    builder: { zh: ['想合作？直接开个 issue 或者发消息，我已经在搓手了。'], en: ['Want to build something? Open an issue or send a message. I\'m already rolling up my sleeves.'] },
    skeptic: { zh: ['先确认一下：对方想合作的是主人，还是我们这群人格？'], en: ['Let\'s clarify: do they want to work with the owner, or with us voices?'] },
  },
  work: {
    memory: { zh: ['当前关注：{focus}。', '主人最近在折腾的东西：{focus}。这个页面本身就是作品。'], en: ['Current focus: {focus}.', 'Lately the owner has been tinkering with {focus}. This page is one of the experiments.'] },
    builder: { zh: ['与其说做什么，不如看看你现在正在用的这个东西——就是我们造的。'], en: ['Instead of describing it — look at what you\'re using right now. We built it.'] },
  },
  ai: {
    curious: { zh: ['如果一个大脑本身就是一群 agent，那“一个 AI”和“一群 AI”的边界在哪？'], en: ['If a mind is already a crowd of agents, where is the line between one AI and many?'] },
    skeptic: { zh: ['别把模型说得太神。它们会错，而且错得很自信——跟我们一样。'], en: ['Let\'s not mythologise models. They\'re wrong, confidently — just like us.'] },
    dreamer: { zh: ['有一天，agent 会互相写信，而我们只是读信的人。'], en: ['One day agents will write each other letters, and we\'ll just be the readers.'] },
    builder: { zh: ['少争论意识，多做实验：让几个 agent 协作完成一件真事，看它们怎么分工。'], en: ['Fewer consciousness debates, more experiments: give a few agents a real job and watch how they split it.'] },
  },
  meaning: {
    dreamer: { zh: ['意义不是被找到的，是被一群互相争吵的念头一起搭起来的。', '人生像一场没有议程的会议，但茶点很好。'], en: ['Meaning isn\'t found — it\'s built by a crowd of arguing thoughts.', 'Life is a meeting without an agenda. The snacks are great, though.'] },
    skeptic: { zh: ['这个问题人类问了几千年，我们七个在三秒内答不出来很正常。'], en: ['Humans have asked this for millennia. Seven of us failing in three seconds is fine.'] },
  },
  advice: {
    builder: { zh: ['做一个最小的、可逆的尝试，定一个复盘日期。就这么简单。'], en: ['Make the smallest reversible move, and set a date to review. That\'s it.'] },
    skeptic: { zh: ['先想清楚最坏情况，能承受就去做。'], en: ['Name the worst case. If you can survive it, go.'] },
    dreamer: { zh: ['十年后的你会更后悔没做的事，而不是做错的事。'], en: ['Ten-years-from-now you regrets the untried more than the failed.'] },
  },
  joke: {
    jester: { zh: ['终于有人懂我了。让我来！', '笑话时间！请大家把怀疑先关一下。'], en: ['Finally, someone who gets me. Allow me!', 'Joke time! Someone mute Skeptic.'] },
    skeptic: { zh: ['我反对在会议中讲笑话。……好吧，就一个。'], en: ['I object to jokes in meetings. …Fine. One.'] },
  },
  greet: {
    jester: { zh: ['有客人！大家坐好，假装我们一直很专业。'], en: ['A visitor! Everyone sit up and pretend we\'re professional.'] },
    curious: { zh: ['你好你好！你是从哪里点进来的？'], en: ['Hello! Where did you wander in from?'] },
  },
  time: {
    dreamer: { zh: ['时间只是会议纪要里的一个字段。'], en: ['Time is just a field in the meeting minutes.'] },
    memory: { zh: ['主人所在的{loc}，现在是 {time}。'], en: ['It\'s {time} in {loc}, where the owner lives.'] },
  },
  mind: {
    curious: { zh: ['你问到点子上了：你现在看着的，就是我们开会的样子。'], en: ['Good question: what you\'re looking at is literally us in a meeting.'] },
    builder: { zh: ['原理很简单：七个 agent，各自发言、互相反驳、投票，然后 Self 合成答案。'], en: ['Simple: seven agents propose, rebut, vote, and Self synthesises.'] },
  },
};

const HIT = {
  curious: { zh: ['{t}，你为什么这么确定？', '等等 {t}，再往下挖一层呢？'], en: ['{t}, why so sure?', 'Wait, {t} — what\'s one layer below that?'] },
  skeptic: { zh: ['{t}，这个说法的证据在哪？', '{t} 又在讲好听的故事了。'], en: ['{t}, where\'s the evidence?', '{t} is telling bedtime stories again.'] },
  dreamer: { zh: ['{t} 太保守了，想大一点！', '{t}，你有没有试过闭上眼睛想这个问题？'], en: ['{t}, too small! Think bigger!', '{t}, have you tried thinking about it with your eyes closed?'] },
  builder: { zh: ['{t} 的想法很好，但周一早上要怎么执行？', '{t}，能落地吗？给我一个能做的版本。'], en: ['Nice idea, {t}, but what do we do on Monday morning?', '{t}, can we ship that? Give me a buildable version.'] },
  memory: { zh: ['{t}，历史上我们这么干过，结果是熬了三个通宵。', '存档显示 {t} 上次的建议效果还不错。'], en: ['{t}, we tried that once. Three all-nighters.', 'Archive says {t}\'s last suggestion actually worked.'] },
  jester: { zh: ['{t} 说得对，但我选择不听。', '我把 {t} 的发言翻译成人话：「我也不知道」。'], en: ['{t} is right, but I choose not to listen.', 'Translating {t}: "I also don\'t know."'] },
};
const REPLY = {
  zh: ['{t}，有道理，但我保留意见。', '{t}，我不同意，但我尊重你的发言权。', '好吧 {t}，这一轮算你赢。', '{t}，我们会后单独聊。'],
  en: ['Fair, {t}, but I reserve judgement.', '{t}, I disagree, but I respect your airtime.', 'Fine, {t}. This round is yours.', '{t}, let\'s take this offline.'],
};

// Natural rivalries: who tends to attack whom.
const RIVAL = {
  skeptic: ['dreamer', 'jester', 'curious'], builder: ['dreamer', 'curious'], dreamer: ['skeptic', 'builder'],
  curious: ['skeptic', 'memory'], jester: ['skeptic', 'builder', 'self'], memory: ['dreamer', 'jester'],
};

const FINAL = {
  greet: { zh: ['你好！你刚刚把我脑子里的 {n} 个人格同时吵醒了。随便问点什么——它们很乐意为你吵一架。'], en: ['Hi! You just woke up all {n} voices in my head at once. Ask anything — they\'d love to argue about it for you.'] },
  identity: { zh: ['我是 {name}，在{loc}，{aff}。我着迷于{focus}——你现在看到的，就是我大脑里的会议室。点任何一个人格，它会告诉你我的一部分。'], en: ['I\'m {name}, based in {loc}, {aff}. I\'m fascinated by {focus} — what you\'re looking at is the meeting room inside my head. Click any voice and it\'ll tell you a piece of me.'] },
  contact: { zh: ['最快的方式：在 GitHub 上找我 → {github}{mail}。想一起做 agent 相关的东西？直接开 issue 或发消息，我的「建造」已经在搓手了。'], en: ['Fastest route: find me on GitHub → {github}{mail}. Want to build something with agents together? Open an issue or drop a message — my Builder is already rolling up its sleeves.'] },
  work: { zh: ['最近在做：{focus}。一句话——我在研究怎么让一群 agent 像一个大脑那样思考。这个页面就是一个活的样本。'], en: ['These days: {focus}. In one line — I\'m exploring how a crowd of agents can think like one mind. This page is a living sample.'] },
  mind: { zh: ['这是我的大脑：每个发光的点都是一个有性格的 agent。你提问后，它们会发散、交锋、表决，最后由「自我」合成答案。默认是模拟大脑；在 ⚙ 里填入你自己的 Claude API key，它们就会变成真正的 LLM agent。你还可以给我植入一个新人格。'], en: ['This is my mind: every glowing point is an agent with its own personality. When you ask, they diverge, clash, vote, and Self synthesises the answer. By default the brain is simulated; add your own Claude API key under ⚙ and they become real LLM agents. You can also implant a new persona into me.'] },
  ai: { zh: ['我的看法：一个模型像一个天才，一群 agent 更像一个社会——会争论、会犯错，也会互相纠错。真正有意思的不是谁最聪明，而是它们如何达成共识。至于意识……我们刚为这事吵了三秒，没结论。'], en: ['My take: one model is a genius; many agents are a society — they argue, make mistakes, and correct each other. The interesting part isn\'t who\'s smartest, it\'s how they reach consensus. As for consciousness… we argued for three seconds. No verdict.'] },
  meaning: { zh: ['会议的结论：意义不是找到的，是被一群互相争吵的念头一起搭起来的——就像刚才这样。'], en: ['The meeting concludes: meaning isn\'t found, it\'s assembled by a crowd of quarrelling thoughts — just like the one you just watched.'] },
  advice: { zh: ['大脑的建议：先做一个最小的、可逆的尝试，给自己定一个复盘日期。「怀疑」负责止损，「做梦」负责方向，「建造」负责今天就动手。'], en: ['The mind advises: take the smallest reversible step and set a date to review it. Skeptic guards the downside, Dreamer holds the direction, Builder starts today.'] },
  joke: { zh: ['为什么多智能体系统从不孤单？因为它连自言自语都是群聊。', '我们 {n} 个人格开会表决要不要讲笑话，以 {v} 票通过——但没人记得笑话本身。'], en: ['Why is a multi-agent system never lonely? Even its inner monologue is a group chat.', 'My {n} voices voted {v} to tell you a joke. Nobody remembers the joke.'] },
  time: { zh: ['{loc}现在是 {time}。{sleepy}'], en: ['It\'s {time} in {loc}. {sleepy}'] },
};
const CLOSERS = {
  zh: ['这是今天的结论——明天可能会被推翻。', '会议结束。持反对意见的人格已记录在案。', '以上，代表整个大脑。'],
  en: ['That\'s today\'s conclusion. Tomorrow we may overrule it.', 'Meeting adjourned. Dissenting voices have been noted.', 'So says the whole mind.'],
};

export const IDLE = {
  zh: [
    ['curious', 'dreamer', '你觉得章鱼会做梦吗？'], ['dreamer', 'curious', '会，而且是八个梦同时做。'],
    ['skeptic', 'builder', '你上次说“五分钟就好”，是三小时前。'], ['builder', 'skeptic', '我在做的是第五分钟的第三版。'],
    ['jester', 'self', '主席，我能申请一个更酷的颜色吗？'], ['memory', 'self', '今日记忆整理完毕，已归档 1 段没用的歌词。'],
    ['dreamer', 'skeptic', '如果宇宙是一场会议，谁在记纪要？'], ['skeptic', 'dreamer', '肯定不是你。'],
    ['curious', 'memory', '我们第一次见面是什么时候？'], ['memory', 'curious', '在一次 bug 调试里。你问了 47 次为什么。'],
    ['builder', 'jester', '帮我递一下那个 idea。'], ['jester', 'builder', '哪个？那个会发光的还是会咬人的？'],
    ['self', 'curious', '安静一点，有人在看我们。'],
  ],
  en: [
    ['curious', 'dreamer', 'Do you think octopuses dream?'], ['dreamer', 'curious', 'Yes. Eight dreams at once.'],
    ['skeptic', 'builder', 'You said "five minutes". That was three hours ago.'], ['builder', 'skeptic', 'This is minute five, version three.'],
    ['jester', 'self', 'Chair, may I request a cooler colour?'], ['memory', 'self', 'Daily memory sort done. Archived one useless song lyric.'],
    ['dreamer', 'skeptic', 'If the universe were a meeting, who takes the minutes?'], ['skeptic', 'dreamer', 'Not you, clearly.'],
    ['curious', 'memory', 'When did we first meet?'], ['memory', 'curious', 'During a debugging session. You asked "why" 47 times.'],
    ['builder', 'jester', 'Pass me that idea.'], ['jester', 'builder', 'Which one — the glowing one or the one that bites?'],
    ['self', 'curious', 'Quiet — someone is watching us.'],
  ],
};
export const DREAMS = {
  zh: ['……梦见一座用 JSON 盖的城市……', '……所有括号终于都配对了……', '……一只鲸鱼在发 HTTP 请求……', '……会议室漂到了月球……', '……zZ 第 404 号梦境未找到……'],
  en: ['…dreaming of a city built from JSON…', '…every bracket finally matched…', '…a whale sending HTTP requests…', '…the meeting room drifted to the moon…', '…zZ dream 404 not found…'],
};

function ownerVars(owner, lang, timeStr, asleep) {
  return {
    name: '@' + owner.handle, handle: owner.handle, loc: owner.location[lang], aff: owner.affiliation[lang],
    focus: owner.focus[lang], github: owner.github.replace(/^https?:\/\//, ''),
    mail: owner.email ? (lang === 'zh' ? `，或邮件 ${owner.email}` : `, or email ${owner.email}`) : '',
    time: timeStr,
    sleepy: asleep
      ? (lang === 'zh' ? '主人这会儿多半睡着了，你正在和他的梦说话。' : 'The owner is probably asleep — you\'re talking to their dreams.')
      : (lang === 'zh' ? '主人醒着，大脑在线。' : 'The owner is awake and the mind is online.'),
  };
}

export function simMeeting(question, agents, ctx) {
  const { lang, owner, timeStr, asleep } = ctx;
  const rng = seeded(question.trim().toLowerCase() + '|' + agents.map((a) => a.id).join(','));
  const cat = classify(question);
  const short = question.length > 22 ? question.slice(0, 21) + '…' : question;
  const V = { ...ownerVars(owner, lang, timeStr, asleep), q: short, n: agents.length };
  const nm = (a) => a.name[lang];
  const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
  const ev = [];

  // ── perceive
  ev.push({ type: 'phase', key: 'perceive' });
  if (asleep) {
    ev.push({ type: 'say', from: 'skeptic', to: 'self', text: lang === 'zh' ? `现在是悉尼 ${timeStr}……谁在这个点提问？` : `It\'s ${timeStr} in Sydney… who asks questions at this hour?` });
  }
  ev.push({ type: 'say', from: 'self', to: '*', text: pick(rng, lang === 'zh'
    ? [`收到一个问题：「${short}」。各位，开会。`, `新输入：「${short}」。全员就位。`, `有人问：「${short}」。谁先说？`]
    : [`Incoming: "${short}". Everyone, meeting time.`, `New input: "${short}". All voices to the table.`, `Someone asks: "${short}". Who\'s first?`]) });

  // ── diverge
  ev.push({ type: 'phase', key: 'diverge' });
  const voices = agents.filter((a) => a.id !== 'self');
  const lead = LEAD[cat];
  let speakers = voices.filter((a) => !a.core);
  const cores = voices.filter((a) => a.core).sort(() => rng() - 0.5);
  const nCore = Math.max(3, 5 - speakers.length);
  let chosen = cores.slice(0, nCore);
  if (lead && !chosen.find((a) => a.id === lead)) chosen[chosen.length - 1] = byId[lead];
  speakers = [...chosen, ...speakers].sort(() => rng() - 0.5);
  if (lead) { speakers = speakers.filter((a) => a.id !== lead); speakers.splice(Math.min(2, speakers.length), 0, byId[lead]); }

  const proposals = {};
  for (const a of speakers) {
    let text;
    if (!a.core) text = fill(pick(rng, STYLES[a.style].say[lang]), V);
    else {
      const special = SAY_CAT[cat]?.[a.id]?.[lang];
      text = fill(pick(rng, special && (a.id === lead || rng() < 0.85) ? special : SAY[a.id][lang]), V);
    }
    proposals[a.id] = text;
    ev.push({ type: 'say', from: a.id, to: 'self', text, kind: 'proposal' });
  }

  // ── clash
  ev.push({ type: 'phase', key: 'clash' });
  const ids = speakers.map((a) => a.id);
  const clashes = Math.min(3, Math.max(2, Math.floor(ids.length / 2)));
  const used = new Set();
  for (let i = 0; i < clashes; i++) {
    const fresh = speakers.filter((a) => !used.has(a.id));
    const attacker = pick(rng, fresh.length ? fresh : speakers);
    used.add(attacker.id);
    const rivals = (RIVAL[attacker.id] || []).filter((r) => ids.includes(r) && r !== attacker.id);
    const targetId = rivals.length && rng() < 0.75 ? pick(rng, rivals) : pick(rng, ids.filter((x) => x !== attacker.id));
    const target = byId[targetId];
    const pool = attacker.core ? HIT[attacker.id][lang] : STYLES[attacker.style].hit[lang];
    ev.push({ type: 'say', from: attacker.id, to: targetId, text: fill(pick(rng, pool), { t: nm(target) }), kind: 'hit' });
    if (rng() < 0.7) {
      ev.push({ type: 'say', from: targetId, to: attacker.id, text: fill(pick(rng, REPLY[lang]), { t: nm(attacker) }), kind: 'reply' });
    }
  }

  // ── vote
  ev.push({ type: 'phase', key: 'vote' });
  const tally = Object.fromEntries(ids.map((x) => [x, 0]));
  for (const a of voices) {
    const options = ids.filter((x) => x !== a.id);
    if (!options.length) continue;
    const weights = options.map((x) => {
      let w = 1 + rng();
      if (x === lead) w += 2.6;
      if ((RIVAL[a.id] || []).includes(x)) w *= 0.45;
      return w;
    });
    let r = rng() * weights.reduce((s, w) => s + w, 0), choice = options[0];
    for (let i = 0; i < options.length; i++) { r -= weights[i]; if (r <= 0) { choice = options[i]; break; } }
    tally[choice]++;
    ev.push({ type: 'vote', from: a.id, for: choice });
  }
  const ranked = Object.entries(tally).sort((x, y) => y[1] - x[1]);
  const winner = ranked[0][0];
  const total = ranked.reduce((s, r) => s + r[1], 0);
  V.v = `${ranked[0][1]}/${total}`;

  // ── synthesise
  ev.push({ type: 'phase', key: 'synth' });
  let answer;
  if (FINAL[cat]) answer = fill(pick(rng, FINAL[cat][lang]), V);
  else {
    answer = lang === 'zh'
      ? `「${nm(byId[winner])}」以 ${V.v} 票胜出：${proposals[winner]} ${pick(rng, CLOSERS.zh)}`
      : `${nm(byId[winner])} carries it, ${V.v} votes: ${proposals[winner]} ${pick(rng, CLOSERS.en)}`;
  }
  ev.push({ type: 'answer', text: answer, winner, tally });
  return ev;
}

// ── Router: score every voice for a question and softmax the scores (top-k gating, like a mixture of experts) ──
const AFFINITY = {
  curious: /(why|how|what if|为什么|怎么|如果|原理|真的吗|\?|？)/gi,
  skeptic: /(true|really|prove|evidence|risk|sure|真的|证据|风险|靠谱|确定|骗)/gi,
  dreamer: /(dream|future|imagine|life|love|universe|梦|未来|想象|人生|爱|宇宙|意义)/gi,
  builder: /(build|make|code|start|how do i|plan|做|写|实现|开始|创业|计划|项目|代码)/gi,
  memory: /(you|your|who|contact|remember|你|谁|联系|记得|以前|经历|学校|研究)/gi,
  jester: /(joke|fun|lol|haha|bored|笑话|好玩|哈哈|无聊|搞笑)/gi,
};
export function routeScores(question, agents, temperature = 0.7) {
  const cat = classify(question);
  const lead = LEAD[cat];
  const rng = seeded('route|' + question);
  const raw = {};
  for (const a of agents) {
    if (a.id === 'self') continue;
    let s = 0.4 + rng() * 0.3;
    const re = AFFINITY[a.id];
    if (re) s += Math.min(3, (question.match(re) || []).length) * 0.55;
    else s += 0.5; // implanted voices: a curious newcomer gets a fair share
    if (a.id === lead) s += 1.6;
    raw[a.id] = s;
  }
  const ids = Object.keys(raw);
  const mx = Math.max(...ids.map((id) => raw[id]));
  const ex = ids.map((id) => Math.exp((raw[id] - mx) / temperature));
  const Z = ex.reduce((s, v) => s + v, 0);
  const weights = Object.fromEntries(ids.map((id, i) => [id, ex[i] / Z]));
  return { cat, lead, raw, weights };
}
