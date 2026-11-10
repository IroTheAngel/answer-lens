// Answer Lens side panel: tabs, AI status, and messages from the page.
import { ai, checkAI, setupAI, onAI, errText } from './ai.js';
import { icon } from './icons.js';
import { initAnswers, onSnap, onAsk, explain, explainLast, getHistory, clearHistory } from './answers.js';
import { initChat, openChatWith, focusChat, clearChats } from './chat.js';
import { initStudy } from './study.js';
import { initSettings, settings } from './settings.js';
import { resetSettings } from './store.js';

const $ = (s) => document.querySelector(s);

let myWindowId = null;
chrome.windows.getCurrent().then((w) => { myWindowId = w.id; }).catch(() => {});

// Static icons in panel.html: <i data-icon="name" data-size="18">
document.querySelectorAll('[data-icon]').forEach((el) => {
  el.outerHTML = icon(el.dataset.icon, +(el.dataset.size || 18));
});

// ---------- messages (listen straight away; work waits for start-up) ----------
let ready;
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const win = sender.tab ? sender.tab.windowId : msg?.windowId;
  if (myWindowId !== null && win != null && win !== myWindowId) return false;
  const reply = (p) => p.then(sendResponse, (e) => sendResponse({ error: errText(e) }));
  switch (msg?.type) {
    case 'al-snap':
      if (!sender.tab) return false;
      reply(ready.then(() => onSnap(msg, sender.tab)));
      return true;
    case 'al-ask':
      reply(ready.then(() => onAsk(msg)));
      return true;
    case 'al-explain':
      if (!sender.tab) return false;
      ready.then(() => {
        showTab('answers');
        explain(msg.id, sender.tab.id);
      });
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

// ---------- tabs ----------
export function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.querySelectorAll('.page').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// Two clicks to confirm a button that deletes things.
function confirmClick(btn, fn) {
  const html = btn.innerHTML;
  btn.addEventListener('click', async () => {
    if (!btn.classList.contains('sure')) {
      btn.classList.add('sure');
      btn.innerHTML = `${icon('warn', 16)} <span>Click again to confirm</span>`;
      setTimeout(() => { btn.classList.remove('sure'); btn.innerHTML = html; }, 3000);
      return;
    }
    btn.classList.remove('sure');
    btn.innerHTML = html;
    await fn();
  });
}

// ---------- AI status ----------
function renderStatus() {
  const box = $('#status');
  box.textContent = '';
  const card = document.createElement('div');
  card.className = 'status';
  const say = (ic, title, line, cls = '') => {
    if (cls) card.classList.add(cls);
    card.innerHTML = `<span class="st-ic">${icon(ic, 20)}</span><div class="st-txt"><b></b>${line != null ? '<p></p>' : ''}</div>`;
    card.querySelector('b').textContent = title;
    if (line != null) card.querySelector('p').textContent = line;
  };
  const txt = () => card.querySelector('.st-txt');
  switch (ai.state) {
    case 'checking':
      return;
    case 'ready':
      say('bolt', ai.mode === 'image' ? 'AI ready' : 'AI ready (text only)',
        ai.mode === 'image' ? null : 'This Chrome can\'t send pictures to the AI yet, so it reads the page text instead.', 'ok');
      break;
    case 'loading':
      say('bolt', 'Starting the AI…', null);
      break;
    case 'downloadable': {
      say('info', 'One-time setup', 'Chrome downloads its free AI model to your PC (a few GB). After that it\'s unlimited and works offline.', 'warn');
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = 'Set up the AI';
      b.addEventListener('click', () => { b.disabled = true; setupAI(); });
      txt().append(b);
      if (ai.error) txt().append(Object.assign(document.createElement('p'), { textContent: 'Last try: ' + ai.error }));
      break;
    }
    case 'downloading': {
      const pct = Math.round((ai.progress || 0) * 100);
      say('info', pct >= 100 ? 'Getting the AI ready…' : `Downloading the AI… ${pct}%`, 'Keep this panel open. You only do this once.');
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.innerHTML = `<div style="width:${pct}%"></div>`;
      txt().append(bar);
      break;
    }
    case 'missing':
      say('warn', 'This Chrome has no built-in AI', 'Update Chrome (Menu → Help → About Google Chrome), then reopen this panel.', 'bad');
      break;
    case 'unavailable':
      say('warn', 'Chrome\'s built-in AI isn\'t available', 'Open chrome://on-device-internals in a new tab to see why. It needs about 22 GB of free disk space.', 'bad');
      break;
    case 'error': {
      say('warn', 'The AI didn\'t start', ai.error, 'bad');
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = 'Try again';
      b.addEventListener('click', () => { b.disabled = true; setupAI(); });
      txt().append(b);
      break;
    }
  }
  box.append(card);
  // Hide the "AI ready" line after a moment: it only needs to be seen once.
  if (ai.state === 'ready') setTimeout(() => { if (ai.state === 'ready') box.textContent = ''; }, 2500);

  const label = {
    ready: ai.mode === 'image' ? 'Ready · reads pictures and text' : 'Ready · text only',
    downloadable: 'Not set up yet',
    downloading: 'Downloading…',
    loading: 'Starting…',
    missing: 'Not in this Chrome',
    unavailable: 'Not available on this PC',
    error: 'Error',
  }[ai.state] || '…';
  $('#ai-info').textContent = label;
}

// ---------- snapping from the panel ----------
async function startSnap(mode) {
  if (!settings().enabled) return toast('Answer Lens is off. Turn it on with the switch at the top.');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const msg = { type: 'al-start', mode };
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, msg);
    } catch {
      toast('This page can\'t be snapped. Chrome blocks extensions on its own pages and the Web Store.');
    }
  }
}

