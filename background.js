// Answer Lens background. Chrome's built-in AI can't run here, so this:
//  - opens a hidden "engine" page (engine.html) that runs the AI, so snaps
//    work with the side panel closed; on a Chrome whose hidden pages can't use
//    the AI, the side panel runs it instead (it then opens when you snap),
//  - sends it the snaps, passes its answers to the page, and saves the history,
//  - takes screenshots, reads embedded frames, and handles shortcuts and the
//    right-click menu.
import { DEFAULTS } from './js/store.js';

const MAX_HISTORY = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'al-text', title: 'Ask Answer Lens about "%s"', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'al-image', title: 'Ask Answer Lens about this picture', contexts: ['image'] });
  });
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

// ---------- where the AI runs ----------
let mode = null; // 'offscreen' | 'panel' (null = not checked yet)
chrome.storage.session.get('engineMode').then((r) => { mode = mode || r.engineMode || null; }).catch(() => {});
function setMode(m) {
  mode = m;
  chrome.storage.session.set({ engineMode: m }).catch(() => {});
}

async function engineTarget() {
  if (mode === 'panel') return 'panel';
  try {
    const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (!open.length) {
      await chrome.offscreen.createDocument({
        url: 'engine.html',
        reasons: ['BLOBS'],
        justification: 'Runs Chrome\'s built-in AI to answer snapped questions while the side panel is closed.',
      }).catch((e) => {
        if (!/single offscreen|already/i.test(String(e?.message || e))) throw e;
      });
    }
    for (let i = 0; i < 40; i++) {
      const r = await chrome.runtime.sendMessage({ type: 'al-engine-ping', target: 'offscreen' }).catch(() => null);
      if (r?.ok) {
        // This Chrome's hidden pages can't use the AI: the side panel runs it.
        setMode(r.ai === 'missing' ? 'panel' : 'offscreen');
        return mode;
      }
      await sleep(100);
    }
  } catch {}
  setMode('panel');
  return 'panel';
}

// Gives a job to the engine. Returns false if it couldn't be started.
async function dispatch(type, job) {
  const target = await engineTarget();
  const msg = { type, target, job };
  if (target === 'offscreen') {
    const r = await chrome.runtime.sendMessage(msg).catch(() => null);
    if (r?.ok) return true;
  } else {
    // The panel may still be opening.
    for (let i = 0; i < 20; i++) {
      const r = await chrome.runtime.sendMessage(msg).catch(() => null);
      if (r?.ok) return true;
      await sleep(300);
    }
  }
  toTab(job.tabId, {
    type: 'al-update', id: job.id, state: 'error', fresh: job.source === 'menu',
    error: target === 'panel'
      ? 'Open the Answer Lens panel (click its icon in the toolbar). On this Chrome the AI only runs there.'
      : 'The AI didn\'t start. Open the Answer Lens panel to see why.',
  });
  return false;
}

