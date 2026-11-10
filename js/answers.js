// Answers tab: solves snaps from the page, keeps the history, explains answers.
import { ai, session, stream, whenReady, notReadyText, errText } from './ai.js';
import { icon } from './icons.js';
import { md, plain } from './md.js';
import { load, save, uid, toJpeg, dataUrlToBlob, timeAgo, copyText } from './store.js';

const MAX_HISTORY = 150;
let history = []; // newest first
let ctx; // { settings(), openChatWith(entry), showTab(name) }
let running = null; // AbortController of the snap being answered
const cardEls = new Map(); // id -> element
const $ = (s) => document.querySelector(s);
const feed = () => $('#feed');

export async function initAnswers(context) {
  ctx = context;
  history = await load('history', []);
  $('#hist-search').addEventListener('input', renderFeed);
  $('#explain-last').addEventListener('click', explainLast);
  renderFeed();
}

export const getHistory = () => history;

export async function clearHistory() {
  running?.abort();
  history = [];
  await save('history', history);
  renderFeed();
}

function persist() {
  const keep = history.filter((e) => ['done', 'noresult'].includes(e.status)).slice(0, MAX_HISTORY);
  // Only keep finished answers, without the bulky pictures used for the AI.
  save('history', keep.map(({ parts, ...rest }) => rest));
}

// ---------- snaps ----------

// From the page: { shots: [{ dataUrl, rect, vw, text }], detailed, title, host }
export async function onSnap(msg, tab) {
  const s = ctx.settings();
  if (!s.enabled) return { error: 'Answer Lens is turned off. Turn it on at the top of its panel.' };
  const entry = newEntry({ title: msg.title, host: msg.host, detailed: !!msg.detailed, source: 'snap' });
  (async () => {
    const parts = [];
    for (const shot of msg.shots || []) {
      let blob = null;
      try {
        blob = await crop(shot.dataUrl, shot.rect, shot.vw);
      } catch {}
      parts.push({ blob, text: shot.text || '' });
    }
    entry.thumbs = await Promise.all(parts.filter((p) => p.blob).map((p) => toJpeg(p.blob, 560).catch(() => null)));
    entry.thumbs = entry.thumbs.filter(Boolean);
    renderCard(entry);
    solve(entry, parts, tab.id);
  })();
  return { id: entry.id };
}

// From the right-click menu: { text } or { srcUrl } (an image).
export async function onAsk(msg) {
  const s = ctx.settings();
  const entry = newEntry({ title: msg.pageTitle || '', host: '', detailed: false, source: 'menu' });
  if (!s.enabled) {
    fail(entry, 'Answer Lens is turned off. Turn it on at the top of its panel.', msg.tabId, true);
    return { ok: true };
  }
  ctx.showTab('answers');
  (async () => {
    const parts = [];
    if (msg.srcUrl) {
      try {
        const blob = await (await fetch(msg.srcUrl)).blob();
        const pic = await toJpeg(blob, 1400, 0.9);
        parts.push({ blob: await dataUrlToBlob(pic), text: '' });
        entry.thumbs = [await toJpeg(blob, 560)];
      } catch {
        fail(entry, 'Couldn\'t load that picture.', msg.tabId, true);
        return;
      }
    }
    if (msg.text) parts.push({ blob: null, text: msg.text });
    renderCard(entry);
    solve(entry, parts, msg.tabId, true);
  })();
  return { ok: true };
}

function newEntry(fields) {
  const entry = {
    id: uid(), time: Date.now(), question: '', type: '', answer: '', steps: [], thumbs: [],
    explanation: '', status: 'thinking', error: '', secs: 0, ...fields,
  };
  history.unshift(entry);
  renderFeed();
  return entry;
}

function toTab(tabId, entry, extra = {}) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, {
    type: 'al-update',
    id: entry.id,
    state: entry.status,
    question: entry.question,
    qtype: entry.type,
    answer: entry.answer,
    steps: entry.steps,
    detailed: entry.detailed,
    error: entry.error,
    explanation: entry.explanation,
    ...extra,
  }).catch(() => {});
}

