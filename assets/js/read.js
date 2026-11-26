/* ═══════════════════════════════════════════════════════════
   阅读页
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const F = CR.fmt;
  const esc = CR.esc;
  const $ = function (s, r) { return (r || document).querySelector(s); };
  const $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  const date = new URLSearchParams(location.search).get('d');
  let issues = [];
  let post = null;
  let lockProgressUntil = 0;

  /* ── 版式偏好 ───────────────────────────────────────── */
  const LEAD = [1.72, 1.92, 2.12];
  const MEASURE = ['31em', '35em', '41em'];

  function applyPrefs() {
    const p = CR.prefs;
    const r = document.documentElement.style;
    r.setProperty('--rd-size', (19.5 * (p.size || 100) / 100).toFixed(2) + 'px');
    r.setProperty('--rd-lead', String(LEAD[p.lead] || LEAD[1]));
    r.setProperty('--rd-measure', MEASURE[p.measure] || MEASURE[1]);
    r.setProperty('--rd-font', p.font === 'sans' ? 'var(--font-ui)' : 'var(--font-latin)');

    const seg = function (id, val, attr) {
      $$(id + ' button').forEach(function (b) {
        b.classList.toggle('on', String(b.dataset[attr]) === String(val));
      });
    };
    seg('#leadSeg', p.lead, 'lead');
    seg('#measureSeg', p.measure, 'measure');
    seg('#fontSeg', p.font, 'font');
    seg('#transSeg', p.trans ? 1 : 0, 'trans');
    seg('#themeSeg', CR.theme(), 'themeSet');
  }

  function wirePrefs() {
    $$('[data-size]').forEach(function (b) {
      b.addEventListener('click', function () {
        const v = (CR.prefs.size || 100) + Number(b.dataset.size) * 6;
        CR.prefs.size = Math.max(82, Math.min(136, v));
        CR.savePrefs();
        applyPrefs();
      });
    });
    $$('#leadSeg button').forEach(function (b) {
      b.addEventListener('click', function () { CR.prefs.lead = Number(b.dataset.lead); CR.savePrefs(); applyPrefs(); });
    });
    $$('#measureSeg button').forEach(function (b) {
      b.addEventListener('click', function () { CR.prefs.measure = Number(b.dataset.measure); CR.savePrefs(); applyPrefs(); });
    });
    $$('#fontSeg button').forEach(function (b) {
      b.addEventListener('click', function () { CR.prefs.font = b.dataset.font; CR.savePrefs(); applyPrefs(); });
    });
    $$('#transSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        CR.prefs.trans = b.dataset.trans === '1';
        CR.savePrefs();
        applyPrefs();
        renderText();
      });
    });
    $$('#themeSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        CR.applyTheme(b.dataset.themeSet);
        applyPrefs();
      });
    });
  }

  /* ── 正文渲染（含逐段中文） ─────────────────────────── */
  function renderText() {
    const box = $('#text');
    if (!box || !post) return;
    const body = post.body || [];
    const tr = post.translation || [];
    box.innerHTML = body.map(function (p, i) {
      let h = '<p id="p' + (i + 1) + '">' + esc(p) + '</p>';
      if (CR.prefs.trans && tr[i]) h += '<p class="zh">' + esc(tr[i]) + '</p>';
      return h;
    }).join('');
    // 首词是全大写缩写（NVIDIA / AI）时不做首字母下沉，否则会切出 "VIDIA"
    const firstP = box.querySelector('p');
    const firstWord = firstP ? (firstP.textContent || '').trim().split(/\s+/)[0] : '';
    box.classList.toggle('nocap', /^[A-Z]{2,}/.test(firstWord));
    observeParas();
  }

  /* ── 目录与激活态 ───────────────────────────────────── */
  function buildTOC() {
    const a = post.analysis || {};
    const items = [];
    items.push({ id: 'brief', t: '中文导读' });
    items.push({ id: 'text', t: '英文原文' });
    (a.outline || []).forEach(function (o) {
      if (o.at) items.push({ id: 'p' + o.at, t: o.h || (a.label || ''), sub: true, jump: true });
    });
    if (hasStudy()) items.push({ id: 'study', t: 'AI 精读' });

    $('#toc').innerHTML = items.map(function (it) {
      return '<li class="' + (it.sub ? 'sub' : '') + '"><a href="#' + it.id + '" data-target="' + it.id + '">' + esc(it.t) + '</a></li>';
    }).join('');

    $$('#toc a').forEach(function (link) {
      link.addEventListener('click', function (e) {
        e.preventDefault();
        const el = document.getElementById(link.dataset.target);
        if (!el) return;
        const y = el.getBoundingClientRect().top + window.scrollY - 78;
        window.scrollTo({ top: y, behavior: 'smooth' });
        if (window.innerWidth <= 900) closeRail();
      });
    });
  }

  let io = null;
  function observeParas() {
    if (io) io.disconnect();
    const targets = ['brief', 'text', 'study'].map(function (id) { return document.getElementById(id); }).filter(Boolean);
    // TOC 子项（大纲锚点）也纳入观察，否则 01~07 永远不高亮
    $$('#toc a[data-target]').forEach(function (a) {
      const t = document.getElementById(a.dataset.target);
      if (t && targets.indexOf(t) === -1) targets.push(t);
    });
    if (!('IntersectionObserver' in window)) return;
    io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        const id = en.target.id;
        $$('#toc a').forEach(function (a) { a.classList.toggle('on', a.dataset.target === id); });
      });
    }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
    targets.forEach(function (t) { io.observe(t); });
  }

  /* ── 精读 ───────────────────────────────────────────── */
  function hasStudy() {
    const a = (post && post.analysis) || {};
    return !!(a.outline || a.sentences || a.vocab || a.patterns || a.questions);
  }

  function studyHTML() {
    const a = post.analysis || {};
    const tabs = [];
    const panels = [];

    if (a.outline && a.outline.length) {
      tabs.push(['outline', '结构']);
      panels.push('<div class="panel" data-panel="outline"><ul class="outline">' +
        a.outline.map(function (o, i) {
          return '<li><span class="no">' + F.pad2(i + 1) + '</span><div>' +
            '<h4>' + esc(o.h) + '</h4><p>' + esc(o.note) + '</p></div></li>';
        }).join('') + '</ul></div>');
    }
    if (a.sentences && a.sentences.length) {
      tabs.push(['sentences', '难句']);
      panels.push('<div class="panel" data-panel="sentences">' +
        a.sentences.map(function (s) {
          return '<div class="sent"><p class="sent__en">' + esc(s.en) + '</p>' +
            (s.zh ? '<p class="sent__zh">' + esc(s.zh) + '</p>' : '') +
            (s.gram ? '<p class="sent__gram">' + s.gram + '</p>' : '') + '</div>';
        }).join('') + '</div>');
    }
    if (a.vocab && a.vocab.length) {
      tabs.push(['vocab', '词汇']);
      panels.push('<div class="panel" data-panel="vocab"><div class="vocab">' +
        a.vocab.map(function (v) {
          return '<div class="vocab__item"><div><div class="vocab__w">' + esc(v.w) +
            (v.pos ? '<span class="vocab__pos">' + esc(v.pos) + '</span>' : '') + '</div>' +
            '<p class="vocab__zh">' + esc(v.zh) + '</p>' +
            (v.ex ? '<p class="vocab__ex">' + esc(v.ex) + '</p>' : '') + '</div>' +
            '<button class="vocab__say" data-say="' + esc(v.w) + '" aria-label="朗读 ' + esc(v.w) + '">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg></button></div>';
        }).join('') + '</div></div>');
    }
    if (a.patterns && a.patterns.length) {
      tabs.push(['patterns', '句式']);
      panels.push('<div class="panel" data-panel="patterns">' +
        a.patterns.map(function (p) {
          return '<div class="pattern"><p class="pattern__p">' + esc(p.pattern) + '</p>' +
            (p.zh ? '<p class="pattern__zh">' + esc(p.zh) + '</p>' : '') +
            (p.ex ? '<p class="pattern__ex">' + esc(p.ex) + '</p>' : '') + '</div>';
        }).join('') + '</div>');
    }
    if (a.questions && a.questions.length) {
      tabs.push(['questions', '提问']);
      panels.push('<div class="panel" data-panel="questions"><ul class="quests">' +
        a.questions.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul></div>');
    }

    if (!tabs.length) {
      // 无 AI 精读时给明确提示，而不是留一个空区块让读者以为加载失败
      return '<section class="study" id="study">' +
        '<div class="study__head"><h2>AI 精读<span>Study notes</span></h2></div>' +
        '<p class="study__empty">本期暂无 AI 精读（难句 / 词汇 / 句式 / 思辨）。中文导读与英文原文可正常阅读；精读由模型逐期生成，稍后补齐。</p>' +
        '</section>';
    }

    return [
      '<section class="study" id="study">',
      '  <div class="study__head"><h2>AI 精读<span>Study notes</span></h2>',
      '    <div class="tabs" role="tablist">' + tabs.map(function (t, i) {
        return '<button data-tab="' + t[0] + '" class="' + (i === 0 ? 'on' : '') + '">' + t[1] + '</button>';
      }).join('') + '</div>',
      '  </div>',
      panels.map(function (p, i) {
        return i === 0 ? p.replace('class="panel"', 'class="panel on"') : p;
      }).join(''),
      '</section>',
    ].join('\n');
  }

  function wireStudy() {
    $$('.tabs button').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.tabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
        $$('.panel').forEach(function (p) { p.classList.toggle('on', p.dataset.panel === b.dataset.tab); });
      });
    });
    $$('[data-say]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (!CR.say.supported) return CR.toast('这个浏览器不支持朗读');
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(b.dataset.say);
        u.lang = 'en-US';
        u.rate = 0.9;
        window.speechSynthesis.speak(u);
      });
    });
  }

  /* ── 文件头 ─────────────────────────────────────────── */
  function headHTML(it, no) {
    const meta = [];
    if (it.source) meta.push('<span>' + esc(it.source) + '</span>');
    if (it.published) meta.push('<span>原文 ' + F.pubTime(it.published).slice(0, 10) + '</span>');
    if (it.words) meta.push('<span>' + it.words + ' 词</span>');
    if (it.minutes) meta.push('<span>约 ' + it.minutes + ' 分钟</span>');
    if (it.cefr) meta.push('<span>' + esc(it.cefr) + '</span>');
    if (it.genre) meta.push('<span>' + esc(it.genre) + '</span>');

    return [
      '<div class="doc__head">',
      '  <div class="doc__kick"><span>No.' + no + '</span><span class="sl">/</span><span>' + F.dstr(it.date) + ' ' + F.weekday(it.date) + '</span>' +
        (it.author ? '<span class="sl">/</span><span>' + esc(it.author) + '</span>' : '') + '</div>',
      '  <h1>' + esc(it.title) + '</h1>',
      it.title_zh ? '  <p class="doc__zh">' + esc(it.title_zh) + '</p>' : '',
      '  <div class="doc__meta">' + meta.join('') + (it.link ? '<a href="' + esc(it.link) + '" target="_blank" rel="noopener">原站 ↗</a>' : '') + '</div>',
      '</div>',
    ].join('\n');
  }

  function briefHTML(it) {
    if (!it.digest && !(it.points || []).length) return '';
    return [
      '<section class="brief" id="brief">',
      '  <div class="brief__head"><span class="kicker">中文导读 · 不是原文</span><button id="briefToggle">收起</button></div>',
      it.digest ? '  <p>' + esc(it.digest) + '</p>' : '',
      (it.points || []).length ? '  <ul class="brief__points">' + it.points.map(function (p, i) {
        return '<li><span class="n">' + F.pad2(i + 1) + '</span><span>' + esc(p) + '</span></li>';
      }).join('') + '</ul>' : '',
      '</section>',
    ].join('\n');
  }

  function footHTML(it, no) {
    return [
      '<div class="doc__foot">',
      '  <div class="acts">',
      '    ' + CR.starsHTML(it.date),
      '    <button class="btn" data-fav>' + (CR.isFav(it.date) ? '已收藏' : '收藏') + '</button>',
      '  </div>',
      '  <p class="doc__src">原文出处：<a href="' + esc(it.link || '#') + '" target="_blank" rel="noopener">' + esc(it.source || '原站') + '</a>' +
        '。中文导读与精读由模型生成，只作理解辅助。</p>',
      '</div>',
    ].join('\n');
  }

  function pagerHTML() {
    const i = issues.findIndex(function (x) { return x.date === post.date; });
    const newer = i > 0 ? issues[i - 1] : null;
    const older = i >= 0 && i < issues.length - 1 ? issues[i + 1] : null;
    const mk = function (it, cls, label) {
      if (!it) return '<span class="' + cls + ' empty"></span>';
      return '<a class="' + cls + '" href="read.html?d=' + it.date + '"><span class="k">' + label + ' · ' + F.dstr(it.date) +
        '</span><span class="t">' + esc(it.title) + '</span></a>';
    };
    return '<nav class="pager">' + mk(older, 'prev', '上一期') + mk(newer, 'next', '下一期') + '</nav>';
  }

  /* ── 进度与朗读 ─────────────────────────────────────── */
  function wireProgress() {
    const bar = $('#bar');
    const rbar = $('#rbar');
    let raf = 0;
    const text = function () { return document.getElementById('text'); };

    function calc() {
      const el = text();
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const total = el.offsetHeight;
      const seen = Math.min(total, Math.max(0, window.innerHeight * 0.35 - rect.top + (window.innerHeight * 0.65)));
      return total ? Math.min(1, Math.max(0, seen / total)) : 0;
    }

    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = 0;
        const p = calc();
        if (bar) bar.style.width = (p * 100).toFixed(1) + '%';
        if (rbar) rbar.classList.toggle('stuck', window.scrollY > 110);
        save(p);
      });
    }

    let t = 0;
    function save(p) {
      const now = Date.now();
      if (now < lockProgressUntil || now - t < 500) return;
      t = now;
      if (p > 0.02) CR.setProgress(post.date, p);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('beforeunload', function () { CR.setProgress(post.date, calc()); });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) CR.setProgress(post.date, calc());
    });
    onScroll();

    const sp = $('#speakBtn');
    if (sp) {
      if (!CR.say.supported) { sp.hidden = true; }
      sp.addEventListener('click', function () {
        if (CR.say.on) { CR.say.stop(); return; }
        const paras = $$('.text > p').filter(function (p) { return !p.classList.contains('zh'); });
        if (!paras.length) return CR.toast('没有可朗读的正文');
        CR.say.play(paras);
      });
      document.addEventListener('cr:speak', function (e) {
        sp.classList.toggle('on', e.detail.on);
        sp.innerHTML = e.detail.on
          ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>';
      });
    }
  }

  /* ── 手动设置阅读进度 ───────────────────────────────── */
  function wireManualProgress() {
    const wrap = $('#manualProgress');
    const input = $('#progressVal');
    if (!wrap || !input || !post) return;
    input.value = String(Math.round(CR.progressOf(post.date) * 100));

    function apply(p, jump) {
      p = Math.max(0, Math.min(1, Number(p) || 0));
      CR.setProgress(post.date, p);
      lockProgressUntil = Date.now() + 1500;
      input.value = String(Math.round(p * 100));
      const bar = $('#bar');
      if (bar) bar.style.width = (p * 100).toFixed(1) + '%';
      if (jump && p < 1) {
        const el = document.getElementById('text');
        if (el) {
          const y = el.getBoundingClientRect().top + window.scrollY + el.offsetHeight * p - window.innerHeight * 0.35;
          window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
        }
      }
      CR.toast('阅读进度已设为 ' + Math.round(p * 100) + '%', 1400);
    }

    wrap.addEventListener('click', function (e) {
      const b = e.target.closest('button[data-progress]');
      if (!b) return;
      const act = b.getAttribute('data-progress');
      if (act === 'done') apply(1, false);
      else if (act === 'set') apply((Number(input.value) || 0) / 100, true);
      else apply(CR.progressOf(post.date) + Number(act) / 100, true);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); apply((Number(input.value) || 0) / 100, true); }
    });
  }

  /* ── 侧栏（移动端） ─────────────────────────────────── */
  function closeRail() {
    $('#rail').classList.remove('on');
    $('#railScrim').classList.remove('on');
  }
  function wireRail() {
    $('#openRail').addEventListener('click', function () {
      $('#rail').classList.add('on');
      $('#railScrim').classList.add('on');
    });
    $('#railScrim').addEventListener('click', closeRail);
  }

  /* ── 键盘 ───────────────────────────────────────────── */
  function wireKeys() {
    document.addEventListener('keydown', function (e) {
      if (e.target.matches('input, textarea')) return;
      const i = issues.findIndex(function (x) { return x.date === post.date; });
      if (e.key === 'ArrowLeft' && i < issues.length - 1) location.href = 'read.html?d=' + issues[i + 1].date;
      if (e.key === 'ArrowRight' && i > 0) location.href = 'read.html?d=' + issues[i - 1].date;
      if (e.key === 't') { CR.toggleTheme(); applyPrefs(); }
      if (e.key === '+' || e.key === '=') { CR.prefs.size = Math.min(136, (CR.prefs.size || 100) + 6); CR.savePrefs(); applyPrefs(); }
      if (e.key === '-') { CR.prefs.size = Math.max(82, (CR.prefs.size || 100) - 6); CR.savePrefs(); applyPrefs(); }
      if (e.key === 'Escape') closeRail();
    });
  }

  /* ── 启动 ───────────────────────────────────────────── */
  async function main() {
    CR.wireChrome();
    applyPrefs();
    wirePrefs();
    wireRail();
    wireKeys();

    try {
      issues = ((await CR.loadIndex()).issues || []).slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
    } catch (e) {
      issues = [];
    }

    const d = date || (issues[0] && issues[0].date);
    if (!d) {
      $('#doc').innerHTML = '<div class="doc__head"><p class="kicker">还没有内容</p><h1>第一期还在路上</h1></div>';
      document.body.classList.add('no-post');
      return;
    }

    try {
      post = await CR.loadPost(d);
    } catch (e) {
      const fallback = issues.find(function (x) { return x.date === d; });
      if (!fallback) {
        $('#doc').innerHTML = '<div class="doc__head"><p class="kicker">读不到这一期</p><h1>页面不存在</h1>' +
          '<p class="doc__zh">' + esc(e.message) + '　<a class="btn btn--ghost" href="./">回首页</a></p></div>';
        document.body.classList.add('no-post');
        return;
      }
      post = fallback;
    }

    const no = F.issueNo(issues.length - issues.findIndex(function (x) { return x.date === post.date; }));
    document.title = post.title + ' · Curated Reads';

    const doc = $('#doc');
    doc.innerHTML = [
      headHTML(post, no),
      briefHTML(post),
      '<div class="text" id="text"></div>',
      studyHTML(),
      footHTML(post, no),
      pagerHTML(),
    ].join('\n');

    renderText();
    wireStudy();
    buildTOC();
    wireProgress();
    wireManualProgress();

    $('#railNo').textContent = 'No.' + no;
    $('#railDate').textContent = F.dstr(post.date);
    $('#railStars').innerHTML = CR.starsHTML(post.date);
    CR.bindStars($('#railStars'));
    CR.bindStars(doc);
    $('#rbarTitle').textContent = post.title;

    const tp = $('#transPref');
    if (tp) tp.hidden = !(post.translation && post.translation.length);

    const bt = $('#briefToggle');
    if (bt) {
      bt.addEventListener('click', function () {
        const el = $('#brief');
        el.classList.toggle('collapsed');
        bt.textContent = el.classList.contains('collapsed') ? '展开' : '收起';
      });
    }

    const fav = $('[data-fav]', doc);
    if (fav) {
      fav.addEventListener('click', function () {
        const on = CR.toggleFav(post.date);
        fav.textContent = on ? '已收藏' : '收藏';
        CR.toast(on ? '已收藏' : '已取消收藏', 1300);
      });
    }

    // 上次读到哪里
    const p = CR.progressOf(post.date);
    if (p > 0.05 && p < 0.97) {
      const tip = document.createElement('button');
      tip.className = 'btn btn--accent resume';
      tip.style.cssText = 'width:100%;margin-top:16px;justify-content:space-between';
      tip.innerHTML = '<span>上次读到 ' + Math.round(p * 100) + '%</span><span>回到那里 →</span>';
      tip.addEventListener('click', function () {
        const el = document.getElementById('text');
        const y = el.getBoundingClientRect().top + window.scrollY + el.offsetHeight * p - window.innerHeight * 0.35;
        window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
      });
      $('#toc').parentNode.insertBefore(tip, $('#toc'));
    }
  }

  main();
})();

/* 返回顶部（超长文章阅读辅助） */
(function () {
  function ensureBackTop() {
    if (document.getElementById('backTop')) return;
    var b = document.createElement('button');
    b.id = 'backTop'; b.className = 'back-top'; b.textContent = '↑';
    b.setAttribute('aria-label', '返回顶部');
    b.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    document.body.appendChild(b);
    function sync() { b.classList.toggle('show', window.scrollY > 600); }
    window.addEventListener('scroll', sync, { passive: true });
    sync();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensureBackTop);
  else ensureBackTop();
})();
