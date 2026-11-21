// Tools: real calls from the visitor's browser to public, key-free APIs (GitHub, Wikipedia, Open-Meteo),
// plus a safe calculator and a world clock. Each tool carries a Claude tool definition (name, description,
// input_schema), so the Claude brain can call them with real tool use.
import { ANCHORS } from './geometry.js';

const CJK = /[㐀-鿿]/;
const TIMEOUT = 7000;

// ── a tiny safe calculator: tokenizer + shunting-yard, no eval ──
const FUNCS = { sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log, abs: Math.abs, round: Math.round };
const CONSTS = { pi: Math.PI, e: Math.E };
export function calculate(src) {
  const s = String(src).replace(/×/g, '*').replace(/÷/g, '/').replace(/\*\*/g, '^').replace(/，/g, ',').toLowerCase();
  const toks = s.match(/\d+(?:\.\d+)?|[a-z]+|[+\-*/^%(),]/g);
  if (!toks || toks.join('') !== s.replace(/\s+/g, '')) throw new Error('bad expression');
  const out = [], ops = [];
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, 'neg': 2.5, '^': 3 }; // -3^2 = -(3^2)
  let prev = null;
  for (const t of toks) {
    if (/^\d/.test(t)) out.push(parseFloat(t));
    else if (CONSTS[t] !== undefined) out.push(CONSTS[t]);
    else if (FUNCS[t]) ops.push(t);
    else if (t === '(') ops.push(t);
    else if (t === ')') { while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop()); if (!ops.length) throw new Error('unbalanced'); ops.pop(); if (FUNCS[ops[ops.length - 1]]) out.push(ops.pop()); }
    else if (t === ',') continue;
    else if (prec[t]) {
      const op = t === '-' && (prev === null || (prec[prev] && prev !== ')') || prev === '(') ? 'neg' : t;
      // a prefix minus pops nothing; binary operators pop tighter (or equal, left-assoc) ones
      if (op !== 'neg') while (ops.length && prec[ops[ops.length - 1]] && (prec[ops[ops.length - 1]] > prec[op] || (prec[ops[ops.length - 1]] === prec[op] && op !== '^'))) out.push(ops.pop());
      ops.push(op);
    } else throw new Error(`unknown "${t}"`);
    prev = t;
  }
  while (ops.length) { const o = ops.pop(); if (o === '(') throw new Error('unbalanced'); out.push(o); }
  const st = [];
  for (const t of out) {
    if (typeof t === 'number') st.push(t);
    else if (t === 'neg') st.push(-st.pop());
    else if (FUNCS[t]) st.push(FUNCS[t](st.pop()));
    else { const b = st.pop(), a = st.pop(); if (a === undefined || b === undefined) throw new Error('bad expression'); st.push(t === '+' ? a + b : t === '-' ? a - b : t === '*' ? a * b : t === '/' ? a / b : t === '%' ? a % b : a ** b); }
  }
  if (st.length !== 1 || !Number.isFinite(st[0])) throw new Error('no finite result');
  return +st[0].toPrecision(12);
}

async function getJSON(url) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

const WMO = (c, zh) => {
  const m = [[0, '晴', 'clear'], [1, '大致晴朗', 'mostly clear'], [2, '局部多云', 'partly cloudy'], [3, '阴', 'overcast'], [45, '有雾', 'foggy'], [48, '雾凇', 'freezing fog'], [51, '毛毛雨', 'drizzle'], [56, '冻毛毛雨', 'freezing drizzle'], [61, '小雨', 'light rain'], [63, '中雨', 'rain'], [65, '大雨', 'heavy rain'], [66, '冻雨', 'freezing rain'], [71, '小雪', 'light snow'], [73, '中雪', 'snow'], [75, '大雪', 'heavy snow'], [77, '雪粒', 'snow grains'], [80, '阵雨', 'showers'], [82, '强阵雨', 'violent showers'], [85, '阵雪', 'snow showers'], [95, '雷暴', 'thunderstorm'], [96, '雷暴伴冰雹', 'thunderstorm with hail']];
  let best = m[0]; for (const e of m) if (c >= e[0]) best = e;
  return zh ? best[1] : best[2];
};

