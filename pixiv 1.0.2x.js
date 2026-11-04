// ==UserScript==
// @name         pixiv 1.0.2x
// @namespace    dsh.pixiv.sort
// @version      1.2.2
// @description  pixiv 搜索页按收藏数/浏览量重排插画、漫画、小说；支持夜间模式、可缩放窗口、自定义每页数量与缩略图大小、R-18/AI 筛选、阈值过滤、页码范围、自定义文件名规则、一键保存原图；1.2.2 修复旧版脚本残留导致新版面板不生效、设置区被裁切、数字框误触步进按钮
// @match        https://www.pixiv.net/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      i.pximg.net
// @run-at       document-idle
// ==/UserScript==

/*
 * 模块导航（1.2.x）：
 *   1. 配置与持久化      CFG / DEF / cfg / persist
 *   2. 纯工具            clamp / fmt / escape / 时间与文本
 *   3. 本地计数缓存      counts / cacheGet / cachePut / prune
 *   4. 网络层            getJson / searchUrl / fetchPage / fillCounts
 *   5. 视图层            renderPage / makeCard / rebuild / renderXxx
 *   6. 保存层            dirHandle / fileName / saveImage / queueSave
 *   7. 面板与主题        theme / frame / resize / max
 *   8. 启动              boot / 事件绑定 / SPA 路由
 * 设计约定：DOM 只通过 el 缓存访问；UI 状态只在 renderXxx 里写 dataset；
 *          所有「抓取/补全」任务都带 runId，旧任务发现令牌过期就自行退出。
 */
