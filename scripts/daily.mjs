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
// 域名与体裁：官方 newsroom 最高分，主流媒体次之，UGC 与“范本/教程”类直接降权或丢弃
const DOMAIN_BOOST = [
  [/(nvidianews\.nvidia\.com|blogs\.nvidia\.com|openai\.com|anthropic\.com|blog\.google|apple\.com|microsoft\.com|about\.fb\.com|meta\.com|tesla\.com|amazon\.com|stripe\.com|shopify\.com)$/i, 70],
  [/(nytimes|bloomberg|wsj\.com|ft\.com|reuters|apnews|theverge|techcrunch|wired|economist|newyorker|theatlantic|axios|cnbc|fortune|businessinsider|economictimes|livemint|scmp|nikkei|theinformation)/i, 30],
  [/(medium\.com|substack\.com|linkedin\.com|reddit\.com|quora|facebook\.com|x\.com|twitter\.com|youtube\.com)/i, -30],
];
const LISTICLE = /\b(examples?|templates?|sample letters?|how to write|best \d+|top \d+|a guide to writing|tips for)\b/i;
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

const HOT = [
  [/\b(resign|resignation|steps down|ousted)\b/i, 26],
  [/\b(apolog|apology|sorry|open letter|letter to)\b/i, 26],
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
    { role: 'system', content: '你是一位中文科技与思想类编辑，把英文长文浓缩成中文导读。只输出 JSON，不要代码块、不要解释。' },
    { role: 'user', content: prompt },
  ];
  if (AI_KEY && AI_BASE) {
    const r = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, messages, temperature: 0.4 }),
    });
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  }
  // GitHub Models 已于 2026-07-30 全面下线，不能再用 github.token 兜底。
  // 没有自备 key 时明确报错，让上层降级为「只发原文信息」，不要静默产出半成品。
  throw new Error('未配置 AI_API_KEY / AI_BASE_URL（GitHub Models 已下线）');
}

function parseJSONLoose(s) {
  const t = s.replace(/^```(?:json)?/m, '').replace(/```$/m, '').trim();
  const i = t.indexOf('{'), k = t.lastIndexOf('}');
  if (i < 0 || k < i) throw new Error('模型没有返回 JSON');
  return JSON.parse(t.slice(i, k + 1));
}

function rebuildIndex() {
  const issues = (existsSync(POSTS) ? readdirSync(POSTS).filter(f => f.endsWith('.json')) : [])
    .map(f => { try { return JSON.parse(readFileSync(join(POSTS, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(p => ({
      date: p.date, title: p.title, title_zh: p.title_zh, source: p.source,
      link: p.link, minutes: p.minutes, words: p.words, excerpt: p.excerpt,
      published: p.published || '',
      body: p.body || [],
      digest: p.digest, points: p.points || [], difficulty: p.difficulty || '',
    }));
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, 'index.json'), JSON.stringify({ updated: today(), issues }, null, 2) + '\n');
  return issues.length;
}


// ── 全网搜索（parallel-search skill 内置，Exa/Tavily/Firecrawl/元宝 多源并行）──
// 媒体 RSS 拿不到「公司自己发的信」，这类东西只在 newsroom 和全网索引里。
// 所以每天先用几条热点 query 去搜，搜到的页面与 RSS 候选一起排序，热点稿天然靠前。
const HOT_QUERIES = [
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
            excerpt: r.description || r.snippet || r.text || '', ts: 0, viaSearch: true,
          })).filter(x => x.link && x.title));
        } catch (e) { resolve([]); }
      });
  });
}