function fail(entry, text, tabId, fresh = false) {
  entry.status = 'error';
  entry.error = text;
  renderCard(entry);
  toTab(tabId, entry, fresh ? { fresh: true } : {});
}

async function solve(entry, parts, tabId, fresh = false) {
  toTab(tabId, entry, fresh ? { fresh: true } : {});
  if (!(await whenReady())) return fail(entry, notReadyText(), tabId);

  const useImage = ai.mode === 'image' && parts.some((p) => p.blob);
  if (!useImage && !parts.some((p) => p.text.trim())) {
    return fail(entry, 'I couldn\'t find any text there. Try snapping the question again.', tabId);
  }
  const s = ctx.settings();
  let intro = parts.length > 1
    ? `Here are ${parts.length} snaps from the same page. Together they show the question.`
    : entry.source === 'menu' && !parts[0]?.blob
      ? 'Here is some text I selected on a web page.'
      : 'Here is a snap of part of a web page.';
  if (!s.smartScan) {
    intro += '\nOnly answer multiple-choice or true/false questions. If it isn\'t one, reply "TYPE: none" and "ANSWER: No multiple-choice question found".';
  }
  if (entry.detailed) intro += '\nGive a full, detailed answer with 4 to 8 steps.';
  const content = [{ type: 'text', value: intro }];
  const each = parts.length > 1 ? 2000 : 3500;
  parts.forEach((p, i) => {
    if (useImage && p.blob) content.push({ type: 'image', value: p.blob });
    if (p.text.trim()) {
      const label = entry.source === 'menu' ? 'Selected text' : `Text found in snap ${i + 1} (it may be incomplete)`;
      content.push({ type: 'text', value: `${label}:\n"""\n${p.text.slice(0, each)}\n"""` });
    }
  });
  const input = useImage ? [{ role: 'user', content }] : content.map((c) => c.value).join('\n\n');

  running?.abort();
  const ctl = new AbortController();
  running = ctl;
  const t0 = performance.now();
  let lastSent = 0;
  try {
    const sess = await session('snap');
    for await (const full of stream(sess, input, ctl.signal)) {
      Object.assign(entry, parseReply(full));
      entry.status = 'streaming';
      renderCard(entry);
      if (performance.now() - lastSent > 120) {
        lastSent = performance.now();
        toTab(tabId, entry);
      }
    }
    sess.destroy?.();
    entry.secs = (performance.now() - t0) / 1000;
    entry.status = isNoResult(entry) ? 'noresult' : 'done';
    renderCard(entry);
    toTab(tabId, entry);
    persist();
  } catch (e) {
    fail(entry, ctl.signal.aborted ? 'Stopped, because you snapped something new.' : errText(e), tabId);
  } finally {
    if (running === ctl) running = null;
  }
}

const isNoResult = (e) =>
  e.type === 'none' || !e.answer || /^no (multiple[- ]choice )?question/i.test(e.answer);

const LABELS = ['QUESTION', 'TYPE', 'ANSWER', 'STEPS', 'EXPLANATION', 'WHY'];

// Splits the "QUESTION / TYPE / ANSWER / STEPS" reply into parts.
export function parseReply(raw) {
  const lines = raw.replace(/\*\*/g, '').split('\n');
  const last = lines[lines.length - 1].trim();
  // Hide a label that is still being written ("ANSW").
  if (/^[A-Z]{1,11}$/i.test(last) && LABELS.some((l) => l.startsWith(last.toUpperCase()))) lines.pop();
  const sec = {};
  let cur = null;
  let pre = '';
  for (const line of lines) {
    const m = line.match(/^\s*#*\s*(QUESTION|TYPE|ANSWER|STEPS|EXPLANATION|WHY)\s*:\s*(.*)$/i);
    if (m) {
      cur = m[1].toUpperCase();
      if (cur === 'WHY' || cur === 'EXPLANATION') cur = 'STEPS';
      sec[cur] = sec[cur] != null ? sec[cur] + '\n' + m[2] : m[2];
    } else if (cur) sec[cur] += '\n' + line;
    else pre += line + '\n';
  }
  return {
    question: (sec.QUESTION || '').trim(),
    type: (sec.TYPE || '').toLowerCase().replace(/[^a-z]/g, ''),
    answer: (sec.ANSWER ?? (cur ? '' : pre)).trim(),
    steps: (sec.STEPS || '')
      .split('\n')
      .map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim())
      .filter(Boolean),
  };
}

