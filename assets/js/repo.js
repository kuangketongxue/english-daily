/* ═══════════════════════════════════════════════════════════
   评分同步：浏览器 → GitHub 仓库 data/ratings.json
   · 令牌只存本机（localStorage 或 sessionStorage）
   · 冲突自动重取 sha 后重试，最多 3 次
   · 按时间戳逐条合并，不整块覆盖
   ═══════════════════════════════════════════════════════════ */
window.CR = window.CR || {};
CR.repo = (function () {
  'use strict';

  const REPO = 'kuangketongxue/english-daily';
  const PATH = 'data/ratings.json';
  const API = 'https://api.github.com/repos/' + REPO + '/contents/' + PATH;

  let busy = false;
  let autoTimer = null;

  /* ── base64（UTF-8 安全） ───────────────────────────── */
  function b64enc(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64dec(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ── 令牌 ───────────────────────────────────────────── */
  function getToken() {
    return localStorage.getItem(CR.K.token) || sessionStorage.getItem(CR.K.tokenSession) || '';
  }
  function setToken(t, remember) {
    t = String(t || '').trim();
    if (!t) return clearToken();
    if (remember) {
      localStorage.setItem(CR.K.token, t);
      sessionStorage.removeItem(CR.K.tokenSession);
    } else {
      sessionStorage.setItem(CR.K.tokenSession, t);
      localStorage.removeItem(CR.K.token);
    }
  }
  function clearToken() {
    localStorage.removeItem(CR.K.token);
    sessionStorage.removeItem(CR.K.tokenSession);
  }

  function headers(token) {
    return {
      Authorization: 'Bearer ' + (token || getToken()),
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /* ── 错误翻译：把 HTTP 码说人话 ─────────────────────── */
  function explain(status, payload) {
    const msg = (payload && (payload.message || '')) || '';
    if (status === 401) return '令牌无效或已过期，请重新生成一个';
    if (status === 403) {
      if (/rate limit/i.test(msg)) return 'GitHub 接口限流，等一分钟再试';
      return '令牌没有写权限，勾选 contents: write 后重新生成';
    }
    if (status === 404) return '找不到仓库或文件：确认令牌对该仓库有访问权限';
    if (status === 409 || status === 422) return '文件版本冲突，正在重试';
    if (status >= 500) return 'GitHub 服务暂时不可用，稍后再试';
    return msg || ('请求失败（HTTP ' + status + '）');
  }

  /* ── 读远端 ─────────────────────────────────────────── */
  async function pull(token) {
    const r = await fetch(API, { headers: headers(token), cache: 'no-store' });
    if (r.status === 404) return { ok: true, data: { ratings: {}, favs: [], ratings_ts: {} }, sha: null };
    if (!r.ok) {
      let p = null;
      try { p = await r.json(); } catch (e) {}
      return { ok: false, error: explain(r.status, p), status: r.status };
    }
    const j = await r.json();
    let data = { ratings: {}, favs: [], ratings_ts: {} };
    try { data = JSON.parse(b64dec(j.content)); } catch (e) {}
    return { ok: true, data: data, sha: j.sha };
  }

  /* ── 合并：逐条比较时间戳，远端新的赢 ───────────────── */
  function merge(remote) {
    const local = CR.ratings();
    const localTs = CR.get(CR.K.ratingsTs, {});
    const remoteR = (remote && remote.ratings) || {};
    const remoteTs = (remote && remote.ratings_ts) || {};
    const out = {};
    const ts = {};
    const dates = new Set(Object.keys(local).concat(Object.keys(remoteR)));
    dates.forEach(function (d) {
      const lv = Number(local[d] || 0);
      const rv = Number(remoteR[d] || 0);
      const lt = Number(localTs[d] || 0);
      const rt = Number(remoteTs[d] || 0);
      let pick;
      if (lt || rt) {
        // 有时间戳就按时间戳：本地更新（包括「取消评分」）不被远端旧值盖回去
        pick = lt >= rt ? lv : rv;
      } else {
        pick = lv || rv;
      }
      if (pick) { out[d] = pick; ts[d] = Math.max(lt, rt) || Date.now(); }
      else if (lt || rt) { ts[d] = Math.max(lt, rt); }
    });
    const favs = Array.from(new Set(CR.favs().concat((remote && remote.favs) || [])));
    return {
      updated: new Date().toISOString().slice(0, 10),
      ratings: out,
      ratings_ts: ts,
      favs: favs,
    };
  }

  /* ── 写远端 ─────────────────────────────────────────── */
  async function put(merged, sha, token) {
    const body = {
      message: '同步评分 ' + merged.updated,
      content: b64enc(JSON.stringify(merged, null, 2) + '\n'),
    };
    if (sha) body.sha = sha;
    const r = await fetch(API, {
      method: 'PUT',
      headers: Object.assign(headers(token), { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let p = null;
      try { p = await r.json(); } catch (e) {}
      return { ok: false, status: r.status, error: explain(r.status, p) };
    }
    const j = await r.json();
    return { ok: true, sha: j.content && j.content.sha };
  }

  /* ── 完整同步 ───────────────────────────────────────── */
  async function sync(opts) {
    opts = opts || {};
    if (busy) return { ok: false, error: '正在同步中' };
    const token = getToken();
    if (!token) { paint('err', '还没填令牌'); if (!opts.quiet) CR.toast('先在设置里填一个 GitHub 令牌'); return { ok: false, error: '未配置令牌' }; }
    busy = true;
    paint('busy', '同步中…');
    let lastErr = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const pulled = await pull(token);
      if (!pulled.ok) { lastErr = pulled.error; break; }
      const merged = merge(pulled.data);
      const res = await put(merged, pulled.sha, token);
      if (res.ok) {
        // 本地也补齐远端来的旧评分
        CR.set(CR.K.ratings, merged.ratings);
        CR.set(CR.K.ratingsTs, merged.ratings_ts);
        CR.set(CR.K.favs, merged.favs);
        const stamp = new Date().toISOString();
        CR.set(CR.K.lastSync, { at: stamp, ok: true, count: Object.keys(merged.ratings).length });
        paint('ok', '已同步 ' + Object.keys(merged.ratings).length + ' 条评分 · ' + CR.fmt.pubTime(stamp).slice(5));
        if (!opts.quiet) CR.toast('评分已写回仓库');
        document.dispatchEvent(new CustomEvent('cr:synced'));
        busy = false;
        return { ok: true, count: Object.keys(merged.ratings).length };
      }
      lastErr = res.error;
      if (res.status !== 409 && res.status !== 422) break;
      await new Promise(function (r) { setTimeout(r, 400 + attempt * 600); });
    }
    CR.set(CR.K.lastSync, { at: new Date().toISOString(), ok: false, error: lastErr });
    paint('err', lastErr || '同步失败');
    if (!opts.quiet) CR.toast(lastErr || '同步失败');
    busy = false;
    return { ok: false, error: lastErr };
  }

  /* ── 验证令牌 ───────────────────────────────────────── */
  async function verify(token) {
    token = String(token || '').trim();
    if (!token) return { ok: false, error: '请先填入令牌' };
    try {
      const u = await fetch('https://api.github.com/user', { headers: headers(token), cache: 'no-store' });
      if (!u.ok) {
        let p = null;
        try { p = await u.json(); } catch (e) {}
        return { ok: false, error: explain(u.status, p), status: u.status };
      }
      const user = await u.json();
      const rep = await fetch('https://api.github.com/repos/' + REPO, { headers: headers(token), cache: 'no-store' });
      if (!rep.ok) {
        let p2 = null;
        try { p2 = await rep.json(); } catch (e) {}
        return { ok: false, error: rep.status === 404 ? '这个令牌看不到 ' + REPO + '，请检查权限' : explain(rep.status, p2), status: rep.status };
      }
      const rj = await rep.json();
      const canWrite = !!(rj.permissions && rj.permissions.push);
      if (!canWrite) return { ok: false, error: '令牌对仓库没有写权限（需要 contents: write）', login: user.login };
      return { ok: true, login: user.login };
    } catch (e) {
      return { ok: false, error: '网络不通：' + e.message };
    }
  }

  /* ── 面板状态 ───────────────────────────────────────── */
  function paint(state, text) {
    const box = document.getElementById('syncStatus');
    const txt = document.getElementById('syncText');
    const last = document.getElementById('ghLast');
    const auto = document.getElementById('ghAuto');
    const t = getToken();

    if (box && txt) {
      if (state) {
        box.dataset.state = state;
        txt.textContent = text;
      } else {
        box.dataset.state = t ? 'ok' : 'idle';
        txt.textContent = t ? '已保存令牌，可同步' : '未连接：填令牌后才能写回仓库';
      }
    }
    if (last) {
      const ls = CR.get(CR.K.lastSync, null);
      last.textContent = ls
        ? (ls.ok
            ? '上次同步成功：' + CR.fmt.pubTime(ls.at) + '（' + (ls.count || 0) + ' 条评分）'
            : '上次同步失败：' + CR.fmt.pubTime(ls.at) + ' · ' + (ls.error || ''))
        : '还没有同步记录。';
    }
    if (auto) auto.checked = !!CR.get('cr.gh.auto', false);
  }

  /* ── 导出 / 导入 ───────────────────────────────────── */
  function download() {
    const data = {
      updated: new Date().toISOString().slice(0, 10),
      ratings: CR.ratings(),
      ratings_ts: CR.get(CR.K.ratingsTs, {}),
      favs: CR.favs(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ratings.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    CR.toast('已导出 ratings.json');
  }

  function importJSON(text) {
    try {
      const j = JSON.parse(text);
      const merged = merge(j);
      CR.set(CR.K.ratings, merged.ratings);
      CR.set(CR.K.ratingsTs, merged.ratings_ts);
      CR.set(CR.K.favs, merged.favs);
      CR.toast('已合并 ' + Object.keys(merged.ratings).length + ' 条评分');
      document.dispatchEvent(new CustomEvent('cr:synced'));
      return true;
    } catch (e) {
      CR.toast('内容不是合法的 JSON');
      return false;
    }
  }

  /* ── 抽屉内事件绑定 ─────────────────────────────────── */
  function bind() {
    const $ = function (id) { return document.getElementById(id); };
    const save = $('ghSave');
    if (!save || save.dataset.bound) return;
    save.dataset.bound = '1';

    save.addEventListener('click', async function () {
      const input = $('ghToken');
      const remember = $('ghRemember').checked;
      const token = input.value.trim();
      paint('busy', '验证中…');
      const v = await verify(token);
      if (!v.ok) { paint('err', v.error); return; }
      setToken(token, remember);
      paint('ok', '已连接 @' + v.login + '，可以同步');
      CR.toast('令牌有效，已保存');
      await sync({ quiet: true });
    });

    $('ghClear').addEventListener('click', function () {
      clearToken();
      $('ghToken').value = '';
      paint(null);
      CR.toast('已断开，本机令牌已清除');
    });

    $('ghSync').addEventListener('click', function () { sync(); });
    $('ghExport').addEventListener('click', download);
    $('ghImportBtn').addEventListener('click', function () {
      if (importJSON($('ghImport').value)) $('ghImport').value = '';
    });
    $('ghAuto').addEventListener('change', function (e) {
      CR.set('cr.gh.auto', e.target.checked);
    });

    document.addEventListener('cr:rating', function () {
      if (!CR.get('cr.gh.auto', false) || !getToken()) return;
      clearTimeout(autoTimer);
      autoTimer = setTimeout(function () { sync({ quiet: true }); }, 3000);
    });
  }

  return { sync, verify, pull, merge, bind, paint, download, importJSON, getToken, setToken, clearToken, REPO, PATH };
})();