function toTab(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

// ---------- jobs ----------
async function startSnap(msg, tab) {
  const settings = await getSettings();
  if (!settings.enabled) return { error: 'Answer Lens is turned off. Turn it on at the top of its panel.' };
  const id = crypto.randomUUID();
  dispatch('al-engine-snap', {
    id, tabId: tab.id, windowId: tab.windowId, shots: msg.shots, detailed: !!msg.detailed, title: msg.title, host: msg.host, source: 'snap', settings,
  });
  return { id };
}

async function startExplain(id, tabId, windowId) {
  const { history = [] } = await chrome.storage.local.get('history');
  const entry = history.find((h) => h.id === id);
  if (!entry) {
    toTab(tabId, { type: 'al-update', id, state: 'error', error: 'That answer isn\'t saved, so it can\'t be explained.' });
    return;
  }
  dispatch('al-engine-explain', { id, tabId, windowId, entry, settings: await getSettings() });
}

// ---------- answers from the engine: to the page, and saved ----------
let saving = Promise.resolve();
const waitingThumbs = new Map(); // id -> thumbs that arrived before the answer was saved

function saveEntry(entry) {
  saving = saving.then(async () => {
    const { history = [] } = await chrome.storage.local.get('history');
    const i = history.findIndex((h) => h.id === entry.id);
    const { explaining, ...clean } = entry;
    if (i >= 0) history[i] = { ...history[i], ...clean };
    else history.unshift({ thumbs: waitingThumbs.get(entry.id) || [], ...clean });
    waitingThumbs.delete(entry.id);
    await chrome.storage.local.set({ history: history.slice(0, MAX_HISTORY) });
  }).catch(() => {});
}

function saveThumbs(id, thumbs) {
  saving = saving.then(async () => {
    const { history = [] } = await chrome.storage.local.get('history');
    const i = history.findIndex((h) => h.id === id);
    if (i < 0) {
      waitingThumbs.set(id, thumbs);
      return;
    }
    history[i] = { ...history[i], thumbs };
    await chrome.storage.local.set({ history });
  }).catch(() => {});
}

function onEngineUpdate(u) {
  const e = u.entry;
  toTab(u.tabId, {
    type: 'al-update', id: e.id, state: e.status, question: e.question, qtype: e.type, answer: e.answer,
    steps: e.steps, detailed: e.detailed, error: e.error, explanation: e.explanation,
    lang: e.lang || 'en', note: e.note || '', ...u.extra,
  });
  // Only finished answers are saved (and explanations once they're done).
  if ((e.status === 'done' || e.status === 'noresult') && !u.extra?.explaining) saveEntry(e);
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // From the engine (hidden page or side panel).
  if (msg?.type === 'al-engine-update') {
    onEngineUpdate(msg);
    return false;
  }
  if (msg?.type === 'al-engine-thumbs') {
    saveThumbs(msg.id, msg.thumbs);
    return false;
  }
  // "Explain" from the page's popup or the panel.
  if (msg?.type === 'al-explain') {
    startExplain(msg.id, sender.tab ? sender.tab.id : null, sender.tab ? sender.tab.windowId : msg.windowId);
    sendResponse({ ok: true });
    return false;
  }
  if (!sender.tab) return false;
  // The page's snap button. The panel only needs opening when it runs the AI;
  // it opens straight away, while Chrome still counts it as a click.
  if (msg?.type === 'al-wake') {
    if (mode === 'panel') chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
    else engineTarget(); // start the AI early, while you pick what to snap
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'al-snap') {
    startSnap(msg, sender.tab).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  // Text from the tab's embedded frames (each frame runs frametext.js).
  if (msg?.type === 'al-frame-text') {
    chrome.scripting
      .executeScript({
        target: { tabId: sender.tab.id, allFrames: true },
        func: () => (globalThis.__alCollect ? globalThis.__alCollect() : null),
      })
      .then(
        (res) => sendResponse(res.filter((x) => x.frameId !== 0 && x.result).map((x) => x.result)),
        () => sendResponse([]),
      );
    return true;
  }
  // A screenshot of what's visible in the tab.
  if (msg?.type === 'al-capture') {
    chrome.tabs
      .captureVisibleTab(sender.tab.windowId, { format: 'jpeg', quality: 85 })
      .then((dataUrl) => sendResponse({ dataUrl }), (e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  return false;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab) return;
  const how = command === 'snap-area' ? 'area' : command === 'snap-full' ? 'full' : null;
  if (!how) return;
  if (mode === 'panel') chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  startInTab(tab.id, how);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  if (mode === 'panel') chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  const settings = await getSettings();
  const id = crypto.randomUUID();
  if (!settings.enabled) {
    toTab(tab.id, { type: 'al-update', id, state: 'error', fresh: true, error: 'Answer Lens is turned off. Turn it on at the top of its panel.' });
    return;
  }
  dispatch('al-engine-snap', {
    id, tabId: tab.id, windowId: tab.windowId, source: 'menu', title: tab.title || '', host: '', settings,
    text: info.menuItemId === 'al-text' ? info.selectionText || '' : '',
    srcUrl: info.menuItemId === 'al-image' ? info.srcUrl || '' : '',
  });
});

// Tabs that were open before the extension was installed don't have the
// page script yet, so add it.
async function startInTab(tabId, how) {
  const msg = { type: 'al-start', mode: how };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['frametext.js', 'content.js'] });
      await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      // chrome:// pages and the Web Store can't be snapped.
    }
  }
}

// Start the engine when Chrome starts, so the AI is ready for the first snap.
chrome.runtime.onStartup.addListener(() => { engineTarget(); });
chrome.runtime.onInstalled.addListener(() => { engineTarget(); });