const CITY_TZ = [
  [/(sydney|悉尼)/i, 'Australia/Sydney', '悉尼', 'Sydney'], [/(melbourne|墨尔本)/i, 'Australia/Melbourne', '墨尔本', 'Melbourne'],
  [/(beijing|shanghai|北京|上海|深圳|广州|杭州|china|中国)/i, 'Asia/Shanghai', '北京', 'Beijing'], [/(hong ?kong|香港)/i, 'Asia/Hong_Kong', '香港', 'Hong Kong'],
  [/(taipei|台北)/i, 'Asia/Taipei', '台北', 'Taipei'], [/(tokyo|东京|japan|日本)/i, 'Asia/Tokyo', '东京', 'Tokyo'], [/(seoul|首尔)/i, 'Asia/Seoul', '首尔', 'Seoul'],
  [/(singapore|新加坡)/i, 'Asia/Singapore', '新加坡', 'Singapore'], [/(london|伦敦|uk|英国)/i, 'Europe/London', '伦敦', 'London'], [/(paris|巴黎)/i, 'Europe/Paris', '巴黎', 'Paris'],
  [/(berlin|柏林)/i, 'Europe/Berlin', '柏林', 'Berlin'], [/(new york|纽约)/i, 'America/New_York', '纽约', 'New York'],
  [/(san francisco|旧金山|silicon valley|硅谷|los angeles|洛杉矶|seattle|西雅图)/i, 'America/Los_Angeles', '旧金山', 'San Francisco'],
];

const cache = new Map();
export const toolLog = [];

