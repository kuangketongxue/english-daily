/* ═══════════════════════════════════════════════════════════
   Curated Reads · 公共层
   存储 / 主题 / 评分 / 抽屉 / 朗读 / 提示
   ═══════════════════════════════════════════════════════════ */
window.CR = (function () {
  'use strict';

  const K = {
    ratings: 'cr.ratings.v2',
    ratingsTs: 'cr.ratings_ts.v2',
    favs: 'cr.favs.v2',
    prefs: 'cr.prefs.v2',
    token: 'cr.gh.token.v2',
    tokenSession: 'cr.gh.token.session',
    lastSync: 'cr.gh.lastSync.v2',
  };

  /* ── 存储 ───────────────────────────────────────────── */
  function get(k, d) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : JSON.parse(v);
    } catch (e) {
      return d;
    }
  }
  function set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch (e) {}
  }
  function del(k) {
    try { localStorage.removeItem(k); } catch (e) {}
  }

  /* 旧版键位迁移（v1 → v2，只做一次） */
  (function migrate() {
    if (get('cr.migrated.v2', false)) return;
    const oldR = get('cr:ratings:v1', null);
    if (oldR && typeof oldR === 'object') {
      const cur = get(K.ratings, {});
      set(K.ratings, Object.assign({}, oldR, cur));
      const ts = get(K.ratingsTs, {});
      Object.keys(oldR).forEach(function (d) { if (!ts[d]) ts[d] = Date.now(); });
      set(K.ratingsTs, ts);
    }
    const oldF = get('cr:favs:v1', null);
    if (Array.isArray(oldF) && oldF.length) {
      const cur = get(K.favs, []);
      set(K.favs, Array.from(new Set(cur.concat(oldF))));
    }
    const oldT = get('cr:gh-token', null);
    if (typeof oldT === 'string' && oldT && !localStorage.getItem(K.token)) {
      try { localStorage.setItem(K.token, oldT); } catch (e) {}
    }
    set('cr.migrated.v2', true);
  })();

  /* ── 主题 ───────────────────────────────────────────── */
  const prefs = Object.assign(
    { theme: '', size: 100, lead: 1, measure: 1, font: 'serif', trans: false },
    get(K.prefs, {})
  );
  if (typeof prefs.lead !== 'number' || prefs.lead > 2) prefs.lead = 1;
  if (typeof prefs.measure !== 'number' || prefs.measure > 2) prefs.measure = 1;
  function savePrefs() { set(K.prefs, prefs); }

  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'paper';
  }
  function theme() { return prefs.theme || systemTheme(); }
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    prefs.theme = t;
    savePrefs();
    document.querySelectorAll('[data-theme-icon]').forEach(function (el) {
      el.innerHTML = t === 'night' ? ICON.sun : ICON.moon;
    });
  }
  function toggleTheme() { applyTheme(theme() === 'night' ? 'paper' : 'night'); return theme(); }

  /* ── 文本格式 ───────────────────────────────────────── */
  const pad2 = function (n) { return String(n).padStart(2, '0'); };
  function dstr(d) { return (d || '').replace(/-/g, '.'); }
  function dshort(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    return m ? m[2] + '.' + m[3] : (d || '');
  }
  function weekday(d) {
    const t = new Date((d || '') + 'T00:00:00+08:00');
    return isNaN(t) ? '' : '周' + '日一二三四五六'[t.getDay()];
  }
  function cnDate(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    if (!m) return '';
    return m[1] + ' 年 ' + Number(m[2]) + ' 月 ' + Number(m[3]) + ' 日';
  }
  function issueNo(n) { return String(n).padStart(3, '0'); }

  function pubTime(iso) {
    if (!iso) return '';
    const t = new Date(iso);
    if (isNaN(t)) return '';
    const bj = new Date(t.getTime() + 8 * 3600e3);
    return bj.getUTCFullYear() + '-' + pad2(bj.getUTCMonth() + 1) + '-' + pad2(bj.getUTCDate()) +
      ' ' + pad2(bj.getUTCHours()) + ':' + pad2(bj.getUTCMinutes());
  }
  function ago(iso) {
    if (!iso) return '';
    const h = (Date.now() - new Date(iso).getTime()) / 3600e3;
    if (!isFinite(h) || h < 0) return '';
    if (h < 1) return Math.max(1, Math.round(h * 60)) + ' 分钟前';
    if (h < 48) return Math.round(h) + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── 图标 ───────────────────────────────────────────── */
  const ICON = {
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z"/></svg>',
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>',
    stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l11 7-11 7z"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18a4 4 0 0 1-.5-8 6 6 0 0 1 11.6 1.5A3.5 3.5 0 0 1 17 18z"/><path d="M12 12v5M9.5 14.5 12 12l2.5 2.5"/></svg>',
  };

  /* ── 评分 ───────────────────────────────────────────── */
  function ratings() { return get(K.ratings, {}); }
  function ratingOf(d) { return Number(ratings()[d] || 0); }
  function setRating(d, v) {
    const r = ratings();
    const ts = get(K.ratingsTs, {});
    if (v) { r[d] = v; ts[d] = Date.now(); } else { delete r[d]; ts[d] = Date.now(); }
    set(K.ratings, r);
    set(K.ratingsTs, ts);
    document.dispatchEvent(new CustomEvent('cr:rating', { detail: { date: d, value: v } }));
  }
  function starsHTML(date, cls) {
    const n = ratingOf(date);
    let h = '<div class="stars ' + (cls || '') + '" data-date="' + esc(date) + '" role="group" aria-label="给这篇打分">';
    for (let i = 1; i <= 5; i++) {
      h += '<button data-v="' + i + '" class="' + (i <= n ? 'on' : '') + '" aria-label="' + i + ' 分">★</button>';
    }
    h += '<span class="note">' + (n ? n + ' / 5' : '未评') + '</span></div>';
    return h;
  }
  function bindStars(root) {
    root.querySelectorAll('.stars').forEach(function (box) {
      if (box.dataset.bound) return;
      box.dataset.bound = '1';
      box.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          const d = box.dataset.date;
          const v = Number(b.dataset.v);
          const next = ratingOf(d) === v ? 0 : v;
          setRating(d, next);
          box.querySelectorAll('button').forEach(function (s, i) { s.classList.toggle('on', i < next); });
          box.querySelector('.note').textContent = next ? next + ' / 5' : '未评';
        });
      });
    });
  }

  /* ── 收藏 ───────────────────────────────────────────── */
  function favs() { return get(K.favs, []); }
  function isFav(d) { return favs().indexOf(d) >= 0; }
  function toggleFav(d) {
    const list = favs();
    const i = list.indexOf(d);
    if (i >= 0) list.splice(i, 1); else list.push(d);
    set(K.favs, list);
    document.dispatchEvent(new CustomEvent('cr:fav', { detail: { date: d, on: i < 0 } }));
    return i < 0;
  }

  /* ── 阅读进度 ───────────────────────────────────────── */
  const PKEY = 'cr.progress.v1';
  function progressAll() { return get(PKEY, {}); }
  function progressOf(d) {
    const p = progressAll()[d];
    return p && p.p ? Number(p.p) : 0;
  }
  function setProgress(d, ratio) {
    if (!d) return;
    const all = progressAll();
    all[d] = { p: Math.max(0, Math.min(1, Number(ratio) || 0)), at: Date.now() };
    set(PKEY, all);
  }

  /* ── 提示 ───────────────────────────────────────────── */
  let toastEl = null, toastTimer = null;
  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    requestAnimationFrame(function () { toastEl.classList.add('on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, ms || 2400);
  }

  /* ── 朗读（Web Speech） ─────────────────────────────── */
  const say = {
    on: false,
    idx: -1,
    rate: 0.92,
    supported: 'speechSynthesis' in window,
    stop: function () {
      if (!this.supported) return;
      window.speechSynthesis.cancel();
      this.on = false;
      this.idx = -1;
      document.querySelectorAll('.speaking').forEach(function (el) { el.classList.remove('speaking'); });
      document.dispatchEvent(new CustomEvent('cr:speak', { detail: { on: false } }));
    },
    play: function (paras) {
      if (!this.supported || !paras || !paras.length) return;
      this.stop();
      this.on = true;
      const self = this;
      let i = 0;
      const next = function () {
        if (!self.on || i >= paras.length) { self.stop(); return; }
        const el = paras[i];
        el.classList.add('speaking');
        if (self.idx >= 0 && paras[self.idx] && paras[self.idx] !== el) paras[self.idx].classList.remove('speaking');
        self.idx = i;
        const u = new SpeechSynthesisUtterance(el.textContent || '');
        u.lang = 'en-US';
        u.rate = self.rate;
        u.pitch = 1;
        u.onend = function () { el.classList.remove('speaking'); i++; next(); };
        u.onerror = function () { self.stop(); };
        window.speechSynthesis.speak(u);
        if (el.scrollIntoView && i > 0) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      };
      document.dispatchEvent(new CustomEvent('cr:speak', { detail: { on: true } }));
      next();
    },
  };

  /* ── 数据 ───────────────────────────────────────────── */
  let indexCache = null;
  async function loadIndex() {
    if (indexCache) return indexCache;
    const r = await fetch('data/index.json?t=' + Date.now(), { cache: 'no-cache' });
    if (!r.ok) throw new Error('索引读取失败（HTTP ' + r.status + '）');
    indexCache = await r.json();
    return indexCache;
  }
  async function loadPost(date) {
    const r = await fetch('data/posts/' + date + '.json?t=' + Date.now(), { cache: 'no-cache' });
    if (!r.ok) throw new Error('这一期正文读取失败');
    return r.json();
  }

  /* ── 抽屉（同步设置） ───────────────────────────────── */
  const drawer = {
    el: null,
    scrim: null,
    build: function () {
      if (this.el) return;
      const scrim = document.createElement('div');
      scrim.className = 'scrim';
      const el = document.createElement('aside');
      el.className = 'drawer';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', '同步设置');
      el.innerHTML = [
        '<div class="drawer__head"><h2>同步到仓库</h2><button class="tool" data-close aria-label="关闭">' + ICON.close + '</button></div>',
        '<div class="status" id="syncStatus" data-state="idle"><span class="dot"></span><span id="syncText">未连接</span></div>',
        '<h3>GitHub 令牌</h3>',
        '<div class="field"><input class="input" id="ghToken" type="password" placeholder="ghp_… 或 github_pat_…" autocomplete="off" spellcheck="false"></div>',
        '<label class="check"><input type="checkbox" id="ghRemember" checked><span>记住令牌（只存在这台设备的浏览器里）</span></label>',
        '<div class="row-2"><button class="btn" id="ghSave">验证并保存</button><button class="btn" id="ghClear">断开</button></div>',
        '<p class="hint">令牌需要 <code>contents:write</code> 权限，只用于把这台设备上的评分与收藏写回 <code>data/ratings.json</code>。关闭浏览器不会上传到任何第三方。</p>',
        '<h3>同步</h3>',
        '<div class="row-2"><button class="btn btn--solid" id="ghSync">立即同步</button><button class="btn" id="ghExport">导出本地</button></div>',
        '<label class="check"><input type="checkbox" id="ghAuto"><span>评分后自动同步（静默，3 秒防抖）</span></label>',
        '<p class="hint" id="ghLast">还没有同步记录。</p>',
        '<h3>导入</h3>',
        '<div class="field"><textarea class="input" id="ghImport" rows="4" placeholder="粘贴 ratings.json 内容，用于从别的设备恢复"></textarea></div>',
        '<button class="btn" id="ghImportBtn">合并导入</button>',
      ].join('');
      document.body.appendChild(scrim);
      document.body.appendChild(el);
      this.el = el;
      this.scrim = scrim;
      const self = this;
      scrim.addEventListener('click', function () { self.close(); });
      el.querySelector('[data-close]').addEventListener('click', function () { self.close(); });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && self.el.classList.contains('on')) self.close();
      });
      if (CR.repo) CR.repo.bind();
    },
    open: function () {
      this.build();
      document.getElementById('ghToken').value = CR.repo.getToken() || '';
      CR.repo.paint();
      this.el.classList.add('on');
      this.scrim.classList.add('on');
      document.body.style.overflow = 'hidden';
    },
    close: function () {
      if (!this.el) return;
      this.el.classList.remove('on');
      this.scrim.classList.remove('on');
      document.body.style.overflow = '';
    },
  };

  function openSettings() { drawer.open(); }

  /* 顶栏与抽屉按钮的通用绑定 */
  function wireChrome() {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        const t = toggleTheme();
        toast(t === 'night' ? '夜色模式' : '纸本模式', 1200);
      });
    });
    document.querySelectorAll('[data-open-sync]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.preventDefault(); openSettings(); });
    });
    document.querySelectorAll('[data-theme-icon]').forEach(function (el) {
      el.innerHTML = theme() === 'night' ? ICON.sun : ICON.moon;
    });
  }

  return {
    K, get, set, del, prefs, savePrefs,
    theme, applyTheme, toggleTheme, systemTheme,
    fmt: { dstr, dshort, weekday, cnDate, issueNo, pubTime, ago, esc, pad2 },
    esc, ICON,
    ratings, ratingOf, setRating, starsHTML, bindStars,
    favs, isFav, toggleFav,
    progressAll, progressOf, setProgress,
    toast, say, loadIndex, loadPost,
    drawer, openSettings, wireChrome,
  };
})();
