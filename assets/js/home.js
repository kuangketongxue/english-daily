/* ═══════════════════════════════════════════════════════════
   资料库首页：文章 / 书籍 / 剧集 / 电影 / 收藏
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const F = CR.fmt;
  const esc = CR.esc;
  const $ = function (s, r) { return (r || document).querySelector(s); };
  const $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  const KIND = {
    articles: { title: '文章', sub: '每天一篇值得读完的英文长文' },
    books: { title: '书籍', sub: '英文原版书，按章节推进' },
    series: { title: '剧集', sub: '用剧集练听力与口语' },
    films: { title: '电影', sub: '值得逐句看的片子' },
    favs: { title: '收藏', sub: '你标记过的全部内容' },
  };

  let data = { issues: [], books: [], series: [], films: [] };
  let kind = 'articles';
  let sort = 'date';

  /* ── 数据归一 ───────────────────────────────────────── */
  function pool(k) {
    if (k === 'articles') return data.issues || [];
    if (k === 'favs') {
      return (data.issues || []).filter(function (it) { return CR.isFav(it.date); });
    }
    return data[k] || [];
  }

  function sorted(list) {
    const out = list.slice();
    if (sort === 'score') {
      out.sort(function (a, b) { return (CR.ratingOf(b.date) - CR.ratingOf(a.date)) || b.date.localeCompare(a.date); });
    } else if (sort === 'length') {
      out.sort(function (a, b) { return (a.minutes || 999) - (b.minutes || 999); });
    } else {
      out.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    }
    return out;
  }

  /* ── 状态 ───────────────────────────────────────────── */
  function statusOf(it) {
    const p = CR.progressOf(it.date);
    if (p >= 0.97) return { cls: 'chip--done', label: '已读', icon: 'done' };
    if (p > 0.02) return { cls: 'chip--reading', label: '阅读中 ' + Math.round(p * 100) + '%', icon: 'eye' };
    return { cls: '', label: '待阅读', icon: 'eye' };
  }

  const IC = {
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.4"/></svg>',
    done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17l9-10"/></svg>',
    go: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" style="width:26px;height:26px;color:var(--faint)"><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M10 4h8.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H10"/></svg>',
  };

  /* ── 继续阅读 ───────────────────────────────────────── */
  function renderContinue() {
    const box = $('#continue');
    const prog = CR.progressAll();
    let best = null;
    Object.keys(prog).forEach(function (d) {
      const p = prog[d];
      if (!p || !p.p || p.p >= 0.97 || p.p < 0.03) return;
      if (!best || p.at > best.at) best = { date: d, p: p.p, at: p.at };
    });
    if (!best) { box.hidden = true; return; }
    const it = data.issues.find(function (x) { return x.date === best.date; });
    if (!it) { box.hidden = true; return; }

    const pct = Math.round(best.p * 100);
    box.hidden = false;
    box.innerHTML = [
      '<a class="item__hit" href="read.html?d=' + it.date + '" aria-label="继续阅读：' + esc(it.title) + '"></a>',
      '<div class="cont__badge">继续阅读 · <b>' + pct + '%</b></div>',
      '<p class="cont__kick">上次读到 ' + F.dstr(it.date) + ' · ' + F.ago(new Date(best.at).toISOString()) + '</p>',
      '<h2>' + esc(it.title) + '</h2>',
      '<p>' + esc(it.snippet || it.digest || '') + '</p>',
      '<i class="cont__bar" style="width:' + pct + '%"></i>',
    ].join('');
  }

  /* ── 条目 ───────────────────────────────────────────── */
  function itemHTML(it) {
    const st = statusOf(it);
    const meta = [];
    if (it.date) meta.push('<span>' + F.dstr(it.date) + '</span>');
    if (it.source) meta.push('<span class="src">' + esc(it.source) + '</span>');
    if (it.author) meta.push('<span>' + esc(it.author) + '</span>');
    if (it.minutes) meta.push('<span>' + it.minutes + ' 分钟</span>');
    if (it.cefr) meta.push('<span>' + esc(it.cefr) + '</span>');
    if (it.words) meta.push('<span>' + it.words + ' 词</span>');

    const href = it.href || ('read.html?d=' + it.date);
    return [
      '<article class="item">',
      '  <a class="item__hit" href="' + href + '" aria-label="' + esc(it.title) + '"></a>',
      '  <div class="item__top">' + meta.join('<span class="dot"></span>') + '</div>',
      '  <h2 class="item__title">' + esc(it.title) + '</h2>',
      it.title_zh ? '  <p class="item__by">' + esc(it.title_zh) + '</p>' : '',
      '  <p class="item__sum">' + esc(it.digest || it.snippet || it.excerpt || it.note || '') + '</p>',
      '  <div class="item__foot">',
      '    <span class="chip ' + st.cls + '">' + IC[st.icon] + st.label + '</span>',
      '    ' + (kind === 'favs' || kind === 'articles' ? CR.starsHTML(it.date) : ''),
      '    <a class="item__go" href="' + href + '">阅读' + IC.go + '</a>',
      '  </div>',
      '</article>',
    ].join('\n');
  }

  function renderFeed() {
    const feed = $('#feed');
    const note = $('#feedNote');
    let list = sorted(pool(kind));

    if (kind === 'favs') note.textContent = '共 ' + list.length + ' 篇收藏';
    else if (kind === 'articles') note.textContent = '共 ' + list.length + ' 期';
    else note.textContent = '共 ' + list.length + ' 条';

    if (!list.length) {
      feed.innerHTML = '<div class="empty">' + IC.empty +
        '<h2>' + (kind === 'favs' ? '还没有收藏' : '这一类还没收录') + '</h2>' +
        '<p>' + (kind === 'favs'
          ? '在文章底部的「收藏」按钮上点一下，就会出现在这里。'
          : '目前每天只更新英文文章。书籍、剧集、电影的分册会在之后补上，现在这里是空的。') + '</p></div>';
      return;
    }

    feed.innerHTML = list.map(itemHTML).join('\n');
    CR.bindStars(feed);
  }

  /* ── 视图切换 ───────────────────────────────────────── */
  function setKind(k, push) {
    if (!KIND[k]) k = 'articles';
    kind = k;
    $$('.navitem[data-kind]').forEach(function (a) { a.classList.toggle('on', a.dataset.kind === k); });
    const n = pool(k).length;
    $('#pageSub').textContent = KIND[k].sub + (kind === 'favs' ? ' · ' + n + ' 篇' : kind === 'articles' ? ' · 共 ' + n + ' 期' : '');
    document.title = 'Curated Reads · ' + KIND[k].sub;
    if (push !== false && location.hash !== '#' + k) {
      history.replaceState(null, '', '#' + k);
    }
    $('#continue').hidden = true;
    if (k === 'articles' || k === 'favs' && pool('favs').length > 0) renderContinue();
    renderFeed();
    closeSide();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function counts() {
    $('#cntArticles').textContent = (data.issues || []).length;
    $('#cntFavs').textContent = CR.favs().length;
  }

  /* ── 排序 ───────────────────────────────────────────── */
  function wireSort() {
    const btn = $('#sortBtn');
    const pop = $('#sortPop');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      pop.hidden = !pop.hidden;
      btn.setAttribute('aria-expanded', String(!pop.hidden));
    });
    document.addEventListener('click', function () {
      if (!pop.hidden) { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    });
    $$('#sortPop button').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        sort = b.dataset.sort;
        $$('#sortPop button').forEach(function (x) { x.classList.toggle('on', x === b); });
        $('#sortLabel').textContent = b.textContent.replace('优先', '').replace('由短到长', '').trim() || '最新';
        pop.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        renderFeed();
      });
    });
  }

  /* ── 侧栏 ───────────────────────────────────────────── */
  function closeSide() {
    $('#side').classList.remove('on');
    $('#sideScrim').classList.remove('on');
  }
  function wireSide() {
    $$('.navitem[data-kind]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        setKind(a.dataset.kind);
      });
    });
    $('#menuBtn').addEventListener('click', function () {
      $('#side').classList.add('on');
      $('#sideScrim').classList.add('on');
    });
    $('#sideScrim').addEventListener('click', closeSide);

    const collapsed = CR.get('cr.side.collapsed', false);
    if (collapsed) document.body.dataset.collapsed = '1';
    function syncCollapseBtn() {
      const collapsed = document.body.dataset.collapsed === '1';
      const btn = $('#collapseBtn');
      if (!btn) return;
      btn.setAttribute('aria-label', collapsed ? '展开侧栏' : '收起侧栏');
      btn.setAttribute('title', collapsed ? '展开侧栏' : '收起侧栏');
      btn.style.transform = collapsed ? 'rotate(180deg)' : '';
    }
    syncCollapseBtn();
    $('#collapseBtn').addEventListener('click', function () {
      const on = document.body.dataset.collapsed !== '1';
      if (on) document.body.dataset.collapsed = '1';
      else delete document.body.dataset.collapsed;
      CR.set('cr.side.collapsed', on);
      syncCollapseBtn();
    });
  }

  /* ── 启动 ───────────────────────────────────────────── */
  async function main() {
    CR.wireChrome();
    wireSort();
    wireSide();

    try {
      data = await CR.loadIndex();
    } catch (e) {
      $('#feed').innerHTML = '<div class="empty"><h2>索引没读到</h2><p>' + esc(e.message) +
        '　稍后刷新页面；如果一直这样，检查 data/index.json 是否已生成。</p></div>';
      return;
    }
    data.issues = data.issues || [];

    counts();
    const initial = (location.hash || '').replace('#', '') || 'articles';
    setKind(KIND[initial] ? initial : 'articles', false);

    window.addEventListener('hashchange', function () {
      const k = (location.hash || '').replace('#', '') || 'articles';
      if (k !== kind && KIND[k]) setKind(k, false);
    });

    document.addEventListener('cr:fav', function () { counts(); if (kind === 'favs') renderFeed(); });
    document.addEventListener('cr:rating', function () { if (sort === 'score') renderFeed(); });
    document.addEventListener('cr:synced', counts);
  }

  main();
})();