export const TOOLS = [
  {
    id: 'github', icon: '⌥', color: '#c9d1d9', owner: 'memory',
    name: { zh: 'GitHub 档案', en: 'GitHub profile' },
    desc: { zh: '实时读取主人在 GitHub 上的公开档案和最近更新的仓库。', en: 'Reads the owner\'s public GitHub profile and most recently updated repositories, live.' },
    def: {
      name: 'github_profile',
      description: 'Fetch a GitHub user\'s public profile and their most recently pushed public repositories (name, description, language, stars). Use it for questions about what the owner builds, codes or works on. Defaults to the owner of this mind.',
      input_schema: { type: 'object', properties: { user: { type: 'string', description: 'GitHub login; omit for the owner' } }, additionalProperties: false },
    },
    sample: () => ({}),
    async run({ user } = {}, { lang, owner }) {
      const u = (user || owner.handle).replace(/^@/, '');
      const key = 'gh:' + u.toLowerCase();
      let data = cache.get(key);
      if (!data) {
        const [p, repos] = await Promise.all([getJSON(`https://api.github.com/users/${encodeURIComponent(u)}`), getJSON(`https://api.github.com/users/${encodeURIComponent(u)}/repos?sort=pushed&per_page=6`)]);
        data = { login: p.login, name: p.name, bio: p.bio, location: p.location, public_repos: p.public_repos, followers: p.followers,
          repos: repos.map((r) => ({ name: r.name, description: r.description, language: r.language, stars: r.stargazers_count, fork: r.fork, pushed: r.pushed_at?.slice(0, 10) })) };
        cache.set(key, data);
      }
      const top = data.repos.filter((r) => !r.fork).slice(0, 3).map((r) => `${r.name}${r.language ? `（${r.language}` + (r.stars ? `，★${r.stars}` : '') + '）' : ''}`);
      const topEn = data.repos.filter((r) => !r.fork).slice(0, 3).map((r) => `${r.name}${r.language ? ` (${r.language}${r.stars ? `, ★${r.stars}` : ''})` : ''}`);
      const summary = lang === 'zh'
        ? `@${data.login} 有 ${data.public_repos} 个公开仓库、${data.followers} 位关注者${top.length ? `。最近在更新：${top.join('、')}` : ''}。`
        : `@${data.login} has ${data.public_repos} public repos and ${data.followers} followers${topEn.length ? `. Recently pushed: ${topEn.join(', ')}` : ''}.`;
      return { summary, note: summary, data };
    },
  },
  {
    id: 'wiki', icon: 'W', color: '#e8e8e8', owner: 'curious',
    name: { zh: '维基百科', en: 'Wikipedia' },
    desc: { zh: '查一个概念或人物的维基百科摘要（中文或英文）。', en: 'Looks up the Wikipedia summary of a concept or person (Chinese or English).' },
    def: {
      name: 'wikipedia_lookup',
      description: 'Search Wikipedia and return the summary of the best-matching article. Use it for factual questions about concepts, people, places or events.',
      input_schema: { type: 'object', properties: { query: { type: 'string', description: 'What to look up' }, lang: { type: 'string', enum: ['en', 'zh'], description: 'Wikipedia language edition' } }, required: ['query'], additionalProperties: false },
    },
    sample: (lang) => ({ query: lang === 'zh' ? '多智能体系统' : 'Multi-agent system', lang }),
    async run({ query, lang: wl } = {}, { lang }) {
      const L = wl || (CJK.test(query || '') ? 'zh' : lang === 'zh' ? 'zh' : 'en');
      const key = `wk:${L}:${String(query).toLowerCase()}`;
      let data = cache.get(key);
      if (!data) {
        const s = await getJSON(`https://${L}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`);
        const title = s?.query?.search?.[0]?.title;
        if (!title) throw new Error(L === 'zh' ? '没有找到条目' : 'no article found');
        const p = await getJSON(`https://${L}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`);
        data = { title: p.title, extract: p.extract, url: p.content_urls?.desktop?.page, lang: L };
        cache.set(key, data);
      }
      const ex = [...(data.extract || '')].slice(0, 150).join('') + ((data.extract || '').length > 150 ? '…' : '');
      return {
        summary: `${data.title}：${ex}`,
        note: lang === 'zh' ? `维基百科上「${data.title}」是这么说的：${ex}` : `Wikipedia on "${data.title}": ${ex}`,
        data,
      };
    },
  },
  {
    id: 'weather', icon: '☁', color: '#8fd3ff', owner: 'dreamer',
    name: { zh: '天气', en: 'Weather' },
    desc: { zh: '查某个城市现在的天气（Open-Meteo，默认悉尼）。', en: 'Current weather for a city (Open-Meteo; Sydney by default).' },
    def: {
      name: 'weather_now',
      description: 'Get the current weather (temperature, feels-like, conditions, wind) for a city. Defaults to Sydney, where the owner lives.',
      input_schema: { type: 'object', properties: { city: { type: 'string', description: 'City name, e.g. "Sydney" or "北京"' } }, additionalProperties: false },
    },
    sample: (lang) => ({ city: lang === 'zh' ? '悉尼' : 'Sydney' }),
    async run({ city } = {}, { lang }) {
      const c = city || 'Sydney';
      const g = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(c)}&count=1&language=${lang === 'zh' ? 'zh' : 'en'}&format=json`);
      const loc = g?.results?.[0];
      if (!loc) throw new Error(lang === 'zh' ? `找不到城市「${c}」` : `unknown city "${c}"`);
      const w = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day&timezone=auto`);
      const cur = w.current;
      const data = { city: loc.name, country: loc.country, temperature: cur.temperature_2m, feels_like: cur.apparent_temperature, conditions: WMO(cur.weather_code, lang === 'zh'), wind_kmh: cur.wind_speed_10m, is_day: !!cur.is_day, local_time: cur.time };
      const summary = lang === 'zh'
        ? `${data.city}现在 ${Math.round(data.temperature)}°C（体感 ${Math.round(data.feels_like)}°C），${data.conditions}，风速 ${Math.round(data.wind_kmh)} km/h。`
        : `${data.city} right now: ${Math.round(data.temperature)}°C (feels like ${Math.round(data.feels_like)}°C), ${data.conditions}, wind ${Math.round(data.wind_kmh)} km/h.`;
      return { summary, note: summary, data };
    },
  },
  {
    id: 'calc', icon: '∑', color: '#5dffa0', owner: 'builder',
    name: { zh: '计算器', en: 'Calculator' },
    desc: { zh: '安全地计算数学表达式（自己写的解析器，不用 eval）。支持 + − × ÷ ^ % ( ) sqrt sin cos log pi。', en: 'Evaluates a maths expression safely (a hand-written parser, no eval). Supports + − × ÷ ^ % ( ) sqrt sin cos log pi.' },
    def: {
      name: 'calculator',
      description: 'Evaluate an arithmetic expression exactly. Supports + - * / ^ % parentheses, sqrt, sin, cos, tan, log (base 10), ln, abs, round, pi, e.',
      input_schema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'], additionalProperties: false },
    },
    sample: () => ({ expression: '(1 + sqrt(5)) / 2' }),
    async run({ expression } = {}, { lang }) {
      const v = calculate(expression);
      return { summary: `${expression} = ${v}`, note: lang === 'zh' ? `算出来是 ${v}。` : `That comes to ${v}.`, data: { expression, result: v } };
    },
  },
  {
    id: 'clock', icon: '◴', color: '#ff9b4a', owner: 'jester',
    name: { zh: '世界时钟', en: 'World clock' },
    desc: { zh: '换算城市之间的时间，默认对比主人所在的悉尼和你所在的时区。', en: 'Converts time between cities; by default compares the owner\'s Sydney with your own time zone.' },
    def: {
      name: 'world_clock',
      description: 'Current local time in one or more cities (and the visitor\'s own time zone). Use it for questions about what time it is somewhere or time differences.',
      input_schema: { type: 'object', properties: { cities: { type: 'array', items: { type: 'string' }, description: 'City names; omit to compare Sydney with the visitor' } }, additionalProperties: false },
    },
    sample: (lang) => ({ cities: lang === 'zh' ? ['悉尼', '北京', '伦敦'] : ['Sydney', 'Tokyo', 'London'] }),
    async run({ cities } = {}, { lang, owner }) {
      const zh = lang === 'zh';
      const fmt = (tz) => new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).format(new Date());
      const list = [];
      for (const c of cities?.length ? cities : [owner.location.en]) {
        const hit = CITY_TZ.find(([re]) => re.test(c));
        if (hit) list.push({ city: zh ? hit[2] : hit[3], tz: hit[1] });
        else if (/^[A-Za-z]+\/[A-Za-z_]+$/.test(c)) list.push({ city: c.split('/')[1].replace(/_/g, ' '), tz: c });
      }
      const mine = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!cities?.length && !list.some((x) => x.tz === mine)) list.push({ city: zh ? '你那边' : 'you', tz: mine });
      if (!list.length) throw new Error(zh ? '不认识这些城市' : 'unknown cities');
      const data = list.map((x) => ({ ...x, time: fmt(x.tz) }));
      const summary = data.map((x) => `${x.city} ${x.time}`).join(' · ');
      return { summary, note: zh ? `现在的时间：${summary}。` : `Right now: ${summary}.`, data };
    },
  },
];
export const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.def.name, t]));
export const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

