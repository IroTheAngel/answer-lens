// Answer Lens page script: the snap button, area picker, multi-snap queue
// and the answer popup. The AI itself runs in the side panel.
(() => {
  if (window.__answerLensV2) return;
  window.__answerLensV2 = true;

  const DEFAULTS = {
    enabled: true, smartScan: true, shiftArea: true, showButton: true,
    displayTime: 3, position: 'bc', thinkHarder: false, subtle: false, pageAnswers: true,
    invisibleButton: false,
  };
  let S = { ...DEFAULTS };
  const MAX_QUEUE = 3;

  const PATHS = {
    lens: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.4 15.4 21 21"/><path d="M10.5 7.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    check: '<path d="M4 12.5 9.5 18 20 6.5"/>',
    bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2V16h5v-.2c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3z"/>',
    none: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    warn: '<path d="M12 3.5 2.5 20h19L12 3.5z"/><path d="M12 10v4M12 17v.01"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2V5z"/><path d="M4 20a2 2 0 0 0 2 2h13v-4"/>',
    spark: '<path d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8z"/><path d="M19 15l.7 1.8 1.8.7-1.8.7L19 20l-.7-1.8-1.8-.7 1.8-.7z"/>',
  };
  const svg = (n, s = 18) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[n]}</svg>`;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", system-ui, sans-serif; }
    svg { display: block; flex: none; }
    .fab {
      position: fixed; width: 50px; height: 50px; padding: 0; border: 0; border-radius: 50%;
      background: linear-gradient(135deg, #5BB0FF, #2F7FE0); color: #fff; cursor: pointer;
      box-shadow: 0 6px 18px rgba(16,35,63,.30), inset 0 0 0 2px rgba(255,255,255,.35);
      display: grid; place-items: center; touch-action: none; user-select: none;
      transition: transform .12s ease, box-shadow .2s ease;
    }
    .fab:hover { transform: scale(1.07); }
    .fab:active { transform: scale(.95); }
    .fab.queued { animation: glow 1.2s ease-in-out infinite; }
    @keyframes glow {
      0%, 100% { box-shadow: 0 0 0 3px rgba(255,159,28,.85), 0 0 14px 4px rgba(255,159,28,.45); }
      50% { box-shadow: 0 0 0 3px rgba(255,159,28,.85), 0 0 24px 9px rgba(255,159,28,.6); }
    }
    .badge {
      position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px;
      border-radius: 99px; background: #FF9F1C; color: #fff; font-size: 12px; font-weight: 800;
      display: none; place-items: center; border: 2px solid #fff;
    }
    .fab.queued .badge { display: grid; }
    .queue {
      position: fixed; display: flex; gap: 6px; align-items: flex-end; padding: 6px;
      background: #fff; border-radius: 12px; box-shadow: 0 6px 18px rgba(16,35,63,.25);
      border: 2px solid #FFE0B0;
    }
    .q-item { position: relative; border-radius: 6px; overflow: hidden; border: 1px solid #DCEEFF; display: block; }
    .q-item canvas { display: block; height: 46px; width: auto; }
    .q-x {
      position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; border-radius: 50%;
      border: 0; padding: 0; background: rgba(16,35,63,.8); color: #fff; display: grid; place-items: center; cursor: pointer;
    }
    .q-tip { font-size: 11.5px; color: #8A5A00; font-weight: 700; max-width: 120px; line-height: 1.25; padding: 0 4px 2px; }
    .overlay { position: fixed; inset: 0; cursor: crosshair; background: rgba(10,25,50,.30); }
    .overlay.dragging { background: transparent; }
    .box { position: fixed; border: 2px solid #4BA3FF; border-radius: 6px; display: none; box-shadow: 0 0 0 200vmax rgba(10,25,50,.38); }
    .hint, .note {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      background: #fff; color: #10233F; font-size: 14px; font-weight: 600;
      padding: 9px 16px; border-radius: 999px; white-space: nowrap;
      box-shadow: 0 6px 18px rgba(16,35,63,.25); pointer-events: none;
    }
    .hint b { color: #2F7FE0; }
    .note { top: auto; bottom: 84px; }
    .pop {
      position: fixed; width: 300px; overflow: auto; background: #fff; color: #10233F;
      border: 2px solid #DCEEFF; border-radius: 16px; font-size: 14px; line-height: 1.45;
      box-shadow: 0 12px 34px rgba(16,35,63,.30); max-height: 70vh;
    }
    .pop.wide { width: 400px; }
    .head {
      display: flex; align-items: center; gap: 7px; padding: 7px 6px 6px 12px;
      background: #F1F8FF; border-bottom: 1px solid #DCEEFF; cursor: move; user-select: none;
      position: sticky; top: 0; z-index: 1;
    }
    .head .hic { color: #2F7FE0; }
    .head .hic.ok { color: #2E9E5B; }
    .head .hic.bad { color: #D6455D; }
    .head .hic.none { color: #8095AE; }
    .title { font-weight: 800; flex: 1; font-size: 11.5px; color: #2F5A8A; letter-spacing: .07em; }
    .ib {
      border: 0; background: none; padding: 4px; cursor: pointer; border-radius: 8px;
      display: grid; place-items: center; color: #5B7290;
    }
    .ib:hover { background: #DCEEFF; color: #2F7FE0; }
    .body { padding: 9px 14px 12px; }
    .question { font-size: 12.5px; color: #6A819C; margin-bottom: 4px; }
    .answer { font-size: 18px; font-weight: 700; color: #0E2A4D; word-wrap: break-word; white-space: pre-wrap; }
    .muted { color: #5B7290; }
    .tog {
      margin-top: 8px; display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
      border: 1px solid #DCEEFF; background: #F7FBFF; color: #2F5A8A; font-weight: 700;
      font-size: 12.5px; padding: 3px 10px 3px 7px; border-radius: 999px;
    }
    .tog:hover { background: #DCEEFF; }
    ol, ul { margin: 6px 0 0; padding-left: 20px; }
    li { margin: 2px 0; }
    .row { display: flex; align-items: center; gap: 9px; }
    .spin { width: 18px; height: 18px; border-radius: 50%; flex: none; border: 3px solid #DCEEFF; border-top-color: #2F7FE0; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .exp { margin-top: 10px; padding-top: 8px; border-top: 1px dashed #D6E6F7; }
    .exp-h { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 800; letter-spacing: .07em; color: #9A5B00; margin-bottom: 2px; }
    .exp p { margin: 5px 0; }
    .complete { margin-top: 10px; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: #2E9E5B; }
    .nores { display: flex; gap: 10px; align-items: flex-start; color: #5B7290; }
    .nores b { color: #10233F; display: block; }
    .foot { margin-top: 8px; font-size: 11px; color: #8095AE; }

    /* Subtle mode: small faded button, one-line answer */
    .fab.subtle { width: 34px; height: 34px; opacity: .35; box-shadow: 0 2px 8px rgba(16,35,63,.18); }
    .fab.subtle:hover, .fab.subtle.queued { opacity: 1; }
    .fab.subtle svg { width: 18px; height: 18px; }
    /* Invisible button: can't be seen, but clicking its spot still works */
    .fab.ghost, .fab.ghost:hover { opacity: 0; box-shadow: none; animation: none; }
    .mini {
      position: fixed; display: flex; align-items: center; gap: 7px; max-width: 340px;
      padding: 6px 13px 6px 9px; border-radius: 999px; background: rgba(255,255,255,.9);
      color: #0E2A4D; font-size: 13px; font-weight: 700; border: 1px solid #DCEEFF;
      box-shadow: 0 4px 14px rgba(16,35,63,.18); cursor: pointer; opacity: .75;
      transition: opacity .15s; backdrop-filter: blur(6px);
    }
    .mini:hover { opacity: 1; }
    .mt { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .mi { color: #2F7FE0; display: grid; }
    .mi.ok { color: #2E9E5B; }
    .mi.bad { color: #D6455D; }
    .dot { width: 12px; height: 12px; border-radius: 50%; flex: none; border: 2px solid #DCEEFF; border-top-color: #2F7FE0; animation: spin .8s linear infinite; }
  `;

  // ---------- helpers ----------
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Next paint, but never wait long (hidden tabs don't paint).
  const frame = () => Promise.race([new Promise((r) => requestAnimationFrame(() => r())), sleep(80)]);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const alive = () => !!chrome.runtime?.id;
  const msg = (m) => chrome.runtime.sendMessage(m);

  function dataUrlToBlob(d) {
    const [head, b64] = d.split(',');
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: head.slice(5, head.indexOf(';')) });
  }

  // Everything lives in a zero-size host with a shadow root, so the page's
  // styles can't touch it and it never blocks clicks on the page.
  document.querySelectorAll('answer-lens').forEach((e) => e.remove()); // old copy after a reload
  const host = document.createElement('answer-lens');
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  root.adoptedStyleSheets = [sheet];
  const mount = () => {
    if (!alive()) {
      host.remove();
      clearInterval(mountTimer);
      return;
    }
    if (!host.isConnected) document.documentElement.appendChild(host);
  };
  const mountTimer = setInterval(mount, 3000); // some sites rebuild the page
  mount();

  // ---------- floating button ----------
  const fabSize = () => (S.subtle ? 34 : 50);
  const fab = el('button', 'fab');
  fab.innerHTML = svg('lens', 26) + '<span class="badge"></span>';
  fab.title = 'Answer Lens\nClick: snap the screen\nShift + click: select an area\nAlt + click: add to a multi-snap\nCtrl + click: full answer\nDrag: move me';
  root.append(fab);
  let fabPos = null;

  function placeFab() {
    const size = fabSize();
    const x = fabPos ? fabPos.x : 18;
    const y = fabPos ? fabPos.y : innerHeight - size - 18;
    fab.style.left = clamp(x, 6, innerWidth - size - 6) + 'px';
    fab.style.top = clamp(y, 6, innerHeight - size - 6) + 'px';
    placeQueue();
  }
  function refresh() {
    fab.style.display = S.enabled && S.showButton ? 'grid' : 'none';
    fab.classList.toggle('subtle', !!S.subtle);
    fab.classList.toggle('ghost', !!(S.subtle && S.invisibleButton));
    if (!S.enabled) {
      queue.length = 0;
      renderQueue();
      hidePop();
    }
    placeFab();
  }
  addEventListener('resize', placeFab);

  chrome.storage.local.get(['settings', 'fabPos']).then((r) => {
    S = { ...DEFAULTS, ...(r.settings || {}) };
    fabPos = r.fabPos || null;
    refresh();
  }).catch(refresh);
  chrome.storage.onChanged.addListener((ch) => {
    if (ch.settings) S = { ...DEFAULTS, ...(ch.settings.newValue || {}) };
    if (ch.fabPos) fabPos = ch.fabPos.newValue || null;
    if (ch.settings || ch.fabPos) refresh();
  });

  let press = null;
  fab.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const r = fab.getBoundingClientRect();
    press = {
      sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false,
      shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey,
    };
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener('pointermove', (e) => {
    if (!press) return;
    const dx = e.clientX - press.sx;
    const dy = e.clientY - press.sy;
    if (!press.moved && Math.hypot(dx, dy) < 6) return;
    press.moved = true;
    fabPos = { x: press.ox + dx, y: press.oy + dy };
    placeFab();
  });
  fab.addEventListener('pointerup', () => {
    if (!press) return;
    const p = press;
    press = null;
    if (p.moved) chrome.storage.local.set({ fabPos }).catch(() => {});
    else onButton(p);
  });
  fab.addEventListener('pointercancel', () => { press = null; });

  function onButton(m) {
    if (!S.enabled || busy) return;
    msg({ type: 'al-wake' }).catch(() => {}); // opens the side panel while this still counts as a click
    if (m.alt && m.shift) return pickArea((r) => addToQueue(r), true);
    if (m.alt) return addToQueue(null);
    if (m.shift && S.shiftArea) return pickArea((r) => snap([r], false));
    if (queue.length) return sendQueue(m.ctrl);
    if (m.ctrl) return snap([null], true);
    snap([null], false);
  }

  // Shortcut / panel buttons.
  function onStart(mode) {
    if (!S.enabled) return note('Answer Lens is off. Turn it on in its panel.');
    if (busy) return;
    if (mode === 'area') pickArea((r) => snap([r], false));
    else if (queue.length) sendQueue(false);
    else snap([null], false);
  }

  // ---------- area picker ----------
  let overlay = null;
  function pickArea(done, forQueue = false) {
    if (overlay) return;
    mount();
    hidePop();
    overlay = el('div', 'overlay');
    const box = el('div', 'box');
    const hint = el('div', 'hint');
    hint.append(forQueue ? `Drag around a part to add it (${queue.length + 1}/${MAX_QUEUE})  ·  ` : 'Drag around the question  ·  ', el('b', null, 'Esc'), ' to cancel');
    overlay.append(box, hint);
    root.append(overlay);
    let start = null;
    let rect = null;
    overlay.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      start = { x: e.clientX, y: e.clientY };
      overlay.setPointerCapture(e.pointerId);
      overlay.classList.add('dragging');
      hint.style.display = 'none';
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!start) return;
      const x = Math.min(start.x, e.clientX);
      const y = Math.min(start.y, e.clientY);
      rect = { x, y, w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) };
      Object.assign(box.style, { display: 'block', left: x + 'px', top: y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
    });
    overlay.addEventListener('pointerup', () => {
      if (!start) return;
      start = null;
      if (!rect || rect.w < 12 || rect.h < 12) {
        rect = null;
        box.style.display = 'none';
        overlay.classList.remove('dragging');
        hint.style.display = '';
        return;
      }
      closeOverlay();
      done(rect);
    });
    addEventListener('keydown', onEsc, true);
  }
  function onEsc(e) {
    if (e.key === 'Escape' && overlay) {
      e.preventDefault();
      e.stopPropagation();
      closeOverlay();
    }
  }
  function closeOverlay() {
    removeEventListener('keydown', onEsc, true);
    overlay?.remove();
    overlay = null;
  }

  // ---------- capturing ----------
  let busy = false;

  // Takes a screenshot of the tab (our own UI hidden) plus the page text in the box.
  async function capture(rect) {
    host.style.visibility = 'hidden';
    await frame();
    await frame();
    await sleep(40);
    try {
      const r = await msg({ type: 'al-capture' });
      if (!r?.dataUrl) throw new Error(r?.error || 'Couldn\'t take a screenshot of this page.');
      const area = rect || { x: 0, y: 0, w: innerWidth, h: innerHeight };
      return { dataUrl: r.dataUrl, rect, vw: innerWidth, vh: innerHeight, text: textInRect(area, !rect) };
    } finally {
      host.style.visibility = '';
    }
  }

  async function snap(rects, detailed) {
    busy = true;
    try {
      const shots = [];
      for (const r of rects) shots.push(await capture(r));
      await send(shots, detailed, rects[rects.length - 1]);
    } catch (e) {
      showPop({ state: 'error', error: String(e?.message || e) });
    } finally {
      busy = false;
    }
  }

  async function send(shots, detailed, nearRect) {
    lastRect = nearRect || null;
    currentId = null;
    showPop({ state: 'thinking', detailed });
    const req = { type: 'al-snap', shots, detailed, title: document.title, host: location.host };
    let resp = null;
    const t0 = Date.now();
    // The panel may still be opening, so keep trying for a few seconds.
    while (Date.now() - t0 < 8000) {
      try {
        resp = await msg(req);
      } catch {
        resp = null;
      }
      if (resp) break;
      await sleep(400);
    }
    if (!resp) {
      showPop({ state: 'error', error: 'Open the Answer Lens panel first: click its icon in the toolbar, then snap again.' });
    } else if (resp.error) {
      showPop({ state: 'error', error: resp.error });
    } else {
      currentId = resp.id;
      render(updates.get(resp.id) || { state: 'thinking', detailed });
    }
  }

  // ---------- multi-snap queue ----------
  const queue = []; // { shot, thumb (canvas) }
  let queueBox = null;

  async function addToQueue(rect) {
    if (queue.length >= MAX_QUEUE) return note(`Up to ${MAX_QUEUE} snaps. Click the button to send them.`);
    busy = true;
    try {
      const shot = await capture(rect);
      queue.push({ shot, thumb: await thumbOf(shot) });
      renderQueue();
    } catch (e) {
      note(String(e?.message || e));
    } finally {
      busy = false;
    }
  }

  function sendQueue(detailed) {
    const shots = queue.map((q) => q.shot);
    const last = [...queue].reverse().find((q) => q.shot.rect)?.shot.rect;
    queue.length = 0;
    renderQueue();
    busy = true;
    send(shots, detailed, last).finally(() => { busy = false; });
  }

  async function thumbOf(shot) {
    const bmp = await createImageBitmap(dataUrlToBlob(shot.dataUrl));
    const k = bmp.width / shot.vw;
    const r = shot.rect || { x: 0, y: 0, w: shot.vw, h: shot.vh };
    const h = 92;
    const w = Math.max(50, Math.min(220, Math.round(h * r.w / r.h)));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(bmp, r.x * k, r.y * k, r.w * k, r.h * k, 0, 0, w, h);
    bmp.close();
    return c;
  }

  function renderQueue() {
    fab.classList.toggle('queued', queue.length > 0);
    fab.querySelector('.badge').textContent = queue.length || '';
    queueBox?.remove();
    queueBox = null;
    if (!queue.length) return;
    queueBox = el('div', 'queue');
    queue.forEach((q, i) => {
      const item = el('div', 'q-item');
      item.append(q.thumb);
      const x = el('button', 'q-x');
      x.title = 'Remove';
      x.innerHTML = svg('x', 12);
      x.addEventListener('click', () => {
        queue.splice(i, 1);
        renderQueue();
      });
      item.append(x);
      queueBox.append(item);
    });
    queueBox.append(el('div', 'q-tip', `${queue.length}/${MAX_QUEUE} · click the button to send`));
    root.append(queueBox);
    placeQueue();
  }

  function placeQueue() {
    if (!queueBox) return;
    const r = fab.getBoundingClientRect();
    queueBox.style.left = clamp(r.left, 6, Math.max(6, innerWidth - 400)) + 'px';
    if (r.top > 90) {
      queueBox.style.top = '';
      queueBox.style.bottom = innerHeight - r.top + 10 + 'px';
    } else {
      queueBox.style.bottom = '';
      queueBox.style.top = r.bottom + 10 + 'px';
    }
  }

  let noteTimer;
  function note(text) {
    root.querySelector('.note')?.remove();
    const n = el('div', 'note', text);
    root.append(n);
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => n.remove(), 2600);
  }

  // ---------- reading the page text in a box ----------
  // Real page text is more reliable for the AI than reading a picture.
  // loose = whole screen: count text that is even partly visible.
  function textInRect(r, loose = false) {
    const body = document.body || document.documentElement;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    const range = document.createRange();
    const bits = [];
    let n;
    let seen = 0;
    while ((n = walker.nextNode()) && seen < 20000) {
      seen++;
      const p = n.parentElement;
      if (!p || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
      range.selectNodeContents(n);
      for (const b of range.getClientRects()) {
        if (!b.width || !b.height) continue;
        const cx = b.left + b.width / 2;
        const cy = b.top + b.height / 2;
        const inside = loose
          ? b.right > r.x && b.left < r.x + r.w && b.bottom > r.y && b.top < r.y + r.h
          : cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
        if (inside) {
          const cs = getComputedStyle(p);
          if (cs.visibility === 'hidden' || cs.opacity === '0') break;
          bits.push({ t: n.nodeValue.replace(/\s+/g, ' ').trim(), top: b.top, left: b.left, h: b.height });
          break;
        }
      }
    }
    for (const f of document.querySelectorAll('input[type=text], input:not([type]), textarea')) {
      const b = f.getBoundingClientRect();
      const cx = b.left + b.width / 2;
      const cy = b.top + b.height / 2;
      if (f.value && cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) {
        bits.push({ t: f.value.trim(), top: b.top, left: b.left, h: b.height });
      }
    }
    bits.sort((a, b) => (Math.abs(a.top - b.top) < Math.min(a.h, b.h) / 2 ? a.left - b.left : a.top - b.top));
    const lines = [];
    let last = null;
    for (const b of bits) {
      if (last && Math.abs(b.top - last.top) < Math.min(b.h, last.h) / 2) lines[lines.length - 1] += ' ' + b.t;
      else lines.push(b.t);
      last = b;
    }
    return lines.join('\n').slice(0, 4000);
  }

  // ---------- answer popup ----------
  let pop = null;
  let state = null;
  let currentId = null;
  let lastRect = null;
  let moved = false;
  let stepsOpen = false;
  let miniOpen = false; // subtle mode: the one-line answer was clicked open
  let hovering = false;
  let hideTimer = null;
  const updates = new Map();

  chrome.runtime.onMessage.addListener((m) => {
    if (m?.type === 'al-start') {
      onStart(m.mode);
    } else if (m?.type === 'al-update') {
      updates.set(m.id, m);
      if (updates.size > 20) updates.delete(updates.keys().next().value);
      if (m.fresh) {
        // A question from the right-click menu.
        currentId = m.id;
        const sel = getSelection();
        lastRect = sel?.rangeCount ? rectOf(sel.getRangeAt(0).getBoundingClientRect()) : null;
        showPop(m);
      } else if (m.id === currentId && pop) render(m);
    }
    return false;
  });

  const rectOf = (b) => (b && b.width ? { x: b.left, y: b.top, w: b.width, h: b.height } : null);

  function hidePop() {
    clearTimeout(hideTimer);
    hideTimer = null;
    pop?.remove();
    pop = null;
  }

  function showPop(u) {
    hidePop();
    if (!S.pageAnswers) {
      // Answers only show in the side panel, but still say when something's wrong.
      if (u.state === 'error') note(u.error);
      return;
    }
    mount();
    pop = el('div', 'pop');
    pop.addEventListener('mouseenter', () => {
      hovering = true;
      clearTimeout(hideTimer);
      hideTimer = null;
    });
    pop.addEventListener('mouseleave', () => {
      hovering = false;
      timer();
    });
    root.append(pop);
    moved = false;
    stepsOpen = false;
    miniOpen = false;
    hovering = false;
    render(u);
  }

  const isWide = (u) =>
    !!(u.detailed || u.explanation || u.explaining ||
      (u.qtype === 'free' && (u.answer || '').length > 70) || (u.answer || '').length > 140);

  function render(u) {
    if (!pop) return;
    state = u;
    if (S.subtle && !miniOpen) return renderMini(u);
    const wide = isWide(u);
    pop.className = 'pop' + (wide ? ' wide' : '');
    pop.onclick = null;
    pop.title = '';
    pop.textContent = '';
    const done = u.state === 'done';

    // header
    const head = el('div', 'head');
    const ic = el('span', 'hic');
    let title = 'ANSWER';
    if (u.state === 'error') { ic.innerHTML = svg('warn', 18); ic.classList.add('bad'); title = 'ANSWER LENS'; }
    else if (u.state === 'noresult') { ic.innerHTML = svg('none', 18); ic.classList.add('none'); title = 'NO RESULT'; }
    else if (done) { ic.innerHTML = svg('check', 18); ic.classList.add('ok'); }
    else ic.innerHTML = svg('spark', 18);
    head.append(ic, el('span', 'title', title + (u.detailed && u.state !== 'error' ? ' · FULL' : '')));
    if (done && u.answer) {
      const c = iconBtn('copy', 'Copy the answer');
      c.addEventListener('click', async () => {
        await copy(u.answer);
        c.innerHTML = svg('check', 16);
        setTimeout(() => { c.innerHTML = svg('copy', 16); }, 1200);
      });
      head.append(c);
      if (!u.explanation && !u.explaining) {
        const ex = iconBtn('bulb', 'Explain it step by step');
        ex.addEventListener('click', () => {
          msg({ type: 'al-explain', id: currentId }).catch(() => {});
          render({ ...state, explaining: true });
        });
        head.append(ex);
      }
    }
    const x = iconBtn('x', 'Close');
    x.addEventListener('click', hidePop);
    head.append(x);
    drag(head);

    // body
    const body = el('div', 'body');
    if (u.state === 'error') {
      body.append(el('div', null, u.error || 'Something went wrong.'));
    } else if (u.state === 'noresult') {
      const r = el('div', 'nores');
      r.innerHTML = svg('none', 26);
      const t = el('div');
      t.append(el('b', null, S.smartScan ? 'No question found' : 'No multiple-choice question found'),
        S.shiftArea ? 'Try Shift + click on the button and drag around the question.' : 'Try snapping just the question.');
      r.append(t);
      body.append(r);
    } else if (!u.answer) {
      const row = el('div', 'row');
      row.append(el('div', 'spin'), el('span', 'muted', 'Thinking…'));
      body.append(row);
    } else {
      if (wide && u.question) body.append(el('div', 'question', u.question));
      body.append(el('div', 'answer', u.answer));
      const steps = u.steps || [];
      if (steps.length) {
        if (wide || stepsOpen) {
          const ol = el('ol');
          for (const s of steps) ol.append(el('li', null, s));
          body.append(ol);
        }
        if (!wide) {
          const t = el('button', 'tog');
          t.innerHTML = svg('book', 15);
          t.append(stepsOpen ? 'Hide steps' : `Show steps (${steps.length})`);
          t.addEventListener('click', () => {
            stepsOpen = !stepsOpen;
            render(state);
          });
          body.append(t);
        }
      }
      if (u.state === 'streaming' || u.state === 'thinking') {
        const row = el('div', 'row');
        row.style.marginTop = '8px';
        row.append(el('div', 'spin'), el('span', 'muted', 'Still writing…'));
        body.append(row);
      }
      if (u.explanation || u.explaining) {
        const exp = el('div', 'exp');
        const h = el('div', 'exp-h');
        h.innerHTML = svg('bulb', 14);
        h.append('EXPLANATION');
        exp.append(h);
        if (u.explanation) appendText(exp, u.explanation);
        if (u.explaining) {
          const row = el('div', 'row');
          row.append(el('div', 'spin'), el('span', 'muted', 'Explaining…'));
          exp.append(row);
        }
        body.append(exp);
      }
      if (done && wide && !u.explaining) {
        const c = el('div', 'complete');
        c.innerHTML = svg('check', 15);
        c.append('Complete');
        body.append(c);
      }
    }
    body.append(el('div', 'foot', 'On-device AI · it can be wrong, so check it'));
    pop.append(head, body);
    if (!moved) place();
    timer();
  }

  // Subtle mode: one small line that doesn't cover the page. Click it to open.
  function renderMini(u) {
    pop.className = 'mini';
    pop.textContent = '';
    pop.title = 'Click to see the steps';
    let ic = null;
    let cls = 'mi';
    let text;
    if (u.state === 'error') {
      ic = 'warn';
      cls += ' bad';
      text = u.error || 'Something went wrong.';
    } else if (u.state === 'noresult') {
      ic = 'none';
      text = 'No question found';
    } else if (!u.answer) {
      text = 'Thinking…';
    } else {
      ic = u.state === 'done' ? 'check' : 'spark';
      if (u.state === 'done') cls += ' ok';
      text = u.answer.replace(/\s+/g, ' ');
    }
    if (ic) {
      const s = el('span', cls);
      s.innerHTML = svg(ic, 15);
      pop.append(s);
    } else pop.append(el('span', 'dot'));
    pop.append(el('span', 'mt', text));
    pop.onclick = () => {
      miniOpen = true;
      render(state);
    };
    if (!moved) place();
    timer();
  }

  // Simple Markdown for the explanation: paragraphs and lists, no HTML.
  function appendText(box, text) {
    let list = null;
    for (const raw of text.replace(/\*\*|__/g, '').replace(/\$/g, '').split('\n')) {
      const line = raw.replace(/^#+\s*/, '').trim();
      if (!line) { list = null; continue; }
      const m = line.match(/^(\d+[.)]|[-*•])\s+(.*)$/);
      if (m) {
        if (!list) {
          list = el(/\d/.test(m[1]) ? 'ol' : 'ul');
          box.append(list);
        }
        list.append(el('li', null, m[2]));
      } else {
        list = null;
        box.append(el('p', null, line));
      }
    }
  }

  function iconBtn(name, title) {
    const b = el('button', 'ib');
    b.title = title;
    b.innerHTML = svg(name, 16);
    return b;
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea');
      ta.value = text;
      root.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  // Short answers go away after the display time (hovering keeps them up).
  function timer() {
    clearTimeout(hideTimer);
    hideTimer = null;
    if (!pop || !state || hovering || stepsOpen || S.displayTime <= 0) return;
    const finished = state.state === 'done' || state.state === 'noresult';
    const mini = S.subtle && !miniOpen;
    if (!finished || (!mini && isWide(state))) return;
    hideTimer = setTimeout(hidePop, S.displayTime * 1000);
  }

  function place() {
    const W = pop.offsetWidth || 300;
    const m = 16;
    Object.assign(pop.style, { left: '', top: '', bottom: '', transform: '', maxHeight: '' });
    if (S.position === 'near' && lastRect) {
      const r = lastRect;
      const below = innerHeight - (r.y + r.h) - 18;
      const above = r.y - 18;
      pop.style.left = clamp(r.x, 8, Math.max(8, innerWidth - W - 8)) + 'px';
      if (below >= 170 || below >= above) {
        pop.style.top = r.y + r.h + 10 + 'px';
        pop.style.maxHeight = Math.max(120, below) + 'px';
      } else {
        pop.style.bottom = innerHeight - r.y + 10 + 'px';
        pop.style.maxHeight = Math.max(120, above) + 'px';
      }
      return;
    }
    const p = S.position === 'near' ? 'bc' : S.position;
    const col = p[1];
    const row = p[0];
    pop.style.left = (col === 'l' ? m : col === 'r' ? innerWidth - W - m : (innerWidth - W) / 2) + 'px';
    if (row === 't') pop.style.top = m + 'px';
    else if (row === 'b') pop.style.bottom = m + 'px';
    else {
      pop.style.top = '50%';
      pop.style.transform = 'translateY(-50%)';
    }
    pop.style.maxHeight = (row === 'm' ? innerHeight - 2 * m : innerHeight * 0.7) + 'px';
  }

  function drag(handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.ib')) return;
      const b = pop.getBoundingClientRect();
      const ox = e.clientX - b.left;
      const oy = e.clientY - b.top;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        moved = true;
        Object.assign(pop.style, {
          left: clamp(ev.clientX - ox, 0, innerWidth - 60) + 'px',
          top: clamp(ev.clientY - oy, 0, innerHeight - 40) + 'px',
          bottom: '',
          transform: '',
        });
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }
})();