async function gatherWeb() {
  const lists = await Promise.all(HOT_QUERIES.map(psSearch));
  const seen = new Set();
  const out = [];
  for (const list of lists) for (const x of list) {
    if (seen.has(x.link)) continue;
    seen.add(x.link);
    // 搜索结果的标题多是中文站转载，只留英文标题的页面
    if (englishRatio(x.title) < 0.5) continue;
    if (LISTICLE.test(x.title)) continue;   // 范本/教程/清单类不是新闻
    out.push(x);
  }
  log(`  全网搜索补充 ${out.length} 条（英文标题）`);
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
  const date = DRY ? today() : pickTarget();
  if (!date) { log(`今日 ${today()} 已有文章，近 3 天无缺期，跳过`); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期不合法：${date}`);
  log(`开始选品 ${date} …`);

  const history = new Set(existsSync(HIST) ? JSON.parse(readFileSync(HIST, 'utf8')) : []);
  const now = Date.now();
  globalThis.__bias = sourceBias();
  if (Object.keys(globalThis.__bias).length) log('  个性化权重：' + Object.entries(globalThis.__bias).map(([k, v]) => `${k}×${v.toFixed(2)}`).join(' / '));
  const [feedItems, webItems] = await Promise.all([gather(), gatherWeb()]);
  const candidates = [...webItems, ...feedItems]
    .filter(x => !history.has(x.link))
    .filter(x => englishRatio(x.title) > 0.6)
    .filter(x => now - x.ts <= MAX_AGE_H * 3600e3)
    .map(x => ({ ...x, heat: hotScore(x) }))
    .sort((a, b) => (b.heat - a.heat) || (b.weight - a.weight) || (b.ts - a.ts))
    .slice(0, 14);
  log(`候选 ${candidates.length} 篇（72 小时内、未写过）`);
  if (!candidates.length) throw new Error('没有可用候选：源站全部无新文或都已写过');

  let chosen = null;
  for (const c of candidates) {
    try {
      const html = await get(c.link, 30000);
      const { text, paras, words } = extractBody(html);
      const official = /newsroom|nvidia|openai|anthropic|apple|microsoft|meta\.com|tesla/i.test(hostOf(c.link));
      const minOk = official ? 250 : MIN_WORDS;
      const maxAge = official ? 14 * 24 : MAX_AGE_H;   // 官方信件的价值在内容不在时效
      if (words < minOk) {
        const md = await firecrawlMarkdown(c.link);
        const p2 = md ? mdToParas(md) : [];
        const w2 = (p2.join(' ').match(/\b[A-Za-z][A-Za-z'-]*\b/g) || []).length;
        if (w2 >= minOk) {
          log(`  ↑ ${c.source} 静态抓取只有 ${words} 词，Firecrawl 渲染后 ${w2} 词`);
          // 渲染页常常没有 meta 时间，退回正文里那句 "November 8, 2026"
          const mdDate = md.match(/([A-Z][a-z]{2,8}\s+\d{1,2},\s+20\d{2})/);
          const ts2 = pageDate(html) || (mdDate ? Date.parse(mdDate[1]) : (c.viaSearch ? 0 : c.ts));
          if (ts2 > 0 && (Date.now() - ts2) / 3600e3 > maxAge) {
            log(`  - 跳过 ${c.source}｜渲染页日期 ${new Date(ts2).toISOString().slice(0, 10)}，超出 ${MAX_AGE_H} 小时`);
            continue;
          }
          chosen = { ...c, text: p2.join('\n'), paras: p2, words: w2, ts: ts2 || c.ts, minutes: Math.max(3, Math.round(w2 / 230)) };
          log(`  ✓ 选中 ${c.source}｜${w2} 词｜约 ${chosen.minutes} 分钟：${c.title}`);
          break;
        }
        log(`  - 跳过 ${c.source}｜${words} 词（渲染后 ${w2} 词），不足 ${minOk}`);
        continue;
      }
      const realTs = pageDate(html);
      const real = realTs || (c.viaSearch ? 0 : c.ts);
      if (real > 0 && (Date.now() - real) / 3600e3 > maxAge) {
        log(`  - 跳过 ${c.source}｜正文日期 ${new Date(real).toISOString().slice(0, 10)}，超出 ${MAX_AGE_H} 小时`);
        continue;
      }
      chosen = { ...c, text, paras, words, ts: real, minutes: Math.max(3, Math.round(words / 230)) };
      log(`  ✓ 选中 ${c.source}｜${words} 词｜约 ${chosen.minutes} 分钟：${c.title}`);
      break;
    } catch (e) {
      log(`  - ${c.source} 抓取失败：${e.message}`);
    }
  }
  if (!chosen) throw new Error('候选全部抓不到正文或篇幅不足');

  let meta = { title_zh: '', digest: '', points: [], difficulty: '' };
  try {
    const body = chosen.text.slice(0, 12000);
    const out = await ask(`文章标题：${chosen.title}\n来源：${chosen.source}\n正文（可能被截断）：\n${body}\n\n请输出 JSON：\n{"title_zh":"标题的准确中译","digest":"150~220 字中文导读，讲清这篇在说什么、为什么值得读，不要复述标题","points":["要点1","要点2","要点3"],"difficulty":"四级 / 六级 / 雅思托福 / 母语者"}`);
    meta = { ...meta, ...parseJSONLoose(out) };
    log(`  中文导读 OK：${meta.title_zh || '(无标题中译)'}`);
  } catch (e) {
    log(`  ⚠️ 模型没写成中文导读（${e.message}），本日只发原文信息`);
  }

  const post = {
    date,
    title: chosen.title,
    title_zh: meta.title_zh || '',
    source: chosen.source,
    link: chosen.link,
    words: chosen.words,
    minutes: chosen.minutes,
    excerpt: chosen.excerpt,
    body: chosen.paras,
    published: chosen.ts ? new Date(chosen.ts).toISOString() : '',
    digest: meta.digest || '',
    points: Array.isArray(meta.points) ? meta.points.slice(0, 5) : [],
    difficulty: meta.difficulty || '',
    no_digest: !meta.digest,
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
