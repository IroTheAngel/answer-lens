// The engine answers snaps. It normally runs in a hidden "offscreen" page
// (engine.html) so it keeps working with the side panel closed, and keeps
// the AI loaded so answers start right away. On a Chrome whose hidden pages
// can't use the AI, the side panel runs it instead.
//
// The background script sends it jobs; it sends back "al-engine-update"
// messages, which the background forwards to the page and saves, and which
// the side panel (if open) shows live.
import { ai, checkAI } from './ai.js';
import { checkHe } from './translate.js';
import { solve, explain, crop } from './solver.js';
import { toJpeg, dataUrlToBlob } from './store.js';

let role = null; // 'offscreen' | 'panel'
let running = null; // AbortController of the snap being answered
const local = new Set(); // listeners in this same page (runtime messages skip the sender)

export function onEngineUpdate(fn) {
  local.add(fn);
}

function send(m) {
  chrome.runtime.sendMessage(m).catch(() => {});
  local.forEach((f) => f(m));
}

// Throttled updates, so streaming text doesn't flood the messages.
function emitter(tabId) {
  let last = 0;
  return (entry, extra = {}, final = false) => {
    const now = performance.now();
    if (!final && now - last < 120) return;
    last = now;
    const { thumbs, ...rest } = entry; // pictures are sent once, separately
    send({ type: 'al-engine-update', tabId, entry: rest, extra });
  };
}

// accept(job): the side panel only takes jobs for tabs in its own window.
export function startEngine(who, accept = () => true) {
  role = who;
  if (role === 'offscreen') {
    checkAI();
    checkHe();
  }
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'al-engine-recheck') {
      // The panel just finished the one-time setup.
      if (role === 'offscreen') {
        checkAI();
        checkHe();
      }
      return false;
    }
    if (msg?.target !== role) return false;
    if (msg.job && !accept(msg.job)) return false;
    if (msg.type === 'al-engine-ping') {
      sendResponse({ ok: true, ai: ai.state });
    } else if (msg.type === 'al-engine-snap') {
      runSnap(msg.job);
      sendResponse({ ok: true });
    } else if (msg.type === 'al-engine-explain') {
      runExplain(msg.job);
      sendResponse({ ok: true });
    }
    return false;
  });
}

async function runSnap(job) {
  const s = job.settings;
  const entry = {
    id: job.id, time: Date.now(), title: job.title || '', host: job.host || '', detailed: !!job.detailed,
    source: job.source || 'snap', question: '', type: '', answer: '', steps: [], explanation: '',
    status: 'thinking', error: '', secs: 0,
  };
  const emit = emitter(job.tabId);
  running?.abort();
  const ctl = new AbortController();
  running = ctl;

  let parts = [];
  let thumbs = null; // Promise of the card's little pictures
  if (entry.source === 'menu') {
    if (job.srcUrl) {
      try {
        const blob = await (await fetch(job.srcUrl)).blob();
        parts.push({ blob: await dataUrlToBlob(await toJpeg(blob, 1024, 0.9)), text: '' });
        thumbs = toJpeg(blob, 560).then((t) => [t]);
      } catch {
        entry.status = 'error';
        entry.error = 'Couldn\'t load that picture.';
        emit(entry, { fresh: true }, true);
        return;
      }
    }
    if (job.text) parts.push({ blob: null, text: job.text });
  } else {
    // Reading a picture is the slowest thing the on-device AI does, so the
    // picture only goes to the AI when the page has (almost) no text there,
    // or when "Read the picture too" / Ctrl+click asks for it.
    const needsPicture = (text) => s.readPictures || entry.detailed || text.replace(/\s+/g, '').length < 15;
    parts = await Promise.all((job.shots || []).map(async (shot) => ({
      shot,
      text: shot.text || '',
      blob: needsPicture(shot.text || '') ? await crop(shot.dataUrl, shot.rect, shot.vw).catch(() => null) : null,
    })));
    thumbs = (async () => {
      const out = [];
      for (const p of parts) {
        const b = p.blob || (await crop(p.shot.dataUrl, p.shot.rect, p.shot.vw).catch(() => null));
        const j = b && (await toJpeg(b, 560).catch(() => null));
        if (j) out.push(j);
      }
      return out;
    })();
  }

  const solving = solve(entry, parts, s, emit, ctl.signal, entry.source === 'menu'); // the AI starts first…
  // …and the card's thumbnails are made while it works.
  thumbs?.then((t) => {
    if (t?.length) send({ type: 'al-engine-thumbs', id: entry.id, thumbs: t });
  }).catch(() => {});
  await solving;
  if (running === ctl) running = null;
}

async function runExplain(job) {
  const entry = { ...job.entry };
  await explain(entry, emitter(job.tabId));
}