// Tool satellites float on a ring outside the head; register them as animation anchors.
TOOLS.forEach((t, k) => {
  const a = (k / TOOLS.length) * Math.PI * 2 + 0.5;
  t.pos = [Math.cos(a) * 1.72, 0.5 + Math.sin(a * 2) * 0.22, Math.sin(a) * 1.5 - 0.1];
  ANCHORS['tool_' + t.id] = t.pos;
});

export async function executeTool(id, input, ctx, origin = 'meeting') {
  const t = TOOL_BY_ID[id] || TOOL_BY_NAME[id];
  const t0 = performance.now();
  let res;
  try { res = { ok: true, ...(await t.run(input || {}, ctx)) }; }
  catch (e) { res = { ok: false, summary: (ctx.lang === 'zh' ? '调用失败：' : 'Failed: ') + (e.name === 'AbortError' ? 'timeout' : e.message), data: { error: String(e.message || e) } }; }
  res.ms = Math.round(performance.now() - t0);
  toolLog.unshift({ tool: t.id, input, ok: res.ok, ms: res.ms, summary: res.summary, origin, ts: Date.now() });
  toolLog.length = Math.min(toolLog.length, 30);
  return res;
}

// ── the simulated brain's tool router: rules decide which tools a question needs ──
const NOT_A_TOPIC = /^(你|你们|您|我|你自己|yourself|you|me|this|this site|这个网站|这个页面|the mind)$/i;
export function planTools(q, owner) {
  const plan = [];
  const s = q.trim();
  // arithmetic: the longest run of digits and operators that contains an operator
  const runs = (s.match(/[\d(][\d\s+\-*/×÷^%().]*[\d)]/g) || []).filter((r) => /\d\s*[+\-*/×÷^%]\s*[\d(]/.test(r)).sort((a, b) => b.length - a.length);
  if (runs[0]) { try { calculate(runs[0]); plan.push({ tool: 'calc', input: { expression: runs[0].trim() } }); } catch {} }
  if (/(天气|气温|冷不冷|热不热|下雨|weather|temperature|raining|sunny|forecast)/i.test(s)) {
    let city = (s.match(/(?:weather|temperature|raining|sunny)\s+(?:in|at|for)\s+([a-z][a-z .'-]{1,30}?)(?:\s+(?:now|today|right now))?[?!.]*$/i) || [])[1]
      || (s.match(/([一-鿿]{2,4}?)(?:的|现在|今天)*(?:天气|气温|冷不冷|热不热|下雨)/) || [])[1];
    if (city && /^(今天|现在|明天|那边|这边|外面|你那|你们)$/.test(city)) city = null;
    plan.push({ tool: 'weather', input: { city: city || owner.location.en } });
  }
  if (/(github|repo|仓库|项目|代码|开源|作品|在做什么|做了什么|working on|projects?\b|your code|what do you build)/i.test(s)) plan.push({ tool: 'github', input: {} });
  if (/(几点|什么时间|时差|时区|what time|time (?:in|is it|difference)|timezone|time zone)/i.test(s)) {
    const cities = CITY_TZ.filter(([re]) => re.test(s)).map(([, , zh, en]) => (CJK.test(s) ? zh : en));
    plan.push({ tool: 'clock', input: cities.length ? { cities } : {} });
  }
  let m = s.match(/^(?:请|帮我)?(?:介绍一下|讲讲|解释一下|什么是|谁是)\s*(.+?)[？?。！!]*$/) || s.match(/^(.+?)(?:是什么|是谁|是啥)[？?。！!]*$/)
    || s.match(/^(?:what(?:'s| is| are| was)|who(?:'s| is| was)|tell me about|explain)\s+(?:a |an |the )?(.+?)[?.!]*$/i);
  if (m && !plan.length) { // only when nothing more specific already answers it
    const term = m[1].trim();
    if (term && term.length <= 40 && !NOT_A_TOPIC.test(term) && !/(you|你)(\s|$)/i.test(term)) plan.push({ tool: 'wiki', input: { query: term, lang: CJK.test(term) ? 'zh' : 'en' } });
  }
  return plan.slice(0, 2);
}

// Replays already-executed tool calls as meeting events (used by the simulated brain).
export function* toolEvents(results, lang, agents) {
  if (!results.length) return;
  yield { type: 'phase', key: 'tools' };
  for (const r of results) {
    const t = TOOL_BY_ID[r.tool];
    const from = agents.find((a) => a.id === t.owner) ? t.owner : 'self';
    yield { type: 'tool_call', from, tool: t.id, input: r.input };
    yield { type: 'tool_result', from, tool: t.id, ok: r.ok, summary: r.summary, ms: r.ms };
    yield { type: 'say', from, to: 'self', kind: 'tool', text: r.ok ? (lang === 'zh' ? `我查了「${t.name.zh}」：${r.summary}` : `I checked ${t.name.en}: ${r.summary}`) : (lang === 'zh' ? `「${t.name.zh}」没回应（${r.summary}），我们靠自己。` : `${t.name.en} didn't answer (${r.summary}); we're on our own.`) };
  }
}