// Cuts the snapped box out of the screenshot. Small boxes are enlarged so
// the AI can read them; big ones are shrunk.
async function crop(dataUrl, r, vw) {
  const bmp = await createImageBitmap(await dataUrlToBlob(dataUrl));
  const k = bmp.width / vw;
  const sx = r ? Math.max(0, Math.round(r.x * k)) : 0;
  const sy = r ? Math.max(0, Math.round(r.y * k)) : 0;
  const sw = r ? Math.max(1, Math.min(bmp.width - sx, Math.round(r.w * k))) : bmp.width;
  const sh = r ? Math.max(1, Math.min(bmp.height - sy, Math.round(r.h * k))) : bmp.height;
  const long = Math.max(sw, sh);
  let z = 1;
  if (long < 600) z = Math.min(2.5, 600 / long);
  if (long * z > 1600) z = 1600 / long;
  const c = new OffscreenCanvas(Math.max(1, Math.round(sw * z)), Math.max(1, Math.round(sh * z)));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
  bmp.close();
  return c.convertToBlob({ type: 'image/png' });
}

// ---------- explanations ----------

export function explainLast() {
  const last = history.find((e) => e.status === 'done');
  if (!last) {
    ctx.toast('Snap a question first, then I can explain it.');
    return;
  }
  ctx.showTab('answers');
  explain(last.id);
}

export async function explain(id, tabId = null) {
  const entry = history.find((e) => e.id === id);
  if (!entry || entry.explaining) return;
  if (!entry.answer) {
    ctx.toast('There\'s no answer to explain yet.');
    return;
  }
  entry.explaining = true;
  entry.explanation = '';
  renderCard(entry);
  cardEls.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  toTab(tabId, entry, { explaining: true });
  try {
    if (!(await whenReady())) throw new Error(notReadyText());
    const sess = await session('explain');
    const text = `Explain this question and how to get the answer.\nQuestion: ${entry.question || '(see the picture)'}\nAnswer: ${entry.answer}${entry.steps.length ? '\nShort steps: ' + entry.steps.join(' ') : ''}`;
    const pic = ai.mode === 'image' && entry.thumbs[0] ? await dataUrlToBlob(entry.thumbs[0]) : null;
    const input = pic ? [{ role: 'user', content: [{ type: 'text', value: text }, { type: 'image', value: pic }] }] : text;
    let lastSent = 0;
    for await (const full of stream(sess, input)) {
      entry.explanation = full;
      renderCard(entry);
      if (performance.now() - lastSent > 150) {
        lastSent = performance.now();
        toTab(tabId, entry, { explaining: true });
      }
    }
    sess.destroy?.();
  } catch (e) {
    entry.explanation = '⚠ ' + errText(e);
  }
  entry.explaining = false;
  renderCard(entry);
  toTab(tabId, entry, { explaining: false });
  persist();
}

// ---------- the feed ----------

function renderFeed() {
  const box = feed();
  const q = $('#hist-search').value.trim().toLowerCase();
  box.textContent = '';
  cardEls.clear();
  const list = q
    ? history.filter((e) => `${e.question} ${e.answer} ${e.title} ${e.steps.join(' ')}`.toLowerCase().includes(q))
    : history;
  if (!history.length) {
    box.innerHTML = `
      <div class="empty">
        <h3>How to snap</h3>
        <ul class="howto">
          <li><b>Click</b> the round button on a page: snaps the whole screen and finds the question.</li>
          <li><b>Shift + click</b>: drag a box around just the question.</li>
          <li><b>Alt + click</b>: add up to 3 snaps, then click to send them together.</li>
          <li><b>Ctrl + click</b>: a full, detailed answer.</li>
          <li><b>Right-click</b> selected text or a picture → <i>Ask Answer Lens</i>.</li>
        </ul>
        <p class="muted">Shortcuts and more options are in Settings.</p>
      </div>`;
    return;
  }
  if (!list.length) {
    box.innerHTML = '<div class="empty"><p class="muted">No answers match your search.</p></div>';
    return;
  }
  for (const e of list) {
    const el = document.createElement('article');
    el.className = 'card';
    cardEls.set(e.id, el);
    fillCard(e, el);
    box.append(el);
  }
}

