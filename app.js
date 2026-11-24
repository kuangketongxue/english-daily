const $ = (s, r = document) => r.querySelector(s);

const fmtDate = (d) => d.replace(/-/g, '.');

function metaLine(it) {
  const bits = [fmtDate(it.date), it.source];
  if (it.minutes) bits.push(`${it.minutes} 分钟`);
  if (it.difficulty) bits.push(it.difficulty);
  return bits.filter(Boolean).join(' · ');
}

function heroCard(it) {
  const el = document.createElement('article');
  el.innerHTML = `
    <div class="kicker">
      <span>今日精选</span><span class="dot"></span>
      <span>${metaLine(it)}</span>
    </div>
    <h2><a href="${it.link}" target="_blank" rel="noopener">${it.title}</a></h2>
    ${it.title_zh ? `<p class="zh">${it.title_zh}</p>` : ''}
    ${it.digest ? `<p class="digest">${it.digest}</p>` : `<p class="digest">${it.excerpt || ''}</p>`}
    ${it.points && it.points.length ? `<ul class="points">${it.points.map(p => `<li>${p}</li>`).join('')}</ul>` : ''}
    <a class="go" href="${it.link}" target="_blank" rel="noopener">阅读原文 →</a>
  `;
  return el;
}

function row(it) {
  const a = document.createElement('a');
  a.className = 'row';
  a.href = it.link;
  a.target = '_blank';
  a.rel = 'noopener';
  a.innerHTML = `
    <div class="date">${fmtDate(it.date)}</div>
    <p class="en">${it.title}</p>
    ${it.title_zh ? `<p class="cn">${it.title_zh}</p>` : ''}
    <div class="meta">${[it.source, it.minutes ? it.minutes + ' 分钟' : ''].filter(Boolean).join(' · ')}</div>
  `;
  return a;
}

async function main() {
  $('#today').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });

  let issues = [];
  try {
    const r = await fetch('data/index.json?t=' + Date.now());
    issues = (await r.json()).issues || [];
  } catch (e) { /* 首日没有索引时走下面的空态 */ }

  if (!issues.length) {
    $('#empty').hidden = false;
    return;
  }

  const hero = $('#hero');
  hero.hidden = false;
  hero.appendChild(heroCard(issues[0]));

  const rest = issues.slice(1);
  const list = $('#list');

  function paint(n) {
    list.innerHTML = '';
    const items = n ? rest.slice(0, n) : rest;
    if (!items.length) {
      list.innerHTML = '<p class="empty">还没有往期。明天开始这里会有历史。</p>';
      return;
    }
    items.forEach(it => list.appendChild(row(it)));
  }
  paint(0);

  document.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.chip').forEach(b => b.classList.toggle('on', b === btn));
      paint(btn.dataset.filter === 'week' ? 7 : 0);
    });
  });
}

main();
