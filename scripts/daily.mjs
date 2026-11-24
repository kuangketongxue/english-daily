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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const POSTS = join(DATA, 'posts');
const HIST = join(DATA, 'history.json');
const SRC = join(ROOT, 'scripts', 'sources.json');

const AI_KEY = process.env.AI_API_KEY || '';
const AI_BASE = (process.env.AI_BASE_URL || '').replace(/\/+$/, '');
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

function extractBody(html) {
  const art = html.match(/<article[\s\S]*?<\/article>/i);
  let block = art ? art[0] : html.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ');
  const paras = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map(m => strip(m[1])).filter(p => p.length > 60);
  const text = paras.join('\n');
  return { text, words: (text.match(/\b[A-Za-z][A-Za-z'-]*\b/g) || []).length };
}

async function ask(prompt) {
  const messages = [
    { role: 'system', content: '你是一位中文科技与思想类编辑，把英文长文浓缩成中文导读。只输出 JSON，不要代码块、不要解释。' },
    { role: 'user', content: prompt },
  ];
  if (AI_KEY && AI_BASE) {
    const r = await fetch(`${AI_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_KEY}` },
      body: JSON.stringify({ model: AI_MODEL, messages, temperature: 0.4 }),
    });
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  }
  // 无自备 key：用 GitHub Models（需 workflow 里 permissions: models: read）
  const r = await fetch('https://models.github.ai/inference/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({ model: 'openai/gpt-4o-mini', messages, temperature: 0.4 }),
  });
  if (!r.ok) throw new Error(`models ${r.status}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
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
      digest: p.digest, points: p.points || [], difficulty: p.difficulty || '',
    }));
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, 'index.json'), JSON.stringify({ updated: today(), issues }, null, 2) + '\n');
  return issues.length;
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
  const candidates = (await gather())
    .filter(x => !history.has(x.link))
    .filter(x => englishRatio(x.title) > 0.6)
    .filter(x => now - x.ts <= MAX_AGE_H * 3600e3)
    .sort((a, b) => (b.weight - a.weight) || (b.ts - a.ts))
    .slice(0, 14);
  log(`候选 ${candidates.length} 篇（72 小时内、未写过）`);
  if (!candidates.length) throw new Error('没有可用候选：源站全部无新文或都已写过');

  let chosen = null;
  for (const c of candidates) {
    try {
      const html = await get(c.link, 30000);
      const { text, words } = extractBody(html);
      if (words < MIN_WORDS) { log(`  - 跳过 ${c.source}｜${words} 词，不足 ${MIN_WORDS}`); continue; }
      chosen = { ...c, text, words, minutes: Math.max(3, Math.round(words / 230)) };
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
