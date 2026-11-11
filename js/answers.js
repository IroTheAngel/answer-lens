// Answers tab: shows the history, and answers live while the engine writes
// them. The answering itself happens in the engine (js/engine.js), which
// keeps working when this panel is closed; the background saves the history.
import { icon } from './icons.js';
import { md, plain } from './md.js';
import { load, save, timeAgo, copyText } from './store.js';
import { onEngineUpdate } from './engine.js';

let history = []; // newest first: saved answers + ones being written now
let ctx; // { settings(), openChatWith(entry), showTab(name), toast(text) }
const cardEls = new Map(); // id -> element
const $ = (s) => document.querySelector(s);
const feed = () => $('#feed');

export async function initAnswers(context) {
  ctx = context;
  history = await load('history', []);
  $('#hist-search').addEventListener('input', renderFeed);
  $('#explain-last').addEventListener('click', explainLast);

  // Live answers: from the hidden engine page (runtime messages), or from
  // the engine inside this panel (local events).
  const onMsg = (m) => {
    if (m?.type === 'al-engine-update') live(m.entry, m.extra || {});
    else if (m?.type === 'al-engine-thumbs') {
      const e = history.find((x) => x.id === m.id);
      if (e) {
        e.thumbs = m.thumbs;
        renderCard(e);
      }
    }
  };
  chrome.runtime.onMessage.addListener((m) => { onMsg(m); return false; });
  onEngineUpdate(onMsg);

  // Saved answers changed (saved by the background, or deleted elsewhere).
  chrome.storage.onChanged.addListener((ch) => {
    if (!ch.history) return;
    const saved = ch.history.newValue || [];
    const ids = new Set(saved.map((e) => e.id));
    // Keep answers still being written (and errors), which aren't saved.
    const keep = history.filter((e) => !ids.has(e.id) && ['thinking', 'streaming', 'error'].includes(e.status));
    const now = new Map(history.map((e) => [e.id, e]));
    history = [...keep, ...saved.map((e) => ({ ...e, explaining: now.get(e.id)?.explaining || false }))]
      .sort((a, b) => b.time - a.time);
    renderFeed();
  });
  renderFeed();
}

export const getHistory = () => history;

export async function clearHistory() {
  history = [];
  await save('history', []);
  renderFeed();
}

function live(entry, extra) {
  let e = history.find((x) => x.id === entry.id);
  if (!e) {
    e = { thumbs: [], ...entry };
    history.unshift(e);
  } else Object.assign(e, entry);
  e.explaining = !!extra.explaining;
  if (extra.fresh) ctx.showTab('answers');
  renderCard(e);
}

// ---------- explanations (run by the engine) ----------

export function explainLast() {
  const last = history.find((e) => e.status === 'done');
  if (!last) {
    ctx.toast('Snap a question first, then I can explain it.');
    return;
  }
  ctx.showTab('answers');
  explain(last.id);
}

export function explain(id) {
  const e = history.find((x) => x.id === id);
  if (!e || e.explaining) return;
  if (!e.answer) {
    ctx.toast('There\'s no answer to explain yet.');
    return;
  }
  e.explaining = true;
  e.explanation = '';
  renderCard(e);
  cardEls.get(id)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  chrome.windows.getCurrent()
    .then((w) => chrome.runtime.sendMessage({ type: 'al-explain', id, windowId: w.id }))
    .catch(() => {});
}

// ---------- the feed ----------

function set2(root, sel, text) {
  const n = root.querySelector(sel);
  if (n) {
    n.textContent = text;
    n.dir = 'auto';
  }
}

function renderFeed() {
  const box = feed();
  const q = $('#hist-search').value.trim().toLowerCase();
  box.textContent = '';
  cardEls.clear();
  const list = q
    ? history.filter((e) => `${e.question} ${e.answer} ${e.title} ${(e.steps || []).join(' ')}`.toLowerCase().includes(q))
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
        <p class="muted">You can close this panel: snapping still works. Your answers are saved here.</p>
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
  const thumbs = e.thumbs || [];
  const steps = e.steps || [];
  const shots = thumbs.length
    ? `<div class="shots n${thumbs.length}">${thumbs.map((t) => `<img src="${t}" alt="Snapped area">`).join('')}</div>`
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
      ${steps.length ? `<details class="steps" open><summary>${icon('book', 15)} Steps (${steps.length})</summary><ol></ol></details>` : ''}
      ${busy ? '<div class="thinking small"><div class="spin"></div><span>Still writing…</span></div>' : ''}`;
  }
  const explanation = e.explanation || e.explaining
    ? `<div class="explanation"><div class="label">${icon('bulb', 15)} EXPLANATION</div><div class="md">${e.explanation ? md(e.explanation) : '<div class="thinking"><div class="spin"></div><span>Explaining…</span></div>'}</div></div>`
    : '';
  const meta = [timeAgo(e.time), e.secs ? `${e.secs.toFixed(1)} s` : '', e.source === 'menu' ? 'right-click' : thumbs.length > 1 ? `${thumbs.length} snaps` : '']
    .filter(Boolean).join(' · ');
  const actions = busy ? '' : `
    <div class="card-actions">
      <span class="meta"></span>
      ${e.answer && e.status === 'done' ? `<button class="mini" data-act="copy" title="Copy the answer">${icon('copy', 15)}</button>
      <button class="mini" data-act="explain" title="Explain step by step">${icon('bulb', 15)}</button>
      <button class="mini" data-act="chat" title="Ask about it in chat">${icon('chat', 15)}</button>` : ''}
      <button class="mini" data-act="delete" title="Delete">${icon('trash', 15)}</button>
    </div>`;
  const note = e.note && !busy ? `<div class="note-line">${icon('info', 14)}<span></span></div>` : '';
  // What Answer Lens read from the page (handy when it misses a question).
  const read = busy || e.status === 'error' ? '' : `
    <details class="read"><summary>${icon('search', 13)} What it read</summary>
      <pre class="read-text"></pre>${e.readEn ? '<div class="read-sub">In English for the AI:</div><pre class="read-en"></pre>' : ''}
    </details>`;
  el.innerHTML = `${shots}<div class="inner">${body}${note}${explanation}${read}${actions}</div>`;
  set2(el, '.read-text', e.read || 'No text on the page here, so it only had the picture.');
  set2(el, '.read-en', e.readEn || '');
  const set = (sel, text) => { const n = el.querySelector(sel); if (n) n.textContent = text; };
  set('.error span', e.error);
  set('.q', e.question);
  set('.answer', e.answer);
  set('.meta', meta);
  set('.note-line span', e.note);
  // Hebrew reads right to left.
  const rtl = e.lang === 'he';
  el.querySelectorAll('.q, .answer').forEach((n) => { n.dir = 'auto'; });
  const mdBox = el.querySelector('.explanation .md');
  if (mdBox) mdBox.dir = rtl ? 'rtl' : 'auto';
  const ol = el.querySelector('.steps ol');
  if (ol) {
    ol.dir = rtl ? 'rtl' : 'auto';
    for (const s of steps) ol.append(Object.assign(document.createElement('li'), { textContent: s, dir: 'auto' }));
  }
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
    const saved = await load('history', []);
    await save('history', saved.filter((x) => x.id !== e.id));
    renderFeed();
  }
}

export function answerText(e) {
  return plain(e.answer);
}
