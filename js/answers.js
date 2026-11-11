// Answers tab: solves snaps from the page, keeps the history, explains answers.
import { ai, session, stream, whenReady, notReadyText, errText } from './ai.js';
import { icon } from './icons.js';
import { md, plain } from './md.js';
import { load, save, uid, toJpeg, dataUrlToBlob, timeAgo, copyText } from './store.js';
import { isHebrew, heReady, heNotReadyText, textToEn, matchChoice, toHe, mdToHe } from './translate.js';

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
    lang: entry.lang || 'en',
    note: entry.note || '',
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

  // Hebrew: the AI reads English best, so translate the question for it and
  // translate the answer back (Settings → Language → Answer language).
  const qHe = isHebrew(parts.map((p) => p.text).join('\n'));
  const wantHe = s.answerLang === 'he' || (s.answerLang !== 'en' && qHe);
  const heOk = (qHe || wantHe) && (await heReady());
  const pieces = [];
  if (qHe && heOk) {
    for (const p of parts) {
      if (!p.text.trim()) continue;
      const t = await textToEn(p.text);
      p.textEn = t.text;
      pieces.push(...t.pieces);
    }
    intro += '\nThe question is in Hebrew. Read the English translation below; the picture shows the original Hebrew.';
  }
  entry.note = (qHe || s.answerLang === 'he') && !heOk ? heNotReadyText() : '';
  const toHebrew = wantHe && heOk;

  if (parts.some((p) => (p.textEn || p.text).includes('$'))) {
    intro += '\nMaths from the page is written in LaTeX between $ signs.';
  }
  // Kept for the card's "What it read", so a missed question is easy to check.
  entry.read = parts.map((p) => p.text.trim()).filter(Boolean).join('\n—\n').slice(0, 2500);
  entry.readEn = qHe && heOk ? parts.map((p) => (p.textEn || '').trim()).filter(Boolean).join('\n—\n').slice(0, 2500) : '';

  const content = [{ type: 'text', value: intro }];
  const each = parts.length > 1 ? 2000 : 3500;
  parts.forEach((p, i) => {
    if (useImage && p.blob) content.push({ type: 'image', value: p.blob });
    const text = p.textEn || p.text;
    if (text.trim()) {
      const label = entry.source === 'menu'
        ? 'Selected text' + (p.textEn ? ', translated from Hebrew' : '')
        : `Text found in snap ${i + 1}${p.textEn ? ', translated from Hebrew' : ''} (it may be incomplete)`;
      content.push({ type: 'text', value: `${label}:\n"""\n${text.slice(0, each)}\n"""` });
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
      const reply = parseReply(full);
      if (toHebrew) {
        // Keep showing "Thinking…" until the Hebrew is ready.
        entry.en = reply;
        continue;
      }
      Object.assign(entry, reply);
      entry.status = 'streaming';
      renderCard(entry);
      if (performance.now() - lastSent > 120) {
        lastSent = performance.now();
        toTab(tabId, entry);
      }
    }
    sess.destroy?.();
    if (toHebrew && entry.en) {
      const en = entry.en;
      entry.type = en.type;
      if (isNoResult(en)) Object.assign(entry, { answer: en.answer, steps: en.steps, question: en.question });
      else {
        entry.answer = matchChoice(en.answer, pieces) || (await toHe(en.answer));
        entry.question = en.question ? await toHe(en.question) : '';
        entry.steps = [];
        for (const st of en.steps) entry.steps.push(await toHe(st));
        entry.lang = 'he';
      }
    }
    entry.secs = (performance.now() - t0) / 1000;
    entry.status = isNoResult(entry.en && toHebrew ? entry.en : entry) ? 'noresult' : 'done';
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
    question: plainMath((sec.QUESTION || '').trim()),
    type: (sec.TYPE || '').toLowerCase().replace(/[^a-z]/g, ''),
    answer: plainMath((sec.ANSWER ?? (cur ? '' : pre)).trim()),
    steps: (sec.STEPS || '')
      .split('\n')
      .map((l) => plainMath(l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim()))
      .filter(Boolean),
  };
}

// LaTeX like "$m = 20, \quad p = \frac{1}{2}$" shown as plain "m = 20, p = 1/2".
export function plainMath(s) {
  return String(s)
    .replace(/\$\$?([^$]*)\$\$?/g, '$1')
    .replace(/\\(?:quad|qquad|[,;:! ])/g, ' ')
    .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1/$2')
    .replace(/\\sqrt\{([^{}]*)\}/g, '√($1)')
    .replace(/\\(?:left|right|displaystyle)/g, '')
    .replace(/\\times\b/g, '×').replace(/\\cdot\b/g, '·').replace(/\\div\b/g, '÷')
    .replace(/\\(?:le|leq)\b/g, '≤').replace(/\\(?:ge|geq)\b/g, '≥').replace(/\\(?:ne|neq)\b/g, '≠')
    .replace(/\\pm\b/g, '±').replace(/\\pi\b/g, 'π').replace(/\\infty\b/g, '∞')
    .replace(/\\text\{([^{}]*)\}/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
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
    // Hebrew answers keep their English version for the AI.
    const src = entry.lang === 'he' && entry.en ? entry.en : entry;
    const text = `Explain this question and how to get the answer.\nQuestion: ${src.question || '(see the picture)'}\nAnswer: ${src.answer}${src.steps.length ? '\nShort steps: ' + src.steps.join(' ') : ''}`;
    const pic = ai.mode === 'image' && entry.thumbs[0] ? await dataUrlToBlob(entry.thumbs[0]) : null;
    const input = pic ? [{ role: 'user', content: [{ type: 'text', value: text }, { type: 'image', value: pic }] }] : text;
    const hebrew = entry.lang === 'he' && (await heReady());
    let lastSent = 0;
    let full = '';
    for await (full of stream(sess, input)) {
      if (hebrew) continue; // shown once it's translated
      entry.explanation = full;
      renderCard(entry);
      if (performance.now() - lastSent > 150) {
        lastSent = performance.now();
        toTab(tabId, entry, { explaining: true });
      }
    }
    sess.destroy?.();
    if (hebrew) entry.explanation = await mdToHe(full);
  } catch (e) {
    entry.explanation = '⚠ ' + errText(e);
  }
  entry.explaining = false;
  renderCard(entry);
  toTab(tabId, entry, { explaining: false });
  persist();
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
    for (const s of e.steps) ol.append(Object.assign(document.createElement('li'), { textContent: s, dir: 'auto' }));
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
    persist();
    renderFeed();
  }
}

export function answerText(e) {
  return plain(e.answer);
}
