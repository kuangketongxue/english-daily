#!/usr/bin/env node
/**
 * 英文日报 · 每日一篇英文长文精选
 *
 * 取数：拉 sources.json 里全部 RSS（不依赖任何付费搜索 API），只收 72 小时内、标题为英文的长文。
 * 选品：站点权重 × 新鲜度 × 篇幅，去重靠 data/history.json 里的链接集合，写过的不再写。
 * 成稿：抓正文 → 让模型写中文导读（标题中译 / 150~220 字摘要 / 3 个要点 / 难度）。
 *       有 AI_API_KEY 走 OpenAI 兼容接口；没有就用 GitHub Models（github.token，需 models:read）。
 *
 * 定时：GitHub 的 schedule 会迟到也会整段丢失，所以既有多个 cron，也有 pickTarget 补缺期。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const POSTS = join(DATA, 'posts');
const HIST = join(DATA, 'history.json');
const SRC = join(ROOT, 'scripts', 'sources.json');

const AI_KEY = process.env.AI_API_KEY || '';
const AI_BASE = (process.env.AI_BASE_URL || '').replace(/\/+$/, '');
const AI_URL = AI_BASE.endsWith('/chat/completions') ? AI_BASE : `${AI_BASE}/chat/completions`;
const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const TARGET_DATE = String(process.env.TARGET_DATE || '').trim();
// 手动指定今天的稿子（热点原信这类「就是它」的场景），优先级高于一切选品
const FORCE_URL = String(process.env.FORCE_URL || '').trim();
const DRY = /^(1|true)$/i.test(String(process.env.DRY_RUN || ''));
const UA = 'Mozilla/5.0 (compatible; english-daily/1.0)';
const MIN_WORDS = 700;
const MAX_AGE_H = 72;

const log = (...a) => console.log('[英文日报]', ...a);
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const shift = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
};

async function get(url, ms = 25000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: c.signal, redirect: 'follow' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const strip = (s) => s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'")
  .replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, '—').replace(/&hellip;/g, '…')
  .replace(/\s+/g, ' ').trim();

const dec = (s) => strip(s.replace(/<!\[CDATA\[|\]\]>/g, ''));

function parseFeed(xml, name, weight) {
  const out = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? dec(m[1]) : '';
    };
    let link = pick('link');
    if (!link) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i);
      if (m) link = m[1];
    }
    const title = pick('title');
    const desc = pick('description') || pick('summary') || pick('content');
    const dateRaw = pick('pubDate') || pick('published') || pick('updated') || pick('dc:date');
    const ts = Date.parse(dateRaw);
    if (!title || !link || !Number.isFinite(ts)) continue;
    out.push({ source: name, weight, title, link, excerpt: desc.slice(0, 400), ts });
  }
  return out;
}

const englishRatio = (s) => {
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  return s.length ? letters / s.length : 0;
};

async function gather() {
  const cfg = JSON.parse(readFileSync(SRC, 'utf8'));
  const res = await Promise.allSettled(cfg.sources.map(async (s) => {
    const xml = await get(s.rss);
    return parseFeed(xml, s.name, s.weight);
  }));
  const all = [];
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      all.push(...r.value);
      log(`  ✓ ${cfg.sources[i].name}  ${r.value.length} 条`);
    } else {
      log(`  ✗ ${cfg.sources[i].name}  ${r.reason.message}`);
    }
  });
  return all;
}

// 热点信号：先按「当下最容易被讨论的题材」给标题与摘要加权，
// 再让站点权重兜底。纯杂志散文永远排在爆款公开信后面 —— 这是本人 2026-11-24 的要求。
// 域名与体裁：大佬一手长文 > 官方 newsroom > 主流媒体 > 二手报道/UGC。
// 2026-11-27 用户要求：达里奥/马斯克/山姆·奥特曼等大佬的社交/个人署名长文应优先于纽约时报等媒体。
// 注意：搜索引擎抓不到 X 原帖正文（实测 8 条里 7 条是二手报道、1 条 reddit 转述），
// 故真正能选中并精读的是大佬本人署名的一手长文（个人站/官方 newsroom/本人 Substack）。
const DOMAIN_BOOST = [
  // 大佬本人署名的一手长文：最高优先级
  [/(darioamodei\.com|samaltman\.com|anthropic\.com|openai\.com|x\.ai|tesla\.com|spacex\.com|nvidia\.com|blogs\.nvidia\.com)$/i, 78],
  // 其他公司官方 newsroom
  [/(nvidianews\.nvidia\.com|blog\.google|apple\.com|microsoft\.com|about\.fb\.com|meta\.com|amazon\.com|stripe\.com|shopify\.com)$/i, 70],
  // 主流媒体：降权，不再压过大佬一手长文
  [/(nytimes|bloomberg|wsj\.com|ft\.com|reuters|apnews|theverge|techcrunch|wired|economist|newyorker|theatlantic|axios|cnbc|fortune|businessinsider|economictimes|livemint|scmp|nikkei|theinformation)/i, 12],
  // X/推特帖子：2026-11-27 用户确认二手讨论帖也可接受，site:x.com 搜到的原帖/转述给正分，
  // 让它能进候选池（但仍低于大佬本人一手长文 78）。其余 UGC 保持轻降权。
  [/(x\.com|twitter\.com)/i, 20],
  [/(medium\.com|substack\.com|linkedin\.com|reddit\.com|quora|facebook\.com|youtube\.com)/i, -5],
  // 二手聚合/转载站：标题里常有 "Read full letter"、正文是别人的稿子，2026-11-24 用户明确要求只收一手
  [/(techdogs|gasgoo|futunn|autonews|indiatimes|livemint|firstpost|news18|zeenews|sohu|163\.com|sina|toutiao|36kr|jiemian|thepaper)/i, -60],
];
const SECONDHAND = /(techdogs|gasgoo|futunn|autonews|indiatimes|livemint|firstpost|news18|zeenews|sohu|163\.com|sina\.|toutiao|36kr|jiemian|thepaper|qq\.com|ifeng)/i;
const LISTICLE = /\b(examples?|templates?|sample letters?|how to write|best \d+|top \d+|a guide to writing|tips for)\b/i;
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

const HOT = [
  [/\b(resign|resignation|steps down|ousted)\b/i, 26],
  // 2026-11-27 用户要求：黄仁勋道歉信这类「CEO 公开信/致员工信/声明」是真正有用的文章，
  // 优先级压过大佬域名长文（78）。这类是不可替代的一手事件文本，不是普通杂志散文。
  [/\b(apolog|apology|apologizes|sorry|open letter|letter to (staff|employees)|memo to|statement from)\b/i, 90],
  [/\b(dario amodei|dario|sam altman|elon musk|jensen huang|demis hassabis|mustafa suleyman)\b/i, 34],
  [/\b(nvidia|jensen huang|openai|anthropic|sam altman|apple|tim cook|tesla|musk)\b/i, 22],
  [/\b(layoff|layoffs|shut down|bankrupt|crisis|collapse)\b/i, 16],
  [/\b(ai|artificial intelligence|model|chip|gpu|agent)\b/i, 12],
  [/\b(ceo|founder|board|shareholder|investor)\b/i, 10],
];
// 个性化：读 data/ratings.json，按「同一来源历史平均分」给候选加权。
// 5 分常看 → ×1.4，1 分 → ×0.6；没打过分的来源保持原样。
function sourceBias() {
  try {
    const r = JSON.parse(readFileSync(join(DATA, 'ratings.json'), 'utf8'));
    const by = {};
    const posts = existsSync(POSTS) ? readdirSync(POSTS).filter(f => f.endsWith('.json')) : [];
    const src = {};
    for (const f of posts) { try { const p = JSON.parse(readFileSync(join(POSTS, f), 'utf8')); src[p.date] = p.source; } catch {} }
    for (const [d, v] of Object.entries(r.ratings || {})) {
      const s = src[d]; if (!s || !v) continue;
      (by[s] = by[s] || []).push(Number(v));
    }
    const out = {};
    for (const [s, arr] of Object.entries(by)) {
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      out[s] = 0.6 + (avg - 1) * 0.2;      // 1→0.6, 3→1.0, 5→1.4
    }
    return out;
  } catch { return {}; }
}

function hotScore(x) {
  const hay = `${x.title} ${x.excerpt}`;
  let s = 0;
  for (const [re, w] of HOT) if (re.test(hay)) s += w;
  const host = hostOf(x.link);
  const bias = globalThis.__bias?.[x.source] ?? 1;
  s *= bias;
  for (const [re, w] of DOMAIN_BOOST) if (re.test(host)) s += w;
  // 新鲜度：48 小时内每早 1 小时 +0.5 分，最多 24 分 —— 保证「最新最前沿」优先于旧文
  const h = (Date.now() - x.ts) / 3600e3;
  if (h >= 0 && h < 48) s += (48 - h) * 0.5;
  return s;
}


// ── JS 站兜底：直接 fetch 抓不到正文（newsroom 多为前端渲染）时，交给 Firecrawl 渲染 ──
// key 复用 parallel-search 的 firecrawl_keys（CI 里由 PS_CONFIG 写进仓库根的 config.json）。
function psConfig() { try { return JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')); } catch { return {}; } }
async function firecrawlMarkdown(url) {
  const cfg = psConfig();
  const keys = cfg.firecrawl_keys || (cfg.firecrawl_key ? [cfg.firecrawl_key] : []);
  if (!keys.length) return '';
  for (const k of keys) {
    try {
      const r = await fetch('https://api.firecrawl.dev/v2/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
        body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true, waitFor: 2500 }),
      });
      if (!r.ok) continue;
      const j = await r.json();
      const md = j?.data?.markdown || '';
      if (md) return md;
    } catch {}
  }
  return '';
}
function mdToParas(md) {
  return md.split(/\n{2,}/)
    .map(x => x.replace(/\[(.*?)\]\(.*?\)/g, '$1').replace(/[#*_>`]/g, '').replace(/\s+/g, ' ').trim())
    .filter(x => x.length > 60 && englishRatio(x) > 0.55)
    .slice(0, 60);
}

function pageDate(html) {
  const pats = [
    /property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]+property=["']article:published_time["']/i,
    /name=["'](?:pubdate|publishdate|date|dc.date)["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m) { const t = Date.parse(m[1]); if (Number.isFinite(t)) return t; }
  }
  return 0;
}

function extractBody(html) {
  const art = html.match(/<article[\s\S]*?<\/article>/i);
  let block = art ? art[0] : html.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');
  const paras = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(m => strip(m[1]))
    .filter(p => p.length > 60 && englishRatio(p) > 0.55);
  const text = paras.join('\n');
  return { text, paras: paras.slice(0, 60), words: (text.match(/\b[A-Za-z][A-Za-z'-]*\b/g) || []).length };
}

async function ask(prompt) {
  const messages = [
    { role: 'system', content: '你是中文科技与思想类编辑，把英文长文整理成一份可学习的中文导读与精读笔记。只输出 JSON，不要代码块、不要解释、不要多余文字。' },
    { role: 'user', content: prompt },
  ];
  if (AI_KEY && AI_BASE) {
    const r = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, messages, temperature: 0.35 }),
    });
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  }
  // GitHub Models 已于 2026-07-30 全面下线，不能再用 github.token 兜底。
  // 没有自备 key 时明确报错，让上层降级为「只发原文信息」，不要静默产出半成品。
  throw new Error('未配置 AI_API_KEY / AI_BASE_URL（GitHub Models 已下线）');
}

// ── 导读 + 精读：一次产出完整结构，校验不过就带着问题重问一次 ──
// 只有「够短」的文章才做逐段中译：长文全译既贵又慢，而且对学习没什么增益。
function analysisPrompt(chosen, wantTrans) {
  const numbered = (chosen.paras || []).map((p, i) => `[${i + 1}] ${p}`).join('\n\n').slice(0, 16000);
  const transRule = wantTrans
    ? '- translation：与段落一一对应的中文翻译，数组长度必须等于段落数，逐段翻译，不要合并。'
    : '- translation：这篇太长，返回空数组 []。';
  return `文章标题：${chosen.title}
来源：${chosen.source}
总词数：${chosen.words}

正文（按段落编号，可能被截断）：
${numbered}

请读完再输出一个 JSON 对象，字段如下：
{
  "title_zh": "标题的准确中译，不加书名号",
  "author": "作者署名，正文里找不到就填空字符串",
  "genre": "体裁，例如 公开信 / 社论 / 深度报道 / 人物特写",
  "cefr": "整篇难度，只能是 A2 / B1 / B2 / C1 / C2 之一，附半句话理由，例如「B2（长句多、抽象名词多）」",
  "themes": ["2~4 个中文主题标签"],
  "tldr": "一句话结论，不超过 30 字，要有判断不要复述标题",
  "digest": "180~260 字中文导读：讲清这篇在说什么、作者的立场是什么、为什么值得读。不要复述标题，不要用「本文」开头。",
  "points": ["3 条读完能带走的具体信息，每条 30~50 字"],
  "analysis": {
    "outline": [{"at": 段落编号, "h": "这段在做什么，8~14 字", "note": "40~70 字，讲结构作用，不要复述内容"}],
    "sentences": [{"en": "原文里的长难句，一字不改", "zh": "准确中译", "gram": "拆解主干、指出语法点，可用 <b> 强调关键词，60~120 字"}],
    "vocab": [{"w": "词或短语", "pos": "词性缩写", "zh": "在这篇里的准确释义", "ex": "原文中的完整句子"}],
    "patterns": [{"pattern": "可直接套用的句式", "zh": "什么场合用，30 字内", "ex": "自己造一个不同的例句"}],
    "questions": ["3 个能引出思考或讨论的问题，中文，不要问「你学到了什么」这类空话"]
  },
  "translation": ["逐段中文"]
}

硬性要求：
- analysis.outline 覆盖全文结构，3~7 条，at 必须是上面真实存在的段落编号，且按升序。
- analysis.sentences 2~4 条，必须从原文逐字摘录，不许改写。
- analysis.vocab 6~10 个，优先选「认识但用不出来」的词，不要选 the / of 这类。
- analysis.patterns 3~5 条，必须能迁移到写作。
${transRule}
- 所有中文都用简体，不要出现英文标点的全角混排问题。
- 不确定的字段宁可留空字符串，也不要编造作者、日期或事实。`;
}

function validateAnalysis(j, chosen, wantTrans) {
  const p = [];
  if (!j.title_zh || String(j.title_zh).length < 4) p.push('title_zh 缺失');
  if (!j.digest || String(j.digest).length < 80) p.push('digest 少于 80 字');
  if (!Array.isArray(j.points) || j.points.length < 3) p.push('points 少于 3 条');
  if (!j.cefr) p.push('cefr 缺失');
  const a = j.analysis || {};
  const n = (chosen.paras || []).length;
  if (!Array.isArray(a.outline) || a.outline.length < 3) p.push('outline 少于 3 段');
  else if (a.outline.some(o => !o || !o.at || o.at < 1 || o.at > n)) p.push('outline.at 超出段落范围');
  if (!Array.isArray(a.sentences) || a.sentences.length < 2) p.push('sentences 少于 2 句');
  if (!Array.isArray(a.vocab) || a.vocab.length < 5) p.push('vocab 少于 5 词');
  if (!Array.isArray(a.patterns) || a.patterns.length < 2) p.push('patterns 少于 2 条');
  if (!Array.isArray(a.questions) || a.questions.length < 2) p.push('questions 少于 2 条');
  if (wantTrans && (!Array.isArray(j.translation) || j.translation.length < Math.max(2, Math.floor(n * 0.8)))) {
    p.push('translation 段数不足');
  }
  return p;
}

async function analyze(chosen) {
  const wantTrans = chosen.words <= 800;
  const base = analysisPrompt(chosen, wantTrans);
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = await ask(attempt === 1 ? base : `${base}\n\n上一次输出不合格：${lastErr}。请严格按上面的字段重写，不要省略任何字段。`);
      const j = parseJSONLoose(out);
      const problems = validateAnalysis(j, chosen, wantTrans);
      if (!problems.length) return j;
      lastErr = problems.join('；');
      log(`  ⚠️ 第 ${attempt} 次导读不合格：${lastErr}`);
    } catch (e) {
      lastErr = e.message;
      log(`  ⚠️ 第 ${attempt} 次导读失败：${e.message}`);
    }
  }
  throw new Error(lastErr || '模型没有产出可用导读');
}

function parseJSONLoose(s) {
  const t = s.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
  const i = t.indexOf('{'), k = t.lastIndexOf('}');
  if (i < 0 || k < i) throw new Error('模型没有返回 JSON');
  return JSON.parse(t.slice(i, k + 1));
}

// 首页只吃「目录级」字段，正文留在 data/posts/<date>.json。
// 之前把 body 全塞进 index.json，每期 60 段，几十期之后首屏就是几百 KB。
function slimIssue(p) {
  return {
    date: p.date,
    title: p.title,
    title_zh: p.title_zh || '',
    author: p.author || '',
    source: p.source || '',
    link: p.link || '',
    words: p.words || 0,
    minutes: p.minutes || 0,
    published: p.published || '',
    genre: p.genre || '',
    cefr: p.cefr || p.difficulty || '',
    themes: Array.isArray(p.themes) ? p.themes.slice(0, 4) : [],
    tldr: p.tldr || '',
    digest: p.digest || '',
    points: Array.isArray(p.points) ? p.points.slice(0, 3) : [],
    snippet: p.snippet || (Array.isArray(p.body) ? (p.body[1] || p.body[0] || '').slice(0, 220) : ''),
    has_analysis: !!p.analysis,
    has_translation: !!(Array.isArray(p.translation) && p.translation.length),
  };
}

function rebuildIndex() {
  const issues = (existsSync(POSTS) ? readdirSync(POSTS).filter(f => f.endsWith('.json')) : [])
    .map(f => { try { return JSON.parse(readFileSync(join(POSTS, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(slimIssue);

  // 书籍 / 剧集 / 电影先留空壳：有 data/library.json 就并进来，没有就空数组
  let lib = { books: [], series: [], films: [] };
  try {
    const raw = JSON.parse(readFileSync(join(DATA, 'library.json'), 'utf8'));
    lib = { books: raw.books || [], series: raw.series || [], films: raw.films || [] };
  } catch {}

  mkdirSync(DATA, { recursive: true });
  const payload = {
    updated: today(),
    counts: {
      articles: issues.length,
      books: lib.books.length,
      series: lib.series.length,
      films: lib.films.length,
    },
    issues,
    books: lib.books,
    series: lib.series,
    films: lib.films,
  };
  writeFileSync(join(DATA, 'index.json'), JSON.stringify(payload, null, 2) + '\n');
  return issues.length;
}


// ── 全网搜索（parallel-search skill 内置，Exa/Tavily/Firecrawl/元宝 多源并行）──
// 媒体 RSS 拿不到「公司自己发的信」，这类东西只在 newsroom 和全网索引里。
// 所以每天先用几条热点 query 去搜，搜到的页面与 RSS 候选一起排序，热点稿天然靠前。
const HOT_QUERIES = [
  // 2026-11-27 用户要求：大佬本人署名的一手长文优先（达里奥/马斯克/山姆·奥特曼）
  'Dario Amodei essay reflection AI anthropic latest',
  'Sam Altman blog essay latest thoughts',
  'Elon Musk long post essay X latest',
  // 2026-11-27 用户确认：推特二手内容也可接受。site:x.com 实测能让 Firecrawl 返回 X 帖
  // （不带 site: 只会返回二手新闻报道）；官方 exa 未配 key，实际走 firecrawl。
  'site:x.com Dario Amodei Sam Altman Elon Musk AI',
  'site:x.com Anthropic Claude OpenAI GPT announcement',
  // 2026-11-27 用户举例「黄仁勋的道歉信」：CEO 公开信/致员工信/道歉声明优先
  'Jensen Huang apology letter to Nvidia employees',
  'CEO open letter apology statement to employees 2026',
  'tech CEO memo to employees controversy apology',
  'CEO resignation letter to employees this week',
  'open letter to employees AI company 2026',
  'founder public apology letter full text',
];
const PY = process.platform === 'win32' ? 'python' : 'python3';
function psSearch(query) {
  return new Promise((resolve) => {
    const out = join(tmpdir(), `ps-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    execFile(PY, [join(ROOT, 'scripts', 'ps_search.py'), '--query', query, '--top-k', '8', '--out', out],
      { timeout: 150000, maxBuffer: 8 * 1024 * 1024 }, (err) => {
        if (err) { log(`  搜索失败（${query.slice(0, 24)}…）：${err.message.split('\n')[0]}`); return resolve([]); }
        try {
          const j = JSON.parse(readFileSync(out, 'utf8'));
          resolve((j.results || []).map(r => ({
            source: hostOf(r.url || r.link || '') || 'web', weight: 12,
            title: r.title || '', link: r.url || r.link || '',
            excerpt: r.description || r.snippet || r.text || '',
            // 2026-11-27 修复：搜索结果原 ts=0（1970年）会被候选池的 72h 时间窗全部过滤掉，
            // 导致「CEO 公开信」这类只在搜索里的题材永远进不了候选。改为用「刚搜到」的时间，
            // 真实发布日期在 pickFrom 抓正文时由 pageDate 再校验。
            ts: Date.now(), viaSearch: true,
          })).filter(x => x.link && x.title));
        } catch (e) { resolve([]); }
      });
  });
}

async function gatherWeb() {
  const lists = await Promise.all(HOT_QUERIES.map(psSearch));
  const seen = new Set();
  const out = [];
  // CEO 公开信/道歉信：题材本身不受 72h 时间窗限制（2026-11-27 用户要「黄仁勋道歉信」这类）
  // 只认「公开信原文 / 原始报道」：标题必须同时出现「公开信类动作词」且不含「解读/评论/总结」词。
  // 2026-11-27 实撞：explainx.ai 的 "X Letter Explained" 二手解读被误判进候选并选中，故收紧。
  const LETTER_RE = /\b(apolog|apolog(y|izes|ise)|open letter|letter to (staff|employees|the board)|memo to|statement (from|to)|resign(ation)? letter|read (the |his |her )?(memo|letter))\b/i;
  const LETTER_NEG = /\b(explained|explainer|review|summary|recap|analysis|what it means|breakdown|opinion|commentary)\b/i;
  const isLetterTitle = (t) => LETTER_RE.test(t) && !LETTER_NEG.test(t);
  for (const list of lists) for (const x0 of list) {
    const x = { ...x0, isLetter: isLetterTitle((x0.title || '') + ' ' + (x0.excerpt || '')) };
    if (seen.has(x.link)) continue;
    seen.add(x.link);
    // 搜索结果的标题多是中文站转载，只留英文标题的页面
    if (englishRatio(x.title) < 0.5) continue;
    if (LISTICLE.test(x.title)) continue;   // 范本/教程/清单类不是新闻
    // 二手转载站直接丢：2026-11-24 用户要求「只要一手优质」，转载稿的日期和措辞都不可信
    if (SECONDHAND.test(hostOf(x.link))) continue;
    // 2026-11-27 实撞：blog.samaltman.com/2279512 这种纯数字碎帖、或博客/站点首页，
    // 抓进来标题都是残句（"has a real ring of power dynamic to it"），不是完整文章。
    // 规则：URL 是根路径、或末段是纯数字 ID 的，当碎片丢掉。
    try {
      const u = new URL(x.link);
      const seg = u.pathname.replace(/\/+$/, '');
      if (seg === '' ) continue;                       // 站点首页
      const last = seg.split('/').pop() || '';
      if (/^\d{4,}$/.test(last)) continue;             // 纯数字 ID 碎帖
    } catch { continue; }
    // 标题短且不是完整句（无空格或以小写/引语开头）——多半是残句
    const tt = (x.title || '').trim();
    if (tt.length < 12) continue;
    out.push(x);
  }
  log(`  全网搜索补充 ${out.length} 条（英文标题）`);
  return out;
}

// ── 大佬一手长文源（2026-11-27 用户要求）──
// 达里奥/马斯克/山姆·奥特曼等大佬的社交原帖搜索引擎抓不到正文（实测 8 条里 7 条是二手报道），
// 但他们本人署名的长文有稳定入口：个人站 sitemap / 官方 newsroom 栏目页 / 官方 RSS。
// 这里从这些入口解析文章 URL，作为高优先级候选；这些长文本身不常更新，故豁免 72h 时间窗，
// 靠 data/history.json 去重防止重复写同一篇。
async function gatherLeaders() {
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(join(ROOT, 'scripts', 'leaders.json'), 'utf8'));
  } catch { return []; }
  const out = [];
  const seen = new Set();
  await Promise.all((cfg.sources || []).map(async (s) => {
    try {
      const doc = await get(s.url, 30000);
      let urls = [];
      if (s.type === 'sitemap') {
        urls = [...doc.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]).slice(0, 30);
      } else if (s.type === 'rss') {
        // 只取 <item> 内的 <link>：OpenAI 的 RSS 用 <link> 做 language alternate，
        // 直接全局匹配会捞到 1400+ 条导航链接（2026-11-27 实撞）。
        const items = doc.match(/<item[\s>][\s\S]*?<\/item>/g) || [];
        urls = items.slice(0, 15).map(it => (it.match(/<link>\s*([^<\s]+)\s*<\/link>/) || [])[1]).filter(Boolean);
      } else if (s.type === 'page') {
        urls = [...doc.matchAll(/href=["']([^"']+)["']/g)].map(m => m[1]).slice(0, 40);
      }
      const re = s.match ? new RegExp(s.match, 'i') : /./;
      let n = 0;
      for (const u0 of urls) {
        let u = u0;
        try { u = new URL(u0, s.url).href; } catch { continue; }
        if (seen.has(u) || !re.test(u)) continue;
        seen.add(u);
        // ts=0 表示"不受新鲜度过滤"；isLeader 让主流程豁免 72h 并加权
        out.push({
          source: s.name, weight: s.weight, title: '', link: u,
          excerpt: '', ts: 0, viaSearch: true, isLeader: true,
        });
        n++;
      }
      log(`  ✓ 大佬源 ${s.name}  ${n} 篇长文`);
    } catch (e) {
      log(`  ✗ 大佬源 ${s.name}  ${e.message}`);
    }
  }));
  log(`  大佬一手长文候选 ${out.length} 篇`);
  return out;
}

function pickTarget() {
  const t = today();
  if (TARGET_DATE) return TARGET_DATE;
  if (!existsSync(join(POSTS, `${t}.json`))) return t;
  for (let i = 1; i <= 3; i++) {
    const d = shift(t, -i);
    if (!existsSync(join(POSTS, `${d}.json`))) return d;
  }
  return null;
}

async function main() {
  // 只重建索引：手改过 data/posts/*.json 之后用它同步首页目录
  if (process.argv.includes('--reindex')) {
    const n = rebuildIndex();
    log(`索引重建完成：共 ${n} 期`);
    return;
  }
  const date = DRY ? today() : pickTarget();
  if (!date) { log(`今日 ${today()} 已有文章，近 3 天无缺期，跳过`); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期不合法：${date}`);
  log(`开始选品 ${date} …`);

  const history = new Set(existsSync(HIST) ? JSON.parse(readFileSync(HIST, 'utf8')) : []);
  const now = Date.now();
  globalThis.__bias = sourceBias();
  if (Object.keys(globalThis.__bias).length) log('  个性化权重：' + Object.entries(globalThis.__bias).map(([k, v]) => `${k}×${v.toFixed(2)}`).join(' / '));
  const [feedItems, webItems, leaderItems] = await Promise.all([gather(), gatherWeb(), gatherLeaders()]);
  // 同一站点最多占 3 个名额：否则 The Atlantic 一批 403 就能把整个候选池占满，
  // 明明 Aeon / Stratechery 等源有可抓的长文，脚本却报「候选全部抓不到」（2026-11-26 实撞）。
  const perHost = Object.create(null);
  const candidates = [...leaderItems, ...webItems, ...feedItems]
    .filter(x => !history.has(x.link))
    // 大佬一手长文：标题由正文抓取时再取（此处为空），故跳过英文标题比例与 72h 时间窗过滤；
    // 大佬长文本身不常更新，靠 history 去重即可防重复。
    .filter(x => x.isLeader || x.isLetter || (englishRatio(x.title) > 0.6 && now - x.ts <= MAX_AGE_H * 3600e3))
    .map(x => ({ ...x, heat: hotScore(x) + (x.isLeader ? 60 : 0) }))
    .filter(x => {
      const h = hostOf(x.link) || 'web';
      perHost[h] = (perHost[h] || 0) + 1;
      return perHost[h] <= 3;
    })
    .sort((a, b) => (b.heat - a.heat) || (b.weight - a.weight) || (b.ts - a.ts))
    .slice(0, 30);
  log(`候选 ${candidates.length} 篇（72 小时内、未写过、单站最多 3 篇）`);
  if (!candidates.length) throw new Error('没有可用候选：源站全部无新文或都已写过');

  let forced = null;
  if (FORCE_URL) {
    log(`指定稿件：${FORCE_URL}`);
    // 指定稿件不受 72 小时/字数门槛限制，但仍要抓到正文
    candidates.unshift({ source: hostOf(FORCE_URL) || 'web', weight: 99, title: '', link: FORCE_URL, excerpt: '', ts: 0, viaSearch: true, forced: true });
  }

  // 选品分两轮：常规门槛先上；全部失败就放宽到 7 天 / 450 词。
  // 2026-11-26 连续 8 批定时任务全挂在「候选全部抓不到」，根因是单一站点 403 占满候选池 + 无降级。
  const pickFrom = async function (list, minWords, maxAgeH) {
    for (const c of list) {
      try {
        let html = '', text = '', paras = [], words = 0, rendered = false;
        try {
          html = await get(c.link, 30000);
          ({ text, paras, words } = extractBody(html));
        } catch (e) {
          // 403 / 429 / 5xx 不等于这篇没长文，先用渲染版兜一次
          if (!/403|429|50\d/.test(String(e.message || ''))) throw e;
          log(`  ↻ ${c.source} 直抓 ${e.message}，改用渲染版`);
          rendered = true;
        }
        const host = hostOf(c.link);
        const official = /newsroom|nvidia|openai|anthropic|apple|microsoft|meta\.com|tesla|darioamodei|samaltman|x\.ai|spacex/i.test(host);
        // X/推特帖子正文短（二手讨论帖多为几十~几百词），单独放宽到 120 词；
        // 2026-11-27 用户确认这类内容可接受。其余维持原门槛。
        const isSocial = /^(x\.com|twitter\.com)$/i.test(host);
        const minOk = c.forced ? 80 : (isSocial ? 120 : (official ? Math.min(350, minWords) : minWords));
        const maxAge = c.forced ? 365 * 24 : (official ? Math.min(14 * 24, maxAgeH) : maxAgeH);
        if (rendered || words < minOk) {
          const md = await firecrawlMarkdown(c.link);
          const p2 = md ? mdToParas(md) : [];
          const w2 = (p2.join(' ').match(/\b[A-Za-z][A-Za-z'-]*\b/g) || []).length;
          if (w2 >= minOk) {
            log(`  ↑ ${c.source} ${rendered ? '直抓被拦' : '静态抓取只有 ' + words + ' 词'}，渲染后 ${w2} 词`);
            // 渲染页常常没有 meta 时间，退回正文里那句 "November 8, 2026"
            const mdDate = md.match(/([A-Z][a-z]{2,8}\s+\d{1,2},\s+20\d{2})/);
            const ts2 = pageDate(html) || (mdDate ? Date.parse(mdDate[1]) : (c.viaSearch ? 0 : c.ts));
            if (!c.forced && !c.isLetter && ts2 > 0 && (Date.now() - ts2) / 3600e3 > maxAge) {
              log(`  - 跳过 ${c.source}｜渲染页日期 ${new Date(ts2).toISOString().slice(0, 10)}，超出 ${maxAgeH} 小时`);
              continue;
            }
            let title = c.title;
            if (!title) {
              const h1 = (md.match(/^#\s+(.+)$/m) || [])[1];
              title = h1 ? h1.trim() : c.link;
            }
            const got = { ...c, title, text: p2.join('\n'), paras: p2, words: w2, ts: ts2 || c.ts, minutes: Math.max(3, Math.round(w2 / 230)) };
            log(`  ✓ 选中 ${c.source}｜${w2} 词｜约 ${got.minutes} 分钟：${got.title}`);
            return got;
          }
          if (!rendered) log(`  - 跳过 ${c.source}｜${words} 词（渲染后 ${w2} 词），不足 ${minOk}`);
          continue;
        }
        const realTs = pageDate(html);
        const real = realTs || (c.viaSearch ? 0 : c.ts);
        if (!c.forced && !c.isLetter && real > 0 && (Date.now() - real) / 3600e3 > maxAge) {
          log(`  - 跳过 ${c.source}｜正文日期 ${new Date(real).toISOString().slice(0, 10)}，超出 ${maxAgeH} 小时`);
          continue;
        }
        let title = c.title;
        if (!title) {
          // og:title 优先；<title> 常带「 | 站点名」后缀，只在去掉后缀仍够长时才用
          const og = html.match(/property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
          const tg = html.match(/<title[^>]*>([^<]+)<\/title>/i);
          let raw = (og ? og[1] : (tg ? tg[1] : '')).trim();
          const cut = raw.replace(/\s*[|｜]\s*.*$/, '').trim();
          title = cut.length >= 8 ? cut : raw;
          if (!title) {
            const md3 = await firecrawlMarkdown(c.link);
            const h1 = (md3.match(/^#\s+(.+)$/m) || [])[1];
            title = h1 ? h1.trim() : c.link;
          }
        }
        const got = { ...c, title, text, paras, words, ts: real, minutes: Math.max(3, Math.round(words / 230)) };
        log(`  ✓ 选中 ${c.source}｜${words} 词｜约 ${got.minutes} 分钟：${got.title}`);
        return got;
      } catch (e) {
        log(`  - ${c.source} 抓取失败：${e.message}`);
      }
    }
    return null;
  };

  let chosen = await pickFrom(candidates, MIN_WORDS, MAX_AGE_H);
  if (!chosen) {
    log('  ↻ 常规门槛无果，放宽到 7 天 / 450 词再选一次');
    chosen = await pickFrom(candidates, 450, 7 * 24);
  }
  if (!chosen) throw new Error('候选全部抓不到正文或篇幅不足（常规 + 放宽两轮均失败）');

  // 导读与精读：拿到就完整写入，拿不到就如实标记，不假装有
  let meta = {};
  let ok = false;
  try {
    meta = await analyze(chosen);
    ok = true;
    log(`  导读 + 精读 OK：${meta.title_zh || '(无标题中译)'}｜${(meta.analysis?.outline || []).length} 段结构｜${(meta.analysis?.vocab || []).length} 个词`);
  } catch (e) {
    log(`  ⚠️ 导读生成失败（${e.message}）：本期只发原文信息，站点会隐藏精读区`);
  }

  const bodyParas = chosen.paras || [];
  const trans = Array.isArray(meta.translation) ? meta.translation.slice(0, bodyParas.length) : [];

  const post = {
    date,
    title: chosen.title,
    title_zh: meta.title_zh || '',
    author: meta.author || '',
    source: chosen.source,
    link: chosen.link,
    words: chosen.words,
    minutes: chosen.minutes,
    published: chosen.ts ? new Date(chosen.ts).toISOString() : '',
    genre: meta.genre || '',
    cefr: meta.cefr || '',
    themes: Array.isArray(meta.themes) ? meta.themes.slice(0, 4) : [],
    tldr: meta.tldr || '',
    excerpt: chosen.excerpt,
    snippet: (bodyParas[1] || bodyParas[0] || '').slice(0, 220),
    digest: meta.digest || '',
    points: Array.isArray(meta.points) ? meta.points.slice(0, 3) : [],
    body: bodyParas,
    translation: trans,
    analysis: meta.analysis || null,
    analysis_version: 2,
    no_analysis: !ok,
    generated_at: new Date().toISOString(),
  };

  if (DRY) { log(`DRY_RUN：${post.title}`); log(JSON.stringify(meta).slice(0, 300)); return; }

  mkdirSync(POSTS, { recursive: true });
  writeFileSync(join(POSTS, `${date}.json`), JSON.stringify(post, null, 2) + '\n');
  history.add(chosen.link);
  writeFileSync(HIST, JSON.stringify([...history].slice(-2000), null, 2) + '\n');
  const n = rebuildIndex();
  log(`完成：data/posts/${date}.json（索引共 ${n} 期）`);
}

main().catch(e => { console.error(e); process.exit(1); });