(function () {
  'use strict';

  // 同一页面可能同时装着 1.0.x / 1.1.x / 1.2.x 的旧脚本（Tampermonkey 里忘了删）。
  // 旧脚本先注入时，新版若直接 return，用户看到的就是旧面板（没有命名规则、文件夹授权等新行）。
  // 这里改成「新版本接管」：发现旧容器就摘掉，由本脚本重新挂载。
  const BUILD = '1.2.2';
  const ROOT_ID = 'pxs-root';
  (function takeover() {
    const old = document.getElementById(ROOT_ID);
    if (!old) return;
    if (old.dataset && old.dataset.pxsBuild === BUILD) return;   // 同版本重复注入：让先来的待着
    old.remove();
    document.querySelectorAll('style[id="pxs-style"]').forEach(n => n.remove());
    try { console.log('[pixiv-sort] 检测到旧版面板，已由 ' + BUILD + ' 接管'); } catch (e) {}
  })();

  /* ================= 配置 ================= */
  const CFG_KEY = 'pxs.cfg.v6';
  const COUNT_KEY = 'pxs.counts.v6';
  const LEGACY_COUNT_KEY = 'pxs.counts.v5';
  const COUNT_TTL = 7 * 864e5;   // 缓存有效期
  const COUNT_MAX = 5000;        // 缓存条数上限

  const DEF = {
    pageFrom: 1, pageTo: 1,
    interval: 500, pageSize: 24,
    type: 'both',               // 'both' 插画/漫画 | 'illust' 插画 | 'manga' 漫画 | 'novel' 小说
    cardSize: 0,                // 缩略图列宽 px；0 = 自动
    sortKey: 'bookmark',        // 'bookmark' | 'view'
    minEnabled: false,
    minKey: 'bookmark',         // 'bookmark' | 'view'
    minValue: 0,
    filterR18: false,           // true → mode=safe
    filterAI: true,             // true → ai_type=1
    saveMode: 'download',       // 'download' | 'dir'
    saveDir: 'pixiv',
    askPath: false,
    template: '{title}_{id}',
    theme: 'dark',              // 'dark' | 'light' | 'auto'（跟随 pixiv 页面）
    panelW: 0, panelH: 0,       // 0 = 使用默认尺寸
    panelL: 0, panelT: 0,       // 0 = 贴右下角
    panelMax: false,
  };

  function readJson(k, dflt) {
    try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? dflt : v; }
    catch (e) { return dflt; }
  }
  const cfg = Object.assign({}, DEF, readJson(CFG_KEY, {}));
  const persist = () => { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} };

  // 老配置只有 pages（单值），迁移成 1..N
  if (cfg.pageFrom == null || cfg.pageTo == null) {
    const n = Math.min(50, Math.max(1, Number(cfg.pages) || 1));
    cfg.pageFrom = 1;
    cfg.pageTo = n;
  }

  // 缓存升级：v5 的 {c,t} → v6 的 {b,v,t}
  let counts = readJson(COUNT_KEY, null);
  if (!counts) {
    const old = readJson(LEGACY_COUNT_KEY, {});
    counts = {};
    for (const k of Object.keys(old)) {
      const v = old[k];
      if (v && typeof v.t === 'number') counts[k] = { b: Number(v.c) || 0, v: 0, t: v.t };
    }
  }
  const persistCounts = () => { try { localStorage.setItem(COUNT_KEY, JSON.stringify(counts)); } catch (e) {} };

  const state = { items: [], shown: [], page: 1, keyword: null, running: false, runId: 0, dirHandle: null, dirState: 'none' };

  /* ================= 工具 ================= */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = n => Number(n || 0).toLocaleString('en-US');

  function toNum(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string') { const n = parseInt(v.replace(/[^\d]/g, ''), 10); return isFinite(n) ? n : 0; }
    return 0;
  }
  function delay() {
    const base = Math.max(0, cfg.interval);
    if (!base) return 0;
    return Math.round(base * (0.6 + Math.random() * 0.8));
  }
  function rangeText() {
    const base = Math.max(0, cfg.interval);
    if (!base) return '无间隔';
    return Math.round(base * 0.6) + '–' + Math.round(base * 1.4) + ' ms';
  }
  function filterText() {
    return (cfg.filterR18 ? '屏蔽 R-18' : '含 R-18') + ' · ' + (cfg.filterAI ? '屏蔽 AI' : '含 AI');
  }
  function pageText() {
    return cfg.pageFrom === cfg.pageTo
      ? '第 ' + cfg.pageFrom + ' 页'
      : '第 ' + cfg.pageFrom + '–' + cfg.pageTo + ' 页';
  }
  const sortName = k => (k === 'view' ? '浏览量' : '收藏数');

  // 抓取类型：插画/漫画走 artworks 接口，小说走 novels 接口
  const TYPE_NAME = { both: '插画/漫画', illust: '插画', manga: '漫画', novel: '小说' };
  const isNovel = () => cfg.type === 'novel';

  // 兼容三种搜索入口：
  //   /tags/关键词/artworks  ·  /search?q=关键词（新版）  ·  /search?word=关键词（旧版）
  function currentKeyword() {
    const path = location.pathname;
    const mTag = path.match(/^\/tags\/([^/]+)/);
    if (mTag) {
      try { const k = decodeURIComponent(mTag[1]).trim(); return k || null; } catch (e) { return mTag[1]; }
    }
    if (/^\/search(\/|$)/.test(path)) {
      const qs = new URLSearchParams(location.search);
      const k = String(qs.get('q') || qs.get('word') || '').trim();
      return k || null;
    }
    return null;
  }

  // 新版搜索页的 s_mode（tag / title_and_caption）与 ajax 接口的 s_tag / s_tc 不是一个东西
  const S_MODE_MAP = {
    tag: 's_tag', tag_full: 's_tag_full', title_and_caption: 's_tc', title: 's_tc',
    s_tag: 's_tag', s_tag_full: 's_tag_full', s_tc: 's_tc',
  };
  const normalizeSMode = v => S_MODE_MAP[String(v || '').toLowerCase()] || 's_tag';

  // 新版 type=artwork 对应接口的 all；manga / ugoira / illust 原样保留

  /* ================= 缓存清理 ================= */
  function pruneCounts() {
    const now = Date.now();
    let removed = 0;
    for (const k of Object.keys(counts)) {
      const v = counts[k];
      if (!v || typeof v.t !== 'number' || now - v.t > COUNT_TTL) { delete counts[k]; removed++; }
    }
    const keys = Object.keys(counts);
    if (keys.length > COUNT_MAX) {
      keys.sort((a, b) => (counts[a].t || 0) - (counts[b].t || 0));
      for (const k of keys.slice(0, keys.length - COUNT_MAX)) { delete counts[k]; removed++; }
    }
    if (removed) persistCounts();
    return { removed, left: Object.keys(counts).length };
  }

  /* ================= 数据取值 ================= */
  function pickBookmark(it) {
    if (it && it.bookmarkCount !== undefined && it.bookmarkCount !== null) return toNum(it.bookmarkCount);
    if (it && it.bookmarkData && it.bookmarkData.count !== undefined) return toNum(it.bookmarkData.count);
    return 0;
  }
  function pickView(it) {
    if (it && it.viewCount !== undefined && it.viewCount !== null) return toNum(it.viewCount);
    return 0;
  }
  function dataOf(it) {
    return {
      b: it.__b !== undefined ? it.__b : pickBookmark(it),
      v: it.__v !== undefined ? it.__v : pickView(it),
    };
  }
  const metricOf = (it, key) => { const d = dataOf(it); return key === 'view' ? d.v : d.b; };
  const maxMetric = key => state.items.reduce((m, it) => Math.max(m, metricOf(it, key)), 0);

  /* ================= 排序 + 过滤 + 渲染 ================= */
  function rebuild() {
    const key = cfg.sortKey;
    const list = state.items.slice().sort((a, b) => metricOf(b, key) - metricOf(a, key));

    let out = list;
    const mk = cfg.minKey;
    const hasMetric = state.items.some(it => metricOf(it, mk) > 0);
    if (cfg.minEnabled && cfg.minValue > 0) {
      if (hasMetric) {
        out = list.filter(it => metricOf(it, mk) >= cfg.minValue);
      } else {
        log('阈值过滤已跳过：缺少「' + sortName(mk) + '」数据');
        setStatus('阈值过滤需要数据，请先点「补全数据」');
      }
    }

    state.shown = out;
    renderPage();

    if (!state.running && state.items.length && !out.length) {
      setStatus('阈值过滤后没有结果，降低阈值或关闭过滤');
    }
  }

  function summary() {
    const parts = [TYPE_NAME[cfg.type] + ' · 按' + sortName(cfg.sortKey)];
    if (cfg.minEnabled && cfg.minValue > 0) parts.push(sortName(cfg.minKey) + ' ≥ ' + fmt(cfg.minValue));
    return parts.join(' · ');
  }

  function renderPage() {
    const per = cfg.pageSize;
    const pages = Math.max(1, Math.ceil(state.shown.length / per));
    state.page = clamp(state.page, 1, pages);
    const slice = state.shown.slice((state.page - 1) * per, state.page * per);

    const frag = document.createDocumentFragment();
    for (const it of slice) frag.appendChild(makeCard(it));
    el.grid.innerHTML = '';
    el.grid.appendChild(frag);
    el.grid.scrollTop = 0;

    el.info.textContent = state.shown.length
      ? state.page + ' / ' + pages + ' · ' + state.shown.length + '/' + state.items.length + ' 条'
      : '—';
    el.prev.disabled = state.page <= 1;
    el.next.disabled = state.page >= pages;
  }

  /* 轻量 DOM 构造器：卡片里十几个元素，手写 createElement 太啰嗦 */
  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function makeCard(it) {
    const card = mk('a', 'pxs-card');
    card.href = it.__novel ? '/novel/show.php?id=' + it.id : '/artworks/' + it.id;
    card.target = '_blank';
    card.rel = 'noopener';

    const thumb = mk('div', 'pxs-thumb');
    thumb.appendChild(mk('span', 'pxs-ph', 'IMAGE'));

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    img.src = it.url || it.thumb || '';
    img.addEventListener('load', () => img.classList.add('pxs-ready'));
    img.addEventListener('error', () => img.remove());
    if (img.complete && img.naturalWidth) img.classList.add('pxs-ready');
    thumb.appendChild(img);

    const d = dataOf(it);
    const isView = cfg.sortKey === 'view';
    const score = mk('span', 'pxs-score');
    score.innerHTML = '<i>' + (isView ? '👁' : '♥') + '</i>' + fmt(isView ? d.v : d.b);
    thumb.appendChild(score);

    if (!it.__novel && it.pageCount > 1) thumb.appendChild(mk('span', 'pxs-multi', it.pageCount + 'P'));

    if (!it.__novel) {
      const dl = mk('button', 'pxs-dl', '⬇ 原图');
      dl.type = 'button';
      dl.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); startDownload(it, thumb, dl); });
      thumb.appendChild(dl);
    }
    card.appendChild(thumb);

    const title = mk('div', 'pxs-title', it.title || '(无标题)');
    title.title = it.title || '';
    card.appendChild(title);

    const user = mk('div', 'pxs-user');
    user.appendChild(mk('span', null, it.userName || ''));
    const altVal = isView ? d.b : d.v;
    if (altVal > 0) user.appendChild(mk('span', 'pxs-alt', (isView ? '♥ ' : '👁 ') + fmt(altVal)));
    card.appendChild(user);

    return card;
  }

  /* ================= 样式 ================= */
  const CSS = `
  #pxs-root{position:fixed;inset:0;pointer-events:none;z-index:2147483647;
    --bg:#ffffff;--bg-soft:#f6f7f9;--bg-elev:#ffffff;--bg-sub:#fbfbfc;
    --line:#e8eaef;--line-strong:#c9ced8;--ink:#101216;--muted:#6b7280;--faint:#98a0ac;
    --accent:#0f62fe;--accent-hover:#0a55da;--accent-ink:#ffffff;
    --accent-soft:#f2f6ff;--accent-soft-h:#e8efff;
    --danger:#d93025;--ok:#0a7a45;--ok-line:#bfe6d1;--ok-bg:#f1fbf5;
    --danger-line:#f3c9c4;--danger-bg:#fdf3f2;
    --panel-shadow:0 34px 80px -28px rgba(15,23,42,.38);
    --fab-shadow:0 12px 32px -14px rgba(15,23,42,.3);
    --score-bg:rgba(255,255,255,.94);--score-shadow:0 1px 4px rgba(15,23,42,.14);
    --thumb-bg:#f6f7f9;
    color-scheme:light;
    font:13px/1.55 "Avenir Next","Segoe UI Variable Text","SF Pro Text",-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    color:var(--ink);-webkit-font-smoothing:antialiased}
  #pxs-root[data-theme="dark"]{
    --bg:#14161b;--bg-soft:#1b1f26;--bg-elev:#1f242c;--bg-sub:#171a20;
    --line:#2a303a;--line-strong:#3c4452;--ink:#e7eaf0;--muted:#9aa3b2;--faint:#6e7784;
    --accent:#5b8cff;--accent-hover:#7ba3ff;--accent-ink:#0b1220;
    --accent-soft:rgba(91,140,255,.16);--accent-soft-h:rgba(91,140,255,.26);
    --danger:#ff7b72;--ok:#5ad46f;--ok-line:#2f5d3f;--ok-bg:rgba(90,212,111,.12);
    --danger-line:#5c3230;--danger-bg:rgba(255,123,114,.12);
    --panel-shadow:0 34px 80px -28px rgba(0,0,0,.72);
    --fab-shadow:0 12px 32px -14px rgba(0,0,0,.6);
    --score-bg:rgba(20,23,29,.88);--score-shadow:0 1px 4px rgba(0,0,0,.45);
    --thumb-bg:#232830;
    color-scheme:dark}
  #pxs-root *{box-sizing:border-box}
  #pxs-root button{font:inherit;cursor:pointer;color:inherit}
  #pxs-fab{pointer-events:auto;position:fixed;right:22px;bottom:22px;display:inline-flex;align-items:center;gap:9px;
    padding:11px 18px;background:var(--bg-elev);border:1px solid var(--line);border-radius:999px;
    box-shadow:var(--fab-shadow);letter-spacing:.02em;transition:.18s ease;color:var(--ink)}
  #pxs-fab::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--accent)}
  #pxs-fab:hover{border-color:var(--accent);color:var(--accent);transform:translateY(-1px)}
  #pxs-panel{pointer-events:auto;position:fixed;right:22px;bottom:78px;width:min(1120px,92vw);height:min(84vh,820px);
    display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:18px;
    box-shadow:var(--panel-shadow);overflow:hidden;min-width:0}
  #pxs-panel[hidden]{display:none}
  #pxs-panel.is-max{left:0;top:0;right:0;bottom:0;width:auto;height:auto;
    border-radius:0;border-width:0;box-shadow:none}
  #pxs-panel.is-max .pxs-grip{display:none}
  #pxs-panel.is-resizing{user-select:none}
  .pxs-flash{animation:pxs-flash 1.2s ease-in-out 2}
  @keyframes pxs-flash{0%,100%{box-shadow:0 0 0 0 rgba(255,138,61,0)}50%{box-shadow:0 0 0 3px rgba(255,138,61,.85)}}
  .pxs-grip{position:absolute;z-index:5;background:transparent}
  #pxs-gn{left:16px;right:16px;top:0;height:8px;cursor:ns-resize}
  #pxs-gs{left:16px;right:16px;bottom:0;height:10px;cursor:ns-resize}
  #pxs-gw{top:16px;bottom:16px;left:0;width:8px;cursor:ew-resize}
  #pxs-ge{top:16px;bottom:16px;right:0;width:10px;cursor:ew-resize}
  #pxs-gnw{left:0;top:0;width:14px;height:14px;cursor:nwse-resize}
  #pxs-gne{right:0;top:0;width:14px;height:14px;cursor:nesw-resize}
  #pxs-gsw{left:0;bottom:0;width:16px;height:16px;cursor:nesw-resize}
  #pxs-gse{right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize}
  #pxs-gse::after{content:"";position:absolute;right:5px;bottom:5px;width:8px;height:8px;
    border-right:2px solid var(--line-strong);border-bottom:2px solid var(--line-strong);border-radius:0 0 3px 0;opacity:.75}
  #pxs-panel:hover #pxs-gse::after{opacity:1;border-color:var(--accent)}
  #pxs-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line)}
  .pxs-brand{font-size:11px;letter-spacing:.16em;color:var(--muted);white-space:nowrap}
  #pxs-kw{font-size:12px;padding:3px 10px;border:1px solid var(--line);border-radius:999px;background:var(--bg-soft);
    max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pxs-grow{flex:1}
  .pxs-btn{padding:7px 14px;border:1px solid var(--line);border-radius:9px;background:var(--bg-elev);transition:.15s}
  .pxs-btn:hover{border-color:var(--line-strong);background:var(--bg-soft)}
  .pxs-btn-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600;letter-spacing:.02em}
  .pxs-btn-primary:hover{background:var(--accent-hover);border-color:var(--accent-hover);color:var(--accent-ink)}
  .pxs-btn:disabled{opacity:.5;cursor:default}
  .pxs-btn-sm{padding:4px 10px;font-size:11px;border-radius:7px}
  .pxs-icon-btn{width:32px;height:32px;display:grid;place-items:center;padding:0;font-size:15px;line-height:1;
    border:1px solid transparent;border-radius:9px;background:transparent;color:var(--muted)}
  .pxs-icon-btn:hover{background:var(--bg-soft);color:var(--ink)}
  #pxs-close{width:32px;height:32px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--muted)}
  #pxs-close:hover{background:var(--bg-soft);color:var(--ink)}
  #pxs-typebar{display:flex;align-items:center;gap:10px;padding:10px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap;font-size:12px;color:var(--muted)}
  .pxs-typebar-label{letter-spacing:.02em;white-space:nowrap}
  .pxs-types{display:inline-flex;gap:8px;flex-wrap:wrap}
  .pxs-types button{padding:5px 15px;border:1px solid var(--line);border-radius:999px;background:var(--bg-elev);font-size:12px;color:var(--muted);transition:.15s;cursor:pointer}
  .pxs-types button:hover{border-color:var(--line-strong);color:var(--ink)}
  .pxs-types button[data-on="1"]{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
  #pxs-controls{display:flex;align-items:center;gap:16px;padding:10px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap;font-size:12px;color:var(--muted)}
  #pxs-controls label{display:inline-flex;align-items:center;gap:7px}
  /* 数字左对齐：光标落在左侧数字上，不会误触右侧原生的 +1/-1 箭头 */
  .pxs-num{width:64px;padding:5px 20px 5px 9px;border:1px solid var(--line);border-radius:8px;background:var(--bg-elev);
    font:inherit;font-variant-numeric:tabular-nums;color:var(--ink);text-align:left}
  .pxs-num-wide{width:100px}
  #pxs-size{width:84px}
  .pxs-sel{padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg-elev);font:inherit;color:var(--ink)}
  .pxs-num:focus,.pxs-sel:focus{outline:2px solid var(--accent-soft-h);border-color:var(--accent)}
  #pxs-jitter{color:var(--faint);font-variant-numeric:tabular-nums}
  .pxs-sep{width:1px;height:18px;background:var(--line)}
  .pxs-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer;user-select:none;color:var(--ink)}
  .pxs-check input{width:14px;height:14px;margin:0;accent-color:var(--accent)}
  .pxs-filters{display:inline-flex;align-items:center;gap:14px;padding:3px 12px;border:1px solid var(--line);border-radius:999px;background:var(--bg-sub)}
  .pxs-seg{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .pxs-seg button{padding:4px 14px;border:0;background:var(--bg-elev);font-size:12px;color:var(--muted);transition:.15s}
  .pxs-seg button[data-on="1"]{background:var(--accent);color:var(--accent-ink);font-weight:600}
  .pxs-seg button:not([data-on="1"]):hover{background:var(--bg-soft);color:var(--ink)}
  #pxs-settings{display:none;flex-direction:column;gap:7px;padding:9px 18px;background:var(--bg-sub);border-bottom:1px solid var(--line);max-height:min(70vh,680px);overflow:auto;scrollbar-gutter:stable}
  #pxs-settings[data-open="1"]{display:flex}
  #pxs-settings::-webkit-scrollbar{width:10px}
  #pxs-settings::-webkit-scrollbar-thumb{background:var(--line-strong);border-radius:999px}
  #pxs-settings::-webkit-scrollbar-track{background:transparent}
  .pxs-sec{font-size:11px;letter-spacing:.1em;color:var(--faint);border-top:1px dashed var(--line);padding-top:7px}
  #pxs-settings > .pxs-sec:first-child{border-top:0;padding-top:0}
  .pxs-row{display:flex;align-items:center;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
  .pxs-row label{display:inline-flex;align-items:center;gap:6px}
  #pxs-settings input[type=text]{width:190px;padding:5px 9px;border:1px solid var(--line);border-radius:8px;font:inherit;color:var(--ink);background:var(--bg-elev)}
  .pxs-hint{font-size:11px;color:var(--faint)}
  .pxs-tplprev{flex:1 1 240px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .pxs-guide{border:1px solid var(--line);border-radius:9px;background:var(--bg-elev);padding:0 12px}
  .pxs-guide summary{padding:8px 0;font-size:12px;color:var(--ink);cursor:pointer;letter-spacing:.02em}
  .pxs-guide ol{margin:0 0 10px 18px;padding:0;font-size:12px;color:var(--muted);line-height:1.8}
  .pxs-guide code{background:var(--bg-soft);border-radius:4px;padding:1px 5px;font-size:11px}
  #pxs-dirbox{display:inline-flex;align-items:center;gap:8px}
  #pxs-dirname{font-variant-numeric:tabular-nums}
  .pxs-badge{font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--line);background:var(--bg-elev)}
  .pxs-badge[data-state="ok"]{color:var(--ok);border-color:var(--ok-line);background:var(--ok-bg)}
  .pxs-badge[data-state="warn"]{color:var(--danger);border-color:var(--danger-line);background:var(--danger-bg)}
  #pxs-statusbar{display:flex;align-items:center;gap:12px;padding:9px 18px;border-bottom:1px solid var(--line);font-size:12px;color:var(--muted)}
  #pxs-status{font-variant-numeric:tabular-nums}
  #pxs-fill{padding:4px 11px;border:1px solid var(--accent-soft-h);border-radius:999px;background:var(--accent-soft);color:var(--accent);font-size:11px}
  #pxs-fill:hover{background:var(--accent-soft-h)}
  #pxs-dl{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;padding:3px 10px;
    border:1px solid var(--line);border-radius:999px;background:var(--bg-elev);cursor:pointer;transition:.15s}
  #pxs-dl:hover{color:var(--ink);border-color:var(--line-strong)}
  #pxs-dl[data-fail="1"]{color:var(--danger);border-color:var(--danger-line);background:var(--danger-bg)}
  #pxs-dl[data-busy="1"]::before{content:"●";margin-right:6px;color:var(--accent);animation:pxs-pulse 1s ease-in-out infinite}
  @keyframes pxs-pulse{0%,100%{opacity:.25}50%{opacity:1}}
  #pxs-grid{flex:1;overflow:auto;padding:16px 18px;display:grid;gap:16px;align-content:start;
    grid-template-columns:repeat(auto-fill,minmax(min(var(--card-w,146px),100%),1fr));
    scrollbar-width:thin;scrollbar-color:var(--line-strong) transparent}
  #pxs-grid::-webkit-scrollbar{width:10px;height:10px}
  #pxs-grid::-webkit-scrollbar-thumb{background:var(--line-strong);border-radius:999px;border:3px solid transparent;background-clip:content-box}
  #pxs-grid::-webkit-scrollbar-track{background:transparent}
  .pxs-card{display:block;text-decoration:none;color:inherit;transition:transform .18s ease}
  .pxs-card:hover{transform:translateY(-2px)}
  .pxs-thumb{position:relative;width:100%;padding-top:100%;border-radius:11px;overflow:hidden;background:var(--thumb-bg);border:1px solid var(--line)}
  .pxs-thumb img{position:absolute;left:0;top:0;width:100%!important;height:100%!important;object-fit:cover;
    display:block;opacity:0;transition:opacity .35s ease}
  .pxs-thumb img.pxs-ready{opacity:1}
  .pxs-ph{position:absolute;inset:0;display:grid;place-items:center;font-size:11px;color:var(--faint);letter-spacing:.08em}
  .pxs-score{position:absolute;left:8px;top:8px;display:flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;
    background:var(--score-bg);color:var(--ink);font-size:11px;font-variant-numeric:tabular-nums;box-shadow:var(--score-shadow)}
  .pxs-score i{font-style:normal;color:#e8456b}
  .pxs-multi{position:absolute;right:8px;top:8px;padding:2px 7px;border-radius:6px;background:rgba(16,18,22,.72);color:#fff;font-size:10px}
  .pxs-dl{position:absolute;right:8px;bottom:8px;padding:4px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg-elev);color:var(--ink);
    font-size:11px;opacity:0;transition:.15s ease;box-shadow:var(--score-shadow)}
  .pxs-card:hover .pxs-dl{opacity:1}
  .pxs-dl:hover{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
  .pxs-title{padding:9px 2px 0;font-size:12px;font-weight:600;line-height:1.45;letter-spacing:.01em;
    display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .pxs-user{display:flex;align-items:center;gap:8px;padding:3px 2px 0;font-size:11px;color:var(--muted)}
  .pxs-user > span:first-child{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .pxs-alt{flex:none;color:var(--muted);opacity:.85;font-variant-numeric:tabular-nums}
  .pxs-picker{position:absolute;left:8px;right:8px;bottom:8px;padding:6px;border:1px solid var(--line);border-radius:8px;
    background:var(--bg-elev);display:flex;flex-wrap:wrap;gap:4px;max-height:96px;overflow:auto;box-shadow:var(--panel-shadow)}
  .pxs-picker button{padding:2px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg-elev);font-size:11px;color:var(--ink)}
  .pxs-picker button:hover{border-color:var(--accent);color:var(--accent)}
  #pxs-foot{display:flex;align-items:center;justify-content:center;gap:16px;padding:10px 18px;border-top:1px solid var(--line)}
  .pxs-pg{width:30px;height:30px;border:1px solid var(--line);border-radius:8px;background:var(--bg-elev);display:grid;place-items:center;color:var(--ink)}
  .pxs-pg:not(:disabled):hover{border-color:var(--accent);color:var(--accent)}
  .pxs-pg:disabled{opacity:.32;cursor:default}
  #pxs-pageinfo{min-width:150px;text-align:center;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
  #pxs-logbox{border-top:1px solid var(--line);max-height:132px;overflow:auto;background:var(--bg-sub)}
  #pxs-logbox summary{padding:6px 18px;font-size:11px;color:var(--faint);cursor:pointer;letter-spacing:.06em}
  #pxs-log{margin:0;padding:0 18px 10px;font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--faint);white-space:pre-wrap}
  `;

  /* ================= DOM ================= */
  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.dataset.pxsBuild = BUILD;   // 供 takeover() 判断是不是同一版本
  root.innerHTML = '<style>' + CSS + '</style>' +
    '<button id="pxs-fab">收藏/浏览排序</button>' +
    '<section id="pxs-panel" hidden>' +
      '<div id="pxs-gn" class="pxs-grip"></div>' +
      '<div id="pxs-gs" class="pxs-grip"></div>' +
      '<div id="pxs-gw" class="pxs-grip"></div>' +
      '<div id="pxs-ge" class="pxs-grip"></div>' +
      '<div id="pxs-gnw" class="pxs-grip"></div>' +
      '<div id="pxs-gne" class="pxs-grip"></div>' +
      '<div id="pxs-gsw" class="pxs-grip"></div>' +
      '<div id="pxs-gse" class="pxs-grip" title="拖动调整大小"></div>' +
      '<header id="pxs-head">' +
        '<span class="pxs-brand">PIXIV · 收藏/浏览排序</span>' +
        '<span id="pxs-kw">—</span>' +
        '<span class="pxs-grow"></span>' +
        '<button id="pxs-run" class="pxs-btn pxs-btn-primary">开始抓取</button>' +
        '<button id="pxs-cfg" class="pxs-btn">设置</button>' +
        '<button id="pxs-theme" class="pxs-icon-btn" title="切换深色/浅色">☀</button>' +
        '<button id="pxs-max" class="pxs-icon-btn" title="最大化 / 还原（双击标题栏亦可）">⤢</button>' +
        '<button id="pxs-close" title="关闭">✕</button>' +
      '</header>' +
      '<div id="pxs-typebar">' +
        '<span class="pxs-typebar-label">抓取类型</span>' +
        '<span class="pxs-types">' +
          '<button type="button" data-type-opt="both">插画/漫画</button>' +
          '<button type="button" data-type-opt="illust">插画</button>' +
          '<button type="button" data-type-opt="manga">漫画</button>' +
          '<button type="button" data-type-opt="novel">小说</button>' +
        '</span>' +
        '<span class="pxs-hint" id="pxs-typehint">切换后点「开始抓取」生效；小说走单独接口</span>' +
      '</div>' +
      '<div id="pxs-controls">' +
        '<label>基础间隔 <input id="pxs-interval" class="pxs-num" type="number" min="0" step="50"> ms</label>' +
        '<span id="pxs-jitter">—</span>' +
        '<label>抓取范围 第 <input id="pxs-from" class="pxs-num" type="number" min="1" max="50"> 页 — 第 <input id="pxs-to" class="pxs-num" type="number" min="1" max="50"> 页</label>' +
        '<label>每页显示 <input id="pxs-size" class="pxs-num" type="number" min="1" max="120" step="1" value="24"> 条</label>' +
        '<span class="pxs-hint">1–120，默认 24</span>' +
        '<span class="pxs-sep"></span>' +
        '<span class="pxs-filters">' +
          '<label class="pxs-check"><input id="pxs-f-r18" type="checkbox"> 屏蔽 R-18</label>' +
          '<label class="pxs-check"><input id="pxs-f-ai" type="checkbox"> 屏蔽 AI 作品</label>' +
        '</span>' +
      '</div>' +
      '<div id="pxs-settings">' +
        '<details class="pxs-guide">' +
          '<summary>使用指引</summary>' +
          '<ol>' +
            '<li>在搜索结果页打开即可：标签页（如 <code>/tags/初音ミク/artworks</code>）或搜索页（<code>/search?q=…</code>），点右下角「收藏/浏览排序」。</li>' +
            '<li>标题栏下方的「抓取类型」选插画/漫画、插画、漫画或小说；小说走单独接口，收藏数直接带上，浏览量要「补全数据」。</li>' +
            '<li>点「开始抓取」：按当前 R-18 / AI 筛选与页码范围取结果，页数越多等待越久；「每页显示」可填 1–120。</li>' +
            '<li>「设置 → 排序依据」切换收藏数 / 浏览量，切换即时重排，不重新请求。</li>' +
            '<li>若角标全是 0，说明接口没返回数值：点状态栏右侧「补全数据」，逐条补一次（缓存 7 天）。</li>' +
            '<li>下载原图：鼠标悬停缩略图，点「⬇ 原图」；多页作品会先让你选 p0…pN。</li>' +
            '<li>要存到固定文件夹：设置 → 指定文件夹 → 选择文件夹；Chrome 重启/隔一段时间后权限会过期，点「重新授权」即可，不会再默默改存到下载目录。</li>' +
            '<li>文件名规则：默认 <code>{title}_{id}</code>，可加 <code>{author}</code>、<code>{date}</code>、<code>{type}</code>、<code>{page}</code>；下方会实时显示示例，多页作品自动带 <code>_pN</code>，单页不带。</li>' +
            '<li>嫌亮就切「设置 → 界面主题 → 深色」；面板四边、四角都能拖动缩放，双击标题栏铺满屏幕。</li>' +
            '<li>铺满屏幕后嫌图小：设置 →「缩略图大小」，选预设或填自定义 px，立即生效。</li>' +
          '</ol>' +
        '</details>' +
        '<div class="pxs-sec">外观</div>' +
        '<div class="pxs-row">' +
          '<span>界面主题</span>' +
          '<span class="pxs-seg">' +
            '<button type="button" data-theme-opt="dark">深色</button>' +
            '<button type="button" data-theme-opt="light">浅色</button>' +
            '<button type="button" data-theme-opt="auto">跟随页面</button>' +
          '</span>' +
          '<span class="pxs-hint">夜间用深色更省眼；标题栏 ☀/☾ 可快速切换</span>' +
        '</div>' +
        '<div class="pxs-row">' +
          '<span>窗口大小</span>' +
          '<button id="pxs-reset-size" class="pxs-btn pxs-btn-sm">恢复默认</button>' +
          '<span class="pxs-hint">四边、四角都可拖动缩放；双击标题栏铺满屏幕，再双击还原</span>' +
        '</div>' +
        '<div class="pxs-row">' +
          '<span>缩略图大小</span>' +
          '<span class="pxs-seg" id="pxs-cardsize-seg">' +
            '<button type="button" data-card-size="0">自动</button>' +
            '<button type="button" data-card-size="120">小 120</button>' +
            '<button type="button" data-card-size="160">中 160</button>' +
            '<button type="button" data-card-size="200">大 200</button>' +
            '<button type="button" data-card-size="260">特大 260</button>' +
          '</span>' +
          '<label>自定义 <input id="pxs-cardsize" class="pxs-num" type="number" min="72" max="480" step="8"> px</label>' +
          '<span class="pxs-hint">铺满屏幕后调大更舒服，改完立即生效</span>' +
        '</div>' +
        '<div class="pxs-sec">排序与筛选</div>' +
        '<div class="pxs-row">' +
          '<span>排序依据</span>' +
          '<span class="pxs-seg">' +
            '<button id="pxs-sort-b" data-sort-opt="bookmark" data-on="1" type="button">收藏数</button>' +
            '<button id="pxs-sort-v" data-sort-opt="view" data-on="0" type="button">浏览量</button>' +
          '</span>' +
          '<span class="pxs-hint">切换后立即重排，不重新抓取</span>' +
        '</div>' +
        '<div class="pxs-row">' +
          '<label><input id="pxs-min-on" type="checkbox"> 只显示达到阈值</label>' +
          '<select id="pxs-min-key" class="pxs-sel">' +
            '<option value="bookmark">收藏数</option>' +
            '<option value="view">浏览量</option>' +
          '</select>' +
          '<span>≥</span>' +
          '<input id="pxs-min-val" class="pxs-num pxs-num-wide" type="number" min="0" step="100" value="0">' +
          '<span class="pxs-hint">数据缺失时不会误过滤，需先点「补全数据」</span>' +
        '</div>' +
        '<div class="pxs-sec">保存</div>' +
        '<div class="pxs-row">' +
          '<span>保存位置</span>' +
          '<label><input type="radio" name="pxs-sm" value="download"> Chrome 下载目录</label>' +
          '<label><input type="radio" name="pxs-sm" value="dir"> 指定文件夹（浏览器授权）</label>' +
        '</div>' +
        '<div class="pxs-row"><div id="pxs-dirbox">' +
          '<button id="pxs-pick" class="pxs-btn pxs-btn-sm">选择文件夹…</button>' +
          '<button id="pxs-auth" class="pxs-btn pxs-btn-sm" hidden>重新授权</button>' +
          '<span id="pxs-dirname" class="pxs-hint">未选择</span>' +
          '<span id="pxs-dirbadge" class="pxs-badge" data-state="warn">未选择</span>' +
        '</div></div>' +
        '<div class="pxs-row" id="pxs-dlrow">' +
          '<label>子目录 <input id="pxs-dir" type="text" placeholder="pixiv"></label>' +
          '<label><input id="pxs-ask" type="checkbox"> 每次询问保存位置</label>' +
          '<span class="pxs-hint">两种模式都生效；可写多级（如 pixiv/ntr）</span>' +
        '</div>' +
        '<div class="pxs-row">' +
          '<label>文件名 <input id="pxs-tpl" type="text" placeholder="{title}_{id}" ' +
            'title="占位：{title} {id} {author} {date} {type} {page}；扩展名自动补，多页才加 _pN"></label>' +
          '<span id="pxs-tplprev" class="pxs-hint pxs-tplprev">示例：—</span>' +
        '</div>' +
        '<div class="pxs-row">' +
          '<span>本地缓存</span>' +
          '<span id="pxs-cacheadv" class="pxs-hint">—</span>' +
          '<button id="pxs-clearcache" class="pxs-btn pxs-btn-sm">清除缓存</button>' +
          '<span class="pxs-hint">只存作品 ID 与数值，7 天过期</span>' +
        '</div>' +
      '</div>' +
      '<div id="pxs-statusbar"><span id="pxs-status">就绪</span><span class="pxs-grow"></span>' +
        '<span id="pxs-dl" hidden title="点击清零">已下载 0/0</span>' +
        '<button id="pxs-fill" hidden>补全数据</button></div>' +
      '<div id="pxs-grid"></div>' +
      '<footer id="pxs-foot">' +
        '<button id="pxs-prev" class="pxs-pg">‹</button>' +
        '<span id="pxs-pageinfo">—</span>' +
        '<button id="pxs-next" class="pxs-pg">›</button>' +
      '</footer>' +
      '<details id="pxs-logbox"><summary>日志</summary><pre id="pxs-log"></pre></details>' +
    '</section>';
  document.body.appendChild(root);

  const $ = id => root.querySelector('#' + id);
  const el = {
    fab: $('pxs-fab'), panel: $('pxs-panel'), kw: $('pxs-kw'), status: $('pxs-status'),
    grid: $('pxs-grid'), info: $('pxs-pageinfo'), prev: $('pxs-prev'), next: $('pxs-next'),
    log: $('pxs-log'), fill: $('pxs-fill'), jitter: $('pxs-jitter'),
    settings: $('pxs-settings'), dirbox: $('pxs-dirbox'), pick: $('pxs-pick'),
    auth: $('pxs-auth'), dirbadge: $('pxs-dirbadge'), dirname: $('pxs-dirname'),
    tplprev: $('pxs-tplprev'), sizesel: $('pxs-size'), cardsize: $('pxs-cardsize'),
    // 表单控件：只在 init 与少数处理器里用，集中在这里避免到处写魔法 id
    interval: $('pxs-interval'), from: $('pxs-from'), to: $('pxs-to'),
    dirInput: $('pxs-dir'), askPath: $('pxs-ask'), tpl: $('pxs-tpl'), dlrow: $('pxs-dlrow'),
  };

  function log(msg) {
    el.log.textContent += '[' + new Date().toLocaleTimeString() + '] ' + msg + '\n';
    if (el.log.textContent.length > 24000) el.log.textContent = el.log.textContent.slice(-18000);
    const box = $('pxs-logbox');
    box.scrollTop = box.scrollHeight;
  }
  const setStatus = t => { el.status.textContent = t; };

  /** 状态栏 + 日志一起更新，避免各处重复写两行 */
  function say(status, line) {
    setStatus(status);
    if (line) log(line);
  }

  /** 分段控件的统一高亮：data-on 由 data-* 属性值决定 */
  function paintSeg(selector, attr, value) {
    root.querySelectorAll(selector).forEach(b => {
      b.dataset.on = String(b.dataset[attr]) === String(value) ? '1' : '0';
    });
  }

  /** 清空结果区并复位分页提示 */
  function resetGrid() {
    el.grid.innerHTML = '';
    el.info.textContent = '—';
  }

  /** 抓取/补全任务的令牌：旧任务发现令牌过期后自行退出 */
  function nextRunId() {
    state.runId = (state.runId || 0) + 1;
    return state.runId;
  }

  /* ================= 主题 ================= */
  const THEMES = ['dark', 'light', 'auto'];

  // 跟随页面时猜测 pixiv 当前明暗：先看 data-theme 属性，再看页面背景亮度，最后看系统偏好
  function pageTheme() {
    const h = document.documentElement;
    const body = document.body;
    const attr = [
      h.getAttribute('data-theme'), h.getAttribute('theme'),
      body && body.getAttribute('data-theme'), body && body.getAttribute('theme'),
    ].join(' ').toLowerCase();
    if (attr.indexOf('dark') >= 0) return 'dark';
    if (attr.indexOf('light') >= 0) return 'light';
    for (const node of [body, h]) {
      if (!node) continue;
      let bg = '';
      try { bg = getComputedStyle(node).backgroundColor || ''; } catch (e) { continue; }
      const m = bg.match(/rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)(?:[ ,/]+([\d.]+))?/);
      if (!m) continue;
      if (m[4] !== undefined && Number(m[4]) < 0.5) continue;   // 透明说明这层没上色
      const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
      return lum < 110 ? 'dark' : 'light';
    }
    try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
  }

  function resolvedTheme() {
    if (cfg.theme === 'light') return 'light';
    if (cfg.theme === 'dark') return 'dark';
    return pageTheme();
  }

  function applyTheme() {
    const t = resolvedTheme();
    root.dataset.theme = t;
    const btn = $('pxs-theme');
    if (btn) {
      btn.textContent = t === 'dark' ? '☀' : '☾';
      btn.title = '当前：' + (cfg.theme === 'auto' ? '跟随页面（' + (t === 'dark' ? '深色' : '浅色') + '）' : (t === 'dark' ? '深色' : '浅色')) + ' · 点击切换';
    }
    root.querySelectorAll('[data-theme-opt]').forEach(b => { b.dataset.on = b.dataset.themeOpt === cfg.theme ? '1' : '0'; });
  }

  function setTheme(t) {
    cfg.theme = THEMES.indexOf(t) >= 0 ? t : 'dark';
    persist();
    applyTheme();
    log('界面主题：' + ({ dark: '深色', light: '浅色', auto: '跟随页面' })[cfg.theme]);
  }

  /* ================= 窗口尺寸 / 位置 ================= */
  function viewportMax() {
    return { w: Math.max(460, window.innerWidth - 8), h: Math.max(320, window.innerHeight - 8) };
  }

  function applyPanelFrame() {
    const p = el.panel;
    p.classList.toggle('is-max', !!cfg.panelMax);
    if (cfg.panelMax) {
      p.style.left = p.style.top = p.style.right = p.style.bottom = p.style.width = p.style.height = '';
      return;
    }
    if (cfg.panelW > 0 && cfg.panelH > 0) {
      const vm = viewportMax();
      const w = clamp(Math.round(cfg.panelW), 420, vm.w);
      const h = clamp(Math.round(cfg.panelH), 300, vm.h);
      p.style.width = w + 'px';
      p.style.height = h + 'px';
      if (cfg.panelL > 0 || cfg.panelT > 0) {
        p.style.left = clamp(Math.round(cfg.panelL), 8, Math.max(8, window.innerWidth - 200)) + 'px';
        p.style.top = clamp(Math.round(cfg.panelT), 8, Math.max(8, window.innerHeight - 120)) + 'px';
        p.style.right = 'auto';
        p.style.bottom = 'auto';
      } else {
        p.style.left = p.style.top = '';
        p.style.right = p.style.bottom = '';
      }
    } else {
      p.style.left = p.style.top = p.style.right = p.style.bottom = p.style.width = p.style.height = '';
    }
  }

  function savePanelRect(box) {
    cfg.panelW = Math.round(box.width);
    cfg.panelH = Math.round(box.height);
    cfg.panelL = Math.round(box.left);
    cfg.panelT = Math.round(box.top);
    cfg.panelMax = false;
    persist();
  }

  function beginResize(dir, ev) {
    if (ev.button !== undefined && ev.button !== 0) return;
    if (el.panel.hidden || cfg.panelMax) return;
    ev.preventDefault();
    ev.stopPropagation();
    const p = el.panel;
    const r = p.getBoundingClientRect();
    // 统一换成 left/top 锚定：往哪边拖，那条边就跟着动（另一边固定）
    p.style.left = r.left + 'px';
    p.style.top = r.top + 'px';
    p.style.right = 'auto';
    p.style.bottom = 'auto';
    p.style.width = r.width + 'px';
    p.style.height = r.height + 'px';
    p.classList.add('is-resizing');
    const MINW = 420, MINH = 300, EDGE = 4;
    const sx = ev.clientX, sy = ev.clientY;
    const s = { l: r.left, t: r.top, w: r.width, h: r.height };
    const onMove = e => {
      const dx = e.clientX - sx, dy = e.clientY - sy;
      let left = s.l, top = s.t, right = s.l + s.w, bottom = s.t + s.h;
      // 先固定另一侧，按拖拽方向移动被拖的边，再夹进可视区并保证最小尺寸
      if (dir.indexOf('w') >= 0) left = Math.max(EDGE, Math.min(s.l + dx, right - MINW));
      if (dir.indexOf('e') >= 0) right = Math.min(window.innerWidth - EDGE, Math.max(s.l + s.w + dx, left + MINW));
      if (dir.indexOf('n') >= 0) top = Math.max(EDGE, Math.min(s.t + dy, bottom - MINH));
      if (dir.indexOf('s') >= 0) bottom = Math.min(window.innerHeight - EDGE, Math.max(s.t + s.h + dy, top + MINH));
      p.style.left = left + 'px';
      p.style.top = top + 'px';
      p.style.width = (right - left) + 'px';
      p.style.height = (bottom - top) + 'px';
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      p.classList.remove('is-resizing');
      savePanelRect(p.getBoundingClientRect());
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  function toggleMax(force) {
    const next = force === undefined ? !cfg.panelMax : !!force;
    if (next === cfg.panelMax) return;
    cfg.panelMax = next;
    persist();
    applyPanelFrame();
  }

  /* ================= 下载计数 ================= */
  const dlStat = { done: 0, fail: 0, total: 0 };
  function renderDl() {
    const chip = $('pxs-dl');
    if (!chip) return;
    if (!dlStat.total) { chip.hidden = true; return; }
    chip.hidden = false;
    chip.dataset.fail = dlStat.fail ? '1' : '0';
    chip.dataset.busy = (dlStat.done + dlStat.fail < dlStat.total) ? '1' : '0';
    chip.textContent = '已下载 ' + dlStat.done + '/' + dlStat.total + (dlStat.fail ? ' · 失败 ' + dlStat.fail : '');
  }

  const updateCacheAdv = () => { $('pxs-cacheadv').textContent = '已缓存 ' + Object.keys(counts).length + ' 条'; };

  /* ================= 网络 ================= */
  function csrfToken() {
    const m = document.querySelector('meta[name="csrf-token"]');
    return (m && m.content) || '';
  }
  async function getJson(url) {
    const headers = { Accept: 'application/json' };
    const tk = csrfToken();
    if (tk) headers['x-csrf-token'] = tk;
    const res = await fetch(url, { credentials: 'include', headers, cache: 'no-store' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON，通常是被重定向到登录/错误页 */ }
    return { status: res.status, json };
  }

  // 只转发 ajax 接口认识的参数：新版搜索页的 q / type=artwork / s_mode=tag 直接照搬会 404，
  // 必须换成 word / type=all / s_mode=s_tag。
  function searchUrl(kw, p) {
    const cur = new URLSearchParams(location.search);
    const qs = new URLSearchParams();
    qs.set('word', kw);
    qs.set('p', String(p));
    qs.set('order', 'date_d');
    qs.set('s_mode', normalizeSMode(cur.get('s_mode')));
    // 小说接口没有 type 参数；插画/漫画统一取 all，再在本地按 illustType 细分
    if (!isNovel()) qs.set('type', 'all');
    qs.set('lang', 'zh');
    for (const k of ['blt', 'scd', 'ecd']) {
      const v = cur.get(k);
      if (v && v !== '0') qs.set(k, v);
    }
    if (cfg.filterR18) qs.set('mode', 'safe');
    else {
      const m = String(cur.get('mode') || '').toLowerCase();
      if (/^(all|safe|r18)$/.test(m)) qs.set('mode', m);
    }
    if (cfg.filterAI) qs.set('ai_type', '1');   // 1 = 非 AI 生成
    return (isNovel() ? '/ajax/search/novels/' : '/ajax/search/artworks/') + encodeURIComponent(kw) + '?' + qs.toString();
  }

  async function fetchPage(kw, p) {
    let backoff = 1000, lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const t0 = performance.now();
      let r = null;
      try {
        r = await getJson(searchUrl(kw, p));
        log('p' + p + ' #' + attempt + ' → ' + r.status + ' · ' + Math.round(performance.now() - t0) + 'ms');
      } catch (e) {
        lastErr = e;
        log('p' + p + ' 网络错误：' + e.message);
      }
      if (r && r.status === 200 && r.json && !r.json.error) return r;
      if (r) {
        lastErr = new Error((r.status === 429 || r.status === 403)
          ? '第 ' + p + ' 页被限流（HTTP ' + r.status + '）'
          : '第 ' + p + ' 页 HTTP ' + r.status + (r.json && r.json.message ? '：' + r.json.message : ''));
      }
      if (attempt < 3) { log('重试 ' + attempt + '/3 · ' + backoff + 'ms 后'); await sleep(backoff); backoff *= 2; }
    }
    throw lastErr || new Error('第 ' + p + ' 页抓取失败');
  }

  /* ================= 抓取 ================= */
  async function run() {
    if (state.running) { setStatus('正在抓取中…'); return; }
    const kw = currentKeyword();
    if (!kw) { setStatus('当前页面没有搜索关键词（打开 /tags/… 或 /search?q=… 再试）'); return; }

    readRange();
    cfg.interval = clamp(Number($('pxs-interval').value) || 0, 0, 60000);
    persist();
    el.jitter.textContent = '实际 ' + rangeText();

    state.running = true;
    const token = nextRunId();          // 本次任务令牌
    state.keyword = kw;
    state.items = [];
    state.shown = [];
    state.page = 1;
    resetGrid();
    el.fill.hidden = true;
    say('开始抓取 · ' + TYPE_NAME[cfg.type] + ' · ' + pageText() + ' · ' + filterText(),
      '范围 ' + pageText() + '，筛选 mode=' + (cfg.filterR18 ? 'safe' : '(未设置)') + '，ai_type=' + (cfg.filterAI ? '1' : '(未设置)'));

    const t0 = performance.now();
    try {
      const map = new Map();
      let lastPage = Infinity, total = 0;
      for (let p = cfg.pageFrom; p <= cfg.pageTo && p <= lastPage; p++) {
        if (p > cfg.pageFrom) await sleep(delay());
        if (token !== state.runId) { log('抓取已被新一轮取代，放弃旧任务'); return; }
        const r = await fetchPage(kw, p);
        if (token !== state.runId) { log('抓取已被新一轮取代，放弃旧任务'); return; }
        const body = (r.json && r.json.body) || {};
        const im = (isNovel() ? body.novel : (body.illustManga || body.illust || body.manga)) || {};
        const list = im.data || [];
        total = im.total || total;
        lastPage = im.lastPage || lastPage;
        if (!list.length) { log('p' + p + ' 空页，提前结束'); break; }
        const wantType = cfg.type === 'illust' ? 0 : cfg.type === 'manga' ? 1 : null;
        for (const it of list) {
          if (wantType !== null && it.illustType !== wantType) continue;   // 搜索接口的 type 参数不生效，本地按作品类型细分
          if (isNovel()) it.__novel = true;
          if (!map.has(String(it.id))) map.set(String(it.id), it);
        }
        setStatus('抓取中 ' + p + '/' + Math.min(cfg.pageTo, lastPage) + ' 页 · 已收 ' + map.size + ' 条');
      }

      state.items = [...map.values()];
      const first = state.items[0];
      if (first) log('字段自检：' + Object.keys(first).slice(0, 24).join(', '));
      if (token !== state.runId) return;   // 结果已过期，不覆盖新任务

      const needB = maxMetric('bookmark') === 0;
      const needV = maxMetric('view') === 0;
      const activeNeed = (cfg.sortKey === 'view' ? needV : needB) || (cfg.minEnabled && (cfg.minKey === 'view' ? needV : needB));

      rebuild();

      if (state.items.length && activeNeed) {
        log('接口未提供排序所需的数值 → 需补全数据');
        el.fill.hidden = false;
        el.fill.textContent = '补全数据（' + state.items.length + ' 次请求）';
        setStatus('缺少数值，点右侧「补全数据」后才能精确排序/过滤');
      } else if (state.items.length) {
        const empty = state.shown.length === 0;
        setStatus('完成 · ' + state.shown.length + '/' + state.items.length + ' 条 · ' + summary()
          + (empty ? ' · 阈值过滤后为空' : '') + ' · ' + ((performance.now() - t0) / 1000).toFixed(1) + 's');
      } else {
        setStatus('没有结果，检查关键词或筛选条件');
      }
    } catch (e) {
      if (token !== state.runId) return;
      say('失败：' + e.message, '中止：' + e.message);
    } finally {
      if (token === state.runId) state.running = false;   // 新一轮已接管时不要抢回 running 标志
    }
  }

  /* ================= 补全数据 ================= */
  async function fillData() {
    if (state.running) return;
    if (!state.items.length) return;
    const list = state.items.slice();
    const eta = Math.ceil(list.length * cfg.interval / 1000);
    if (!confirm('将逐个请求 ' + list.length + ' 个作品详情（一次拿到收藏数与浏览量），间隔随机在 ' + rangeText() + '。\n预计约 ' + eta + ' 秒，继续？')) return;

    state.running = true;
    const token = nextRunId();
    el.fill.disabled = true;
    let done = 0, fail = 0;
    try {
      for (const it of list) {
        if (token !== state.runId) { log('补全已被新一轮取代，停止'); return; }
        const id = String(it.id);
        const c = counts[id];
        if (c && Date.now() - c.t < COUNT_TTL) {
          it.__b = c.b || 0;
          it.__v = c.v || 0;
          done++;
          continue;
        }
        try {
          const r = await getJson((it.__novel ? '/ajax/novel/' : '/ajax/illust/') + id + '?lang=zh');
          const body = r.json && r.json.body;
          it.__b = body ? pickBookmark(body) : 0;
          it.__v = body ? pickView(body) : 0;
          counts[id] = { b: it.__b, v: it.__v, t: Date.now() };
        } catch (e) { it.__b = 0; it.__v = 0; fail++; }
        done++;
        if (done % 20 === 0) persistCounts();
        setStatus('补全数据 ' + done + '/' + list.length + (fail ? ' · 失败 ' + fail : ''));
        await sleep(delay());
      }
      persistCounts();
      pruneCounts();
      updateCacheAdv();

      const okB = list.filter(it => it.__b > 0).length;
      const okV = list.filter(it => it.__v > 0).length;
      log('补全完成：收藏数 ' + okB + '/' + list.length + '，浏览量 ' + okV + '/' + list.length);
      if (token !== state.runId) return;

      state.page = 1;
      rebuild();
      el.fill.hidden = true;
      setStatus('已按' + sortName(cfg.sortKey) + '排序 · ' + state.shown.length + '/' + state.items.length + ' 条' + (fail ? '（' + fail + ' 个失败）' : ''));
    } catch (e) {
      if (token === state.runId) setStatus('补全失败：' + e.message);
    } finally {
      if (token === state.runId) {
        state.running = false;
        el.fill.disabled = false;
      }
    }
  }

  /* ================= 目录授权 ================= */
  const IDB_STORE = 'handles';
  const DIR_KEY = 'saveDirHandle';
  const IDB_NAME = 'pxs.fs.v7';
  const IDB_LEGACY = ['pxs.fs.v6', 'pxs.fs.v4'];

  function idb() {
    try { return indexedDB; } catch (e) { return unsafeWindow && unsafeWindow.indexedDB; }
  }
  function openDB(name) {
    return new Promise((resolve, reject) => {
      const rq = idb().open(name || IDB_NAME, 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(IDB_STORE)) rq.result.createObjectStore(IDB_STORE); };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error || new Error('IndexedDB 打开失败'));
    });
  }
  async function idbSet(k, v, name) {
    const db = await openDB(name);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(v, k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGet(k, name) {
    const db = await openDB(name);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const rq = tx.objectStore(IDB_STORE).get(k);
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }

  function setDirBadge(s, handle) {
    state.dirState = s;
    el.dirbadge.dataset.state = s === 'ok' ? 'ok' : 'warn';
    el.dirbadge.textContent = s === 'ok' ? '已授权' : (s === 'none' ? '未选择' : '需重新授权');
    if (handle) el.dirname.textContent = handle.name || '(文件夹)';
    el.auth.hidden = !handle || s === 'ok';
    el.pick.textContent = handle ? '更换文件夹…' : '选择文件夹…';
  }

  function dirReady() {
    return cfg.saveMode !== 'dir' || !!(state.dirHandle && state.dirState === 'ok');
  }

  /* 文件夹没授权时把设置面板打开并高亮「重新授权」，避免静默失败 */
  function promptDirAuth(msg) {
    setStatus(msg);
    el.settings.dataset.open = '1';
    if (state.dirHandle) {
      el.auth.hidden = false;
      el.auth.classList.add('pxs-flash');
      setTimeout(() => el.auth.classList.remove('pxs-flash'), 2600);
    }
  }

  async function pickDir() {
    const w = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const fn = (w && w.showDirectoryPicker) || window.showDirectoryPicker;
    if (typeof fn !== 'function') throw new Error('当前浏览器不支持目录授权（需 Chrome / Edge 86+）');
    const handle = await fn.call(w, { id: 'pxs-save-dir', mode: 'readwrite' });
    try { await idbSet(DIR_KEY, handle); } catch (e) { log('目录句柄保存失败：' + e.message); }
    return handle;
  }

  async function writeToDir(handle, name, blob) {
    const parts = String(name).split('/').filter(Boolean);
    const fname = parts.pop();
    let dir = handle;
    for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
    const fh = await dir.getFileHandle(fname, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
  }

  /* ================= 原图下载 ================= */
  let dlChain = Promise.resolve();
  function enqueue(fn) {
    dlChain = dlChain
      .then(() => sleep(800 + Math.random() * 800))
      .then(fn)
      .catch(e => log('下载出错：' + e.message));
    return dlChain;
  }

  function queueSave(url, name) {
    if (cfg.saveMode === 'dir' && !dirReady()) {
      promptDirAuth(state.dirHandle
        ? '文件夹授权已过期：点设置里的「重新授权」再下载'
        : '指定文件夹还没选：设置 →「选择文件夹…」');
      return Promise.resolve();
    }
    dlStat.total++;
    renderDl();
    return enqueue(async () => {
      try {
        await saveImage(url, name);
        dlStat.done++;
      } catch (e) {
        dlStat.fail++;
        throw e;
      } finally {
        renderDl();
      }
    });
  }

  function pageUrl(original, page) {
    return original.replace(/_p(\d+)(\.[a-z0-9]+)$/i, (m, n, ext) => '_p' + page + ext);
  }

  /* ---- 文件命名规则 ---- */
  function sanitizeSeg(s, max) {
    return String(s == null ? '' : s)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, max || 80);
  }
  function typeTag(it) {
    if (it && it.__novel) return 'novel';
    return it && it.illustType === 1 ? 'manga' : 'illust';
  }
  function dateTag(it) {
    const d = it && it.createDate ? new Date(it.createDate) : new Date();
    if (isNaN(d.getTime())) return '';
    const j = new Date(d.getTime() + 9 * 36e5);      // pixiv 用 JST，按 +9 取日期
    const p = n => String(n).padStart(2, '0');
    return j.getUTCFullYear() + p(j.getUTCMonth() + 1) + p(j.getUTCDate());
  }
  function expandName(it, page) {
    return String(cfg.template || '{title}_{id}')
      .replace(/\{title\}/g, it.title || 'untitled')
      .replace(/\{id\}/g, it.id || '')
      .replace(/\{author\}/g, it.userName || it.author || 'unknown')
      .replace(/\{date\}/g, dateTag(it))
      .replace(/\{type\}/g, typeTag(it))
      .replace(/\{page\}/g, String(page));
  }
  function fileName(it, url, page, multipage) {
    const m = String(url).match(/\.([a-z0-9]+)(?:\?.*)?$/i);
    const ext = m ? m[1].toLowerCase() : 'jpg';
    let base = sanitizeSeg(expandName(it, page), 96);
    if (!base) base = String(it.id || 'pixiv');
    // 多页才追加 _pN；模板里自己写了 {page} 就不重复
    if (multipage && !/\{page\}/.test(cfg.template || '')) base += '_p' + page;
    return base + '.' + ext;
  }
  function dirPath() {
    const raw = String(cfg.saveDir || '').trim();
    if (!raw) return '';
    return raw.split(/[\\/]+/).map(s => sanitizeSeg(s, 40)).filter(Boolean).join('/');
  }
  function relName(name) {
    const d = dirPath();
    return d ? d + '/' + name : name;
  }
  function updateTplPreview() {
    if (!el.tplprev) return;
    const demo = { id: '123456', title: '初音ミク', userName: 'artist', createDate: '2024-05-01T00:00:00+09:00', illustType: 0 };
    const name = fileName(demo, 'https://i.pximg.net/123456_p0.jpg', 0, false);
    const line = '示例：' + relName(name);
    el.tplprev.textContent = line;
    el.tplprev.title = line;   // 窄屏被省略号截断时，悬停可看全
  }

  function fetchBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url: url, responseType: 'blob',
        headers: { Referer: 'https://www.pixiv.net/' },
        onload: r => (r.status === 200 ? resolve(r.response) : reject(new Error('HTTP ' + r.status))),
        onerror: () => reject(new Error('GM 网络错误')),
      });
    });
  }

  function anchorSave(blob, name) {
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  }

  function gmDownload(url, rel) {
    return new Promise((resolve, reject) => {
      GM_download({
        url: url, name: rel, saveAs: !!cfg.askPath,
        headers: { Referer: 'https://www.pixiv.net/' },
        onload: () => resolve(),
        onerror: () => reject(new Error('GM_download 失败')),
        ontimeout: () => reject(new Error('GM_download 超时')),
      });
    });
  }

  /* 保存分两条通道：文件夹（FileSystem Access）与浏览器下载 */
  async function saveToDir(url, rel) {
    let perm = 'prompt';
    try { perm = await state.dirHandle.queryPermission({ mode: 'readwrite' }); } catch (e) { /* 旧实现可能抛错，按未授权处理 */ }
    if (perm !== 'granted') {
      setDirBadge('prompt', state.dirHandle);
      throw new Error('文件夹未授权（设置 →「重新授权」）');
    }
    await writeToDir(state.dirHandle, rel, await fetchBlob(url));
    log('已保存到文件夹：' + rel);
  }

  async function saveToDownload(url, name, rel) {
    try {
      await gmDownload(url, rel);
      log('已下载：' + rel);
      return;
    } catch (e) { /* GM_download 不可用时落到 blob 通道 */ }
    try {
      anchorSave(await fetchBlob(url), name);
      log('已下载（blob 通道）：' + rel);
    } catch (e) {
      log('下载失败：' + e.message + ' → 新标签页打开');
      window.open(url, '_blank');
    }
  }

  async function saveImage(url, name) {
    const rel = relName(name);
    if (cfg.saveMode === 'dir') {
      if (!state.dirHandle) throw new Error('未选择保存文件夹');
      return saveToDir(url, rel);
    }
    return saveToDownload(url, name, rel);
  }

  async function startDownload(it, thumb, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      log('查询原图地址 ' + it.id);
      const r = await getJson('/ajax/illust/' + it.id + '?lang=zh');
      const body = r.json && r.json.body;
      if (!body || !body.urls || !body.urls.original) {
        throw new Error(r.status === 404 ? '作品不存在或已删除' : '拿不到原图地址（可能受限）');
      }
      const pages = body.pageCount || it.pageCount || 1;
      if (pages > 1) {
        showPicker(it, body.urls.original, pages, thumb);
        btn.textContent = '⬇ 原图';
        return;
      }
      await queueSave(pageUrl(body.urls.original, 0), fileName(it, body.urls.original, 0, pages > 1));
      btn.textContent = '⬇ 原图';
    } catch (e) {
      log('下载失败：' + e.message);
      btn.textContent = '✕ 失败';
      setTimeout(() => { btn.textContent = '⬇ 原图'; }, 2500);
    } finally {
      btn.disabled = false;
    }
  }

  function showPicker(it, original, pages, thumb) {
    if (thumb.querySelector('.pxs-picker')) return;
    const box = document.createElement('div');
    box.className = 'pxs-picker';
    const n = Math.min(pages, 30);
    for (let i = 0; i < n; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = 'p' + i;
      b.addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        box.remove();
        queueSave(pageUrl(original, i), fileName(it, original, i, true));
      });
      box.appendChild(b);
    }
    thumb.appendChild(box);
  }

  /* ================= 事件 ================= */
  function renderSortUI() {
    paintSeg('[data-sort-opt]', 'sortOpt', cfg.sortKey);
    $('pxs-min-key').value = cfg.minKey;
    $('pxs-min-on').checked = !!cfg.minEnabled;
    $('pxs-min-val').value = cfg.minValue;
  }

  function renderSaveMode() {
    const isDir = cfg.saveMode === 'dir';
    // 目录区永远可点：点「选择文件夹」会自动切到文件夹模式
    el.dirbox.style.opacity = '1';
    el.dirbox.style.pointerEvents = 'auto';
    el.dlrow.style.opacity = '1';
    el.dlrow.style.pointerEvents = 'auto';
    el.askPath.disabled = isDir;
    root.querySelectorAll('input[name="pxs-sm"]').forEach(r => { r.checked = r.value === cfg.saveMode; });
  }

  function readRange() {
    let a = clamp(Number(el.from.value) || 1, 1, 50);
    let b = clamp(Number(el.to.value) || a, 1, 50);
    if (b < a) { const t = a; a = b; b = t; }
    el.from.value = a;
    el.to.value = b;
    cfg.pageFrom = a;
    cfg.pageTo = b;
    persist();
  }

  el.interval.value = cfg.interval;
  el.from.value = cfg.pageFrom;
  el.to.value = cfg.pageTo;
  el.sizesel.value = String(clamp(Math.round(cfg.pageSize) || 24, 1, 120));
  el.dirInput.value = cfg.saveDir;
  el.askPath.checked = !!cfg.askPath;
  el.tpl.value = cfg.template;
  $('pxs-f-r18').checked = !!cfg.filterR18;
  $('pxs-f-ai').checked = !!cfg.filterAI;
  el.jitter.textContent = '实际 ' + rangeText();
  renderSortUI();
  renderSaveMode();
  renderTypeUI();
  applyCardSize();
  updateTplPreview();

  el.interval.addEventListener('change', e => {
    cfg.interval = clamp(Number(e.target.value) || 0, 0, 60000);
    persist();
    el.jitter.textContent = '实际 ' + rangeText();
  });
  el.from.addEventListener('change', readRange);
  el.to.addEventListener('change', readRange);
  el.sizesel.addEventListener('change', e => {
    cfg.pageSize = clamp(Math.round(Number(e.target.value)) || 24, 1, 120);
    e.target.value = String(cfg.pageSize);
    persist();
    state.page = 1;
    renderPage();
  });
  el.dirInput.addEventListener('input', e => { cfg.saveDir = e.target.value; persist(); updateTplPreview(); });
  el.askPath.addEventListener('change', e => { cfg.askPath = e.target.checked; persist(); });
  el.tpl.addEventListener('input', e => { cfg.template = e.target.value; persist(); updateTplPreview(); });

  function renderTypeUI() {
    paintSeg('[data-type-opt]', 'typeOpt', cfg.type);
  }
  function setType(t) {
    if (!TYPE_NAME[t] || cfg.type === t) return;
    if (state.running) { setStatus('正在抓取中，等这一轮结束再切换类型'); return; }
    cfg.type = t;
    persist();
    renderTypeUI();
    nextRunId();                    // 让任何还在跑的旧任务失效
    state.running = false;
    state.items = []; state.shown = []; state.page = 1;
    resetGrid();
    el.fill.hidden = true;
    say('已切换到「' + TYPE_NAME[t] + '」，点「开始抓取」重新获取', '抓取类型 → ' + TYPE_NAME[t]);
  }
  root.querySelectorAll('[data-type-opt]').forEach(b => b.addEventListener('click', () => setType(b.dataset.typeOpt)));

  function applyCardSize() {
    if (cfg.cardSize >= 72) root.style.setProperty('--card-w', clamp(Math.round(cfg.cardSize), 72, 480) + 'px');
    else root.style.removeProperty('--card-w');
    const cur = cfg.cardSize >= 72 ? Math.round(cfg.cardSize) : 0;
    paintSeg('[data-card-size]', 'cardSize', cur);
    if (el.cardsize) el.cardsize.value = cur ? String(cur) : '';
  }
  root.querySelectorAll('[data-card-size]').forEach(b => b.addEventListener('click', () => {
    cfg.cardSize = Number(b.dataset.cardSize) || 0;
    persist();
    applyCardSize();
    log('缩略图大小 → ' + (cfg.cardSize ? cfg.cardSize + 'px' : '自动'));
  }));
  $('pxs-cardsize').addEventListener('change', e => {
    const v = Math.round(Number(e.target.value));
    cfg.cardSize = v >= 72 ? clamp(v, 72, 480) : 0;
    persist();
    applyCardSize();
  });

  $('pxs-sort-b').addEventListener('click', () => {
    if (cfg.sortKey === 'bookmark') return;
    cfg.sortKey = 'bookmark';
    persist(); renderSortUI();
    if (state.items.length) { state.page = 1; rebuild(); setStatus('已改为按收藏数 · ' + state.shown.length + '/' + state.items.length + ' 条'); }
  });
  $('pxs-sort-v').addEventListener('click', () => {
    if (cfg.sortKey === 'view') return;
    cfg.sortKey = 'view';
    persist(); renderSortUI();
    if (!state.items.length) return;
    state.page = 1;
    rebuild();
    if (maxMetric('view') === 0) {
      el.fill.hidden = false;
      el.fill.textContent = '补全数据（' + state.items.length + ' 次请求）';
      setStatus('缺少浏览量数据，点「补全数据」后才能按浏览量排序');
    } else {
      setStatus('已改为按浏览量 · ' + state.shown.length + '/' + state.items.length + ' 条');
    }
  });

  $('pxs-min-on').addEventListener('change', e => {
    cfg.minEnabled = e.target.checked;
    persist();
    if (state.items.length) { state.page = 1; rebuild(); }
  });
  $('pxs-min-key').addEventListener('change', e => {
    cfg.minKey = e.target.value;
    persist();
    if (state.items.length) { state.page = 1; rebuild(); }
  });
  $('pxs-min-val').addEventListener('change', e => {
    cfg.minValue = Math.max(0, Number(e.target.value) || 0);
    persist();
    if (state.items.length) { state.page = 1; rebuild(); }
  });

  function onFilterChange() {
    cfg.filterR18 = $('pxs-f-r18').checked;
    cfg.filterAI = $('pxs-f-ai').checked;
    persist();
    log('筛选已改为：' + filterText() + '（需重新抓取生效）');
    if (state.items.length) setStatus('筛选已变更，点「开始抓取」重新获取');
  }
  $('pxs-f-r18').addEventListener('change', onFilterChange);
  $('pxs-f-ai').addEventListener('change', onFilterChange);

  root.querySelectorAll('input[name="pxs-sm"]').forEach(r => {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      cfg.saveMode = r.value;
      persist();
      renderSaveMode();
    });
  });

  $('pxs-pick').addEventListener('click', async () => {
    try {
      const handle = await pickDir();
      state.dirHandle = handle;
      cfg.saveMode = 'dir';
      persist();
      renderSaveMode();
      setDirBadge('ok', handle);
      log('已选择文件夹：' + (handle.name || '(未命名)'));
      setStatus('保存位置 → ' + (handle.name || '文件夹'));
    } catch (e) {
      if (e && (e.name === 'AbortError' || e.code === 20)) { setStatus('已取消选择文件夹'); return; }
      const msg = e && e.name === 'SecurityError'
        ? '浏览器拦截了文件夹选择，请直接点按钮（不要用脚本触发）后重试'
        : (e && e.message) || '未知错误';
      log('选择文件夹失败：' + msg);
      setStatus('选择文件夹失败：' + msg);
    }
  });

  $('pxs-auth').addEventListener('click', async () => {
    if (!state.dirHandle) return;
    try {
      const r = await state.dirHandle.requestPermission({ mode: 'readwrite' });
      setDirBadge(r === 'granted' ? 'ok' : 'prompt', state.dirHandle);
      log('重新授权：' + r);
      setStatus(r === 'granted' ? '文件夹授权已恢复，可以下载了' : '浏览器没有给授权，再点一次「重新授权」');
    } catch (e) {
      log('授权失败：' + e.message);
      setStatus('授权失败：' + e.message);
    }
  });

  $('pxs-clearcache').addEventListener('click', () => {
    const n = Object.keys(counts).length;
    counts = {};
    persistCounts();
    updateCacheAdv();
    log('已清除缓存（' + n + ' 条）');
    setStatus('本地缓存已清除');
  });

  $('pxs-dl').addEventListener('click', () => {
    dlStat.done = dlStat.fail = dlStat.total = 0;
    renderDl();
  });

  $('pxs-cfg').addEventListener('click', () => {
    const s = $('pxs-settings');
    s.dataset.open = s.dataset.open === '1' ? '0' : '1';
  });

  /* 主题与窗口尺寸 */
  $('pxs-theme').addEventListener('click', () => setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark'));
  root.querySelectorAll('[data-theme-opt]').forEach(b => {
    b.addEventListener('click', () => setTheme(b.dataset.themeOpt));
  });
  $('pxs-max').addEventListener('click', () => toggleMax());
  $('pxs-head').addEventListener('dblclick', e => {
    if (e.target.closest('button')) return;
    toggleMax();
  });
  $('pxs-reset-size').addEventListener('click', () => {
    cfg.panelW = 0; cfg.panelH = 0; cfg.panelL = 0; cfg.panelT = 0;
    cfg.panelMax = false;
    persist();
    applyPanelFrame();
    setStatus('窗口已恢复默认大小');
  });
  [['n', 'gn'], ['s', 'gs'], ['w', 'gw'], ['e', 'ge'],
   ['nw', 'gnw'], ['ne', 'gne'], ['sw', 'gsw'], ['se', 'gse']].forEach(([dir, id]) => {
    const grip = $('pxs-' + id);
    if (grip) grip.addEventListener('pointerdown', e => beginResize(dir, e));
  });
  window.addEventListener('resize', () => { if (cfg.panelW > 0) applyPanelFrame(); });
  try {
    new MutationObserver(() => { if (cfg.theme === 'auto') applyTheme(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'theme', 'class'] });
  } catch (e) { /* 老浏览器没有 MutationObserver 也不影响手动主题 */ }
  try {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (cfg.theme === 'auto') applyTheme(); });
  } catch (e) { /* Safari 老版本只有 addListener */ }

  $('pxs-run').addEventListener('click', run);
  el.fill.addEventListener('click', fillData);
  el.prev.addEventListener('click', () => { state.page--; renderPage(); });
  el.next.addEventListener('click', () => { state.page++; renderPage(); });

  function togglePanel(open) {
    el.panel.hidden = open === undefined ? !el.panel.hidden : !open;
    if (!el.panel.hidden) { applyPanelFrame(); syncKeyword(); }
  }
  el.fab.addEventListener('click', () => togglePanel());
  $('pxs-close').addEventListener('click', () => togglePanel(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') el.panel.hidden = true; });

  function syncKeyword() {
    const kw = currentKeyword();
    el.kw.textContent = kw ? '「' + kw + '」' : '非搜索页';
    el.fab.style.display = kw ? '' : 'none';
    if (!kw && !el.panel.hidden) setStatus('当前页面没有搜索关键词：打开 /tags/… 或 /search?q=…');
    return kw;
  }

  /* 恢复上次授权的文件夹（含旧版数据库迁移） */
  (async () => {
    try {
      let h = await idbGet(DIR_KEY);
      if (!h) {
        for (const legacy of IDB_LEGACY) {
          try {
            const old = await idbGet(DIR_KEY, legacy);
            if (old) { await idbSet(DIR_KEY, old); h = old; log('已沿用旧版文件夹授权'); break; }
          } catch (e) { /* 旧库不存在，跳过 */ }
        }
      }
      if (!h) { setDirBadge('none'); }
      else {
        state.dirHandle = h;
        const p = await h.queryPermission({ mode: 'readwrite' });
        setDirBadge(p === 'granted' ? 'ok' : 'prompt', h);
        log('已恢复文件夹授权（' + (h.name || '未命名') + '），状态：' + p);
      }
    } catch (e) {
      setDirBadge('none');
      log('恢复目录授权失败：' + e.message);
    }
    const pr = pruneCounts();
    updateCacheAdv();
    log('缓存检查：清理 ' + pr.removed + ' 条，剩余 ' + pr.left + ' 条');
  })();

  // SPA 路由切换：作废旧任务、清数据、更新关键词
  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    const kw = syncKeyword();
    if (cfg.theme === 'auto') applyTheme();
    if (kw !== state.keyword) {
      nextRunId();
      state.running = false;
      state.items = [];
      state.shown = [];
      state.page = 1;
      resetGrid();
      el.fill.hidden = true;
      setStatus('关键词已切换，点「开始抓取」');
    }
  }, 700);

  applyTheme();
  applyPanelFrame();
  syncKeyword();
  log('v1.2.2 已加载 · 关键词：' + (currentKeyword() || '(无)') + ' · ' + pageText() + ' · ' + filterText());
  log('首次使用：设置 → 使用指引；缺数值时点「补全数据」；右下角可拖拽缩放，设置里可切深色。');
})();