async function showShortcuts() {
  try {
    const cmds = await chrome.commands.getAll();
    const key = (n) => cmds.find((c) => c.name === n)?.shortcut || '';
    $('#k-full').textContent = key('snap-full');
    $('#k-area').textContent = key('snap-area');
    const list = $('#shortcut-list');
    list.textContent = '';
    const rows = [
      ['Snap the screen', key('snap-full') || 'not set'],
      ['Select an area', key('snap-area') || 'not set'],
      ['Button: select an area', 'Shift + click'],
      ['Button: add to a multi-snap', 'Alt + click'],
      ['Button: add an area to a multi-snap', 'Alt + Shift + click'],
      ['Button: full, detailed answer', 'Ctrl + click'],
      ['Cancel selecting', 'Esc'],
    ];
    for (const [what, k] of rows) {
      const r = document.createElement('div');
      r.className = 'kb-row';
      r.innerHTML = '<span></span><kbd></kbd>';
      r.firstChild.textContent = what;
      r.lastChild.textContent = k;
      list.append(r);
    }
  } catch {}
}

function applySettings(s) {
  $('#off-banner').hidden = s.enabled;
  document.body.classList.toggle('is-off', !s.enabled);
}

// ---------- start ----------
async function init() {
  const ctx = { settings, showTab, toast, openChatWith: (e) => openChatWith(e), history: getHistory };
  await initSettings(applySettings);
  await initAnswers(ctx);
  await initChat(ctx);
  await initStudy(ctx);

  $('#snap-screen').addEventListener('click', () => startSnap('full'));
  $('#snap-area').addEventListener('click', () => startSnap('area'));
  $('#set-explain').addEventListener('click', explainLast);
  $('#set-chat').addEventListener('click', focusChat);
  $('#set-keys').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));
  confirmClick($('#set-clear-hist'), async () => { await clearHistory(); toast('Answer history cleared.'); });
  confirmClick($('#set-clear-chats'), async () => { await clearChats(); toast('All chats deleted.'); });
  confirmClick($('#set-reset'), async () => { await resetSettings(); toast('Settings are back to normal.'); });
  $('#version').textContent = chrome.runtime.getManifest().version;

  showShortcuts();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) showShortcuts(); });
  onAI(renderStatus);
  checkAI();
}

ready = init();