function renderCard(entry) {
  const el = cardEls.get(entry.id);
  if (el) fillCard(entry, el);
  else if (!$('#hist-search').value.trim()) renderFeed();
}

function fillCard(e, el) {
  const busy = e.status === 'thinking' || e.status === 'streaming';
  const shots = e.thumbs.length
    ? `<div class="shots n${e.thumbs.length}">${e.thumbs.map((t) => `<img src="${t}" alt="Snapped area">`).join('')}</div>`
    : '';
  let body = '';
  if (e.status === 'error') {
    body = `<div class="error">${icon('warn', 18)}<span></span></div>`;
  } else if (e.status === 'noresult') {
    body = `<div class="noresult">${icon('none', 18)}<span>No question found. Try <b>Shift + click</b> and drag around the question.</span></div>`;
  } else if (!e.answer) {
    body = `<div class="thinking"><div class="spin"></div><span>Thinking…</span></div>`;
  } else {
    body = `
      ${e.question ? '<div class="q"></div>' : ''}
      <div class="label">${icon(busy ? 'spark' : 'check', 15)} ANSWER${e.detailed ? ' · FULL' : ''}</div>
      <div class="answer"></div>
      ${e.steps.length ? `<details class="steps" open><summary>${icon('book', 15)} Steps (${e.steps.length})</summary><ol></ol></details>` : ''}
      ${busy ? '<div class="thinking small"><div class="spin"></div><span>Still writing…</span></div>' : ''}`;
  }
  const explanation = e.explanation || e.explaining
    ? `<div class="explanation"><div class="label">${icon('bulb', 15)} EXPLANATION</div><div class="md">${e.explanation ? md(e.explanation) : '<div class="thinking"><div class="spin"></div><span>Explaining…</span></div>'}</div></div>`
    : '';
  const meta = [timeAgo(e.time), e.secs ? `${e.secs.toFixed(1)} s` : '', e.source === 'menu' ? 'right-click' : e.thumbs.length > 1 ? `${e.thumbs.length} snaps` : '']
    .filter(Boolean).join(' · ');
  const actions = busy ? '' : `
    <div class="card-actions">
      <span class="meta"></span>
      ${e.answer && e.status === 'done' ? `<button class="mini" data-act="copy" title="Copy the answer">${icon('copy', 15)}</button>
      <button class="mini" data-act="explain" title="Explain step by step">${icon('bulb', 15)}</button>
      <button class="mini" data-act="chat" title="Ask about it in chat">${icon('chat', 15)}</button>` : ''}
      <button class="mini" data-act="delete" title="Delete">${icon('trash', 15)}</button>
    </div>`;
  el.innerHTML = `${shots}<div class="inner">${body}${explanation}${actions}</div>`;
  const set = (sel, text) => { const n = el.querySelector(sel); if (n) n.textContent = text; };
  set('.error span', e.error);
  set('.q', e.question);
  set('.answer', e.answer);
  set('.meta', meta);
  const ol = el.querySelector('.steps ol');
  if (ol) for (const s of e.steps) ol.append(Object.assign(document.createElement('li'), { textContent: s }));
  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', (ev) => act(e, b.dataset.act, ev, b)));
}

async function act(e, what, ev, btn) {
  if (what === 'copy') {
    await copyText(e.answer);
    btn.innerHTML = icon('check', 15);
    setTimeout(() => { btn.innerHTML = icon('copy', 15); }, 1200);
  } else if (what === 'explain') {
    explain(e.id);
  } else if (what === 'chat') {
    ctx.openChatWith(e);
  } else if (what === 'delete') {
    history = history.filter((x) => x !== e);
    persist();
    renderFeed();
  }
}

export function answerText(e) {
  return plain(e.answer);
}
