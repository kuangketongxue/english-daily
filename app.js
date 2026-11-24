const $ = (s, r = document) => r.querySelector(s);
const KEY = 'cr:ratings:v1';
const FAV = 'cr:favs:v1';

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const ratings = load(KEY, {});
const favs = new Set(load(FAV, []));

const dstr = (d) => (d || '').replace(/-/g, '.');

function pubTime(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t)) return '';
  const p = (n) => String(n).padStart(2, '0');
  const bj = new Date(t.getTime() + 8 * 3600e3);
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
}

function ago(iso) {
  if (!iso) return '';
  const h = (Date.now() - new Date(iso).getTime()) / 3600e3;
  if (!isFinite(h) || h < 0) return '';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} 分钟前`;
  if (h < 48) return `${Math.round(h)} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

function starsHtml(date) {
  const n = ratings[date] || 0;
  return `<div class="stars" data-date="${date}">${[1, 2, 3, 4, 5]
    .map(i => `<i class="${i <= n ? 'on' : ''}" data-v="${i}">★</i>`).join('')}
    <em>${n ? `我评 ${n} 分` : '打分'}</em></div>`;
}

function bindStars(root) {
  root.querySelectorAll('.stars').forEach(box => {
    box.querySelectorAll('i').forEach(star => {
      star.addEventListener('click', (e) => {
        e.preventDefault();
        const date = box.dataset.date, v = Number(star.dataset.v);
        ratings[date] = ratings[date] === v ? 0 : v;
        save(KEY, ratings);
        box.querySelectorAll('i').forEach((s, i) => s.classList.toggle('on', i < ratings[date]));
        box.querySelector('em').textContent = ratings[date] ? `我评 ${ratings[date]} 分` : '打分';
      });
    });
  });
}

function heroCard(it) {
  const el = document.createElement('article');
  const when = pubTime(it.published);
  const body = (it.body || []).map(p => `<p>${p}</p>`).join('');
  el.innerHTML = `
    <div class="kick"><b>今日精选</b><span class="dot"></span><span>${dstr(it.date)}</span></div>
    <h2><a href="${it.link}" target="_blank" rel="noopener">${it.title}</a></h2>
    ${it.title_zh ? `<p class="zh">${it.title_zh}</p>` : ''}
    <div class="meta">
      ${it.source ? `<span class="tag src">${it.source}</span>` : ''}
      ${when ? `<span class="tag">发表于 ${when}</span>` : ''}
      ${ago(it.published) ? `<span class="tag">${ago(it.published)}</span>` : ''}
      ${it.minutes ? `<span class="tag">${it.minutes} 分钟读完</span>` : ''}
      ${it.words ? `<span class="tag">${it.words} 词</span>` : ''}
      ${it.difficulty ? `<span class="tag">${it.difficulty}</span>` : ''}
    </div>
    ${it.digest ? `<p class="digest">${it.digest}</p>` : `<p class="digest">${it.excerpt || ''}</p>`}
    ${it.points && it.points.length ? `<ul class="points">${it.points.map(p => `<li>${p}</li>`).join('')}</ul>` : ''}
    <div class="acts">
      ${starsHtml(it.date)}
      <button class="btn fav" data-date="${it.date}">${favs.has(it.date) ? '已收藏' : '收藏'}</button>
      <a class="btn" href="${it.link}" target="_blank" rel="noopener">看原站</a>
    </div>
    ${body ? `<div class="full" data-full>
      <h3>English original</h3>
      <div class="body">${body}<div class="fade"></div></div>
      <button class="more">展开全文 ↓</button>
    </div>` : ''}
  `;
  bindStars(el);

  const fav = el.querySelector('.fav');
  fav.addEventListener('click', () => {
    const d = fav.dataset.date;
    favs.has(d) ? favs.delete(d) : favs.add(d);
    save(FAV, [...favs]);
    fav.textContent = favs.has(d) ? '已收藏' : '收藏';
    fav.classList.toggle('on', favs.has(d));
  });

  const full = el.querySelector('[data-full]');
  if (full) {
    full.querySelector('.more').addEventListener('click', (e) => {
      full.classList.toggle('open');
      e.target.textContent = full.classList.contains('open') ? '收起 ↑' : '展开全文 ↓';
    });
  }
  return el;
}

function row(it) {
  const a = document.createElement('a');
  a.className = 'row';
  a.href = it.link;
  a.target = '_blank';
  a.rel = 'noopener';
  const when = pubTime(it.published);
  const n = ratings[it.date] || 0;
  a.innerHTML = `
    <div class="d">${dstr(it.date)}</div>
    <p class="en">${it.title}</p>
    ${it.title_zh ? `<p class="cn">${it.title_zh}</p>` : ''}
    <div class="m">
      <span>${it.source || ''}</span>
      ${when ? `<span>发表于 ${when}</span>` : ''}
      ${it.minutes ? `<span>${it.minutes} 分钟</span>` : ''}
      ${n ? `<span class="s">${'★'.repeat(n)}</span>` : ''}
    </div>
  `;
  return a;
}

async function main() {
  const now = new Date();
  $('#today').textContent = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

  let issues = [];
  try {
    const r = await fetch('data/index.json?t=' + Date.now());
    issues = (await r.json()).issues || [];
  } catch {}

  if (!issues.length) { $('#empty').hidden = false; return; }

  const hero = $('#hero');
  hero.hidden = false;
  hero.appendChild(heroCard(issues[0]));

  const rest = issues.slice(1);
  const list = $('#list');

  function paint(sortBy) {
    list.innerHTML = '';
    const items = [...rest];
    if (sortBy === 'score') items.sort((a, b) => (ratings[b.date] || 0) - (ratings[a.date] || 0));
    if (!items.length) { list.innerHTML = '<p class="empty">还没有往期，明天开始这里会有历史。</p>'; return; }
    items.forEach(it => list.appendChild(row(it)));
  }
  paint('date');

  document.querySelectorAll('.sort .chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sort .chip').forEach(b => b.classList.toggle('on', b === btn));
      paint(btn.dataset.sort);
    });
  });
}

main();
