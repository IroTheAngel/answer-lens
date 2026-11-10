// Chrome's built-in AI (Gemini Nano). It runs on this PC: free, no limits.

export const SYSTEMS = {
  snap: `You are Answer Lens, a study helper. The user snaps part of a web page (or several parts) showing a question: a quiz, homework, a worksheet or a trivia game.
Find the question and any answer choices, then solve it.
Always reply in English, in exactly this format:
QUESTION: <the question, in one short line>
TYPE: <choice if it has answer choices or is true/false, free if it needs a written or number answer, none if there is no question>
ANSWER: <the answer. For choices, copy the correct choice exactly as written, with its letter if it has one.>
STEPS:
1. <short step>
2. <short step>
Use 2 to 5 short steps that show how to get the answer.`,
  explain: `You are a patient tutor. Explain how to solve the question step by step so a student really understands it.
Use simple words, short paragraphs and numbered steps, with Markdown (**bold**, lists).
Write maths plainly (like 3/4 or x^2) or as LaTeX between $ signs.
Finish with the final answer in bold.`,
  chat: `You are Answer Lens, a friendly and clear AI tutor and assistant inside Chrome.
Answer helpfully and correctly. Use Markdown: short paragraphs, lists, **bold** for key points and code blocks for code.
Write maths as LaTeX between $ signs. If the user sends pictures, look at them carefully.`,
  study: `You make study flashcards. Each card has a short question or term on the front ("q") and a short, correct answer on the back ("a").
Reply only with JSON.`,
};

export const THINK_NOTE = '\n\nBefore answering, think it through step by step inside <think></think> tags. Then write your final answer after the closing tag.';

const TEXT_IN = { type: 'text', languages: ['en'] };
const TEXT_OUT = [{ type: 'text', languages: ['en'] }];
const IMAGE_OPTS = { expectedInputs: [TEXT_IN, { type: 'image' }], expectedOutputs: TEXT_OUT };
const TEXT_OPTS = { expectedInputs: [TEXT_IN], expectedOutputs: TEXT_OUT };

export const ai = {
  state: 'checking', // checking | missing | unavailable | downloadable | downloading | loading | ready | error
  mode: 'image', // image = can read pictures, text = page text only
  progress: 0,
  error: '',
};

const subs = new Set();
export function onAI(fn) {
  subs.add(fn);
  fn(ai);
}
function set(patch) {
  Object.assign(ai, patch);
  subs.forEach((f) => f(ai));
}

export const errText = (e) => String(e?.message || e || 'Something went wrong.');

async function availability(opts) {
  try {
    return await LanguageModel.availability(opts);
  } catch {
    return 'unavailable';
  }
}

export async function checkAI() {
  if (!('LanguageModel' in self)) return set({ state: 'missing' });
  let mode = 'image';
  let a = await availability(IMAGE_OPTS);
  if (a === 'unavailable') {
    mode = 'text';
    a = await availability(TEXT_OPTS);
  }
  ai.mode = mode;
  if (a === 'available') {
    set({ state: 'loading' });
    warm();
  } else if (a === 'downloading') {
    set({ state: 'downloading' });
    warm(true);
  } else if (a === 'downloadable') set({ state: 'downloadable' });
  else set({ state: 'unavailable' });
}

// The first time, Chrome downloads the model. That needs a click, so the
// "Set up the AI" button calls this.
export function setupAI() {
  set({ state: 'downloading', progress: 0, error: '' });
  return warm(true);
}

async function warm(monitor = false) {
  try {
    await base('snap', monitor);
    set({ state: 'ready', error: '' });
  } catch (e) {
    set({ state: ai.state === 'downloading' ? 'downloadable' : 'error', error: errText(e) });
  }
}

let params; // sampling limits from Chrome (extensions may set temperature)
async function sampling(kind) {
  if (params === undefined) {
    try {
      params = (await LanguageModel.params()) || null;
    } catch {
      params = null;
    }
  }
  if (!params) return null;
  const precise = kind === 'snap' || kind === 'explain';
  return {
    temperature: Math.min(precise ? 0.3 : 0.8, params.maxTemperature ?? 1),
    topK: Math.max(1, Math.min(precise ? 3 : params.defaultTopK ?? 3, params.maxTopK ?? 3)),
  };
}

async function create(kind, system, monitor, history = []) {
  const opts = {
    ...(ai.mode === 'image' ? IMAGE_OPTS : TEXT_OPTS),
    initialPrompts: [{ role: 'system', content: system }, ...history],
  };
  if (monitor) {
    opts.monitor = (m) => m.addEventListener('downloadprogress', (e) => set({ state: 'downloading', progress: e.loaded }));
  }
  const s = await sampling(kind);
  if (s) {
    try {
      return await LanguageModel.create({ ...opts, ...s });
    } catch (e) {
      if (/activation|gesture/i.test(errText(e))) throw e;
      params = null; // this Chrome refused the settings: don't send them again
    }
  }
  return LanguageModel.create(opts);
}

const bases = new Map(); // one ready session per job, cloned for each use
function base(kind, monitor = false, system = SYSTEMS[kind]) {
  const key = kind + '|' + system.length;
  if (!bases.has(key)) {
    bases.set(key, create(kind, system, monitor).catch((e) => {
      bases.delete(key);
      throw e;
    }));
  }
  return bases.get(key);
}

// A fresh session for one job. With `history`, it remembers an old chat.
export async function session(kind, { history = [], system = SYSTEMS[kind] } = {}) {
  if (ai.state !== 'ready') throw new Error(notReadyText());
  if (history.length) return create(kind, system, false, history);
  return (await base(kind, false, system)).clone();
}

export function notReadyText() {
  switch (ai.state) {
    case 'downloadable': return 'One-time setup first: press "Set up the AI" in the Answer Lens panel.';
    case 'downloading':
    case 'loading':
    case 'checking': return 'The AI is still getting ready. Try again in a moment.';
    default: return 'Chrome\'s built-in AI isn\'t working here. The Answer Lens panel says why.';
  }
}

// Waits (up to 30 s) while the AI is starting.
export async function whenReady() {
  for (let i = 0; i < 150 && ['checking', 'loading'].includes(ai.state); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  return ai.state === 'ready';
}

// Newer Chrome streams small pieces; older Chrome sent the whole text so far.
function merge(full, chunk) {
  if (full.length >= 8 && chunk.length > full.length && chunk.startsWith(full)) return chunk;
  return full + chunk;
}

// Yields the whole reply so far, every time a new piece arrives.
export async function* stream(sess, input, signal) {
  let full = '';
  for await (const chunk of sess.promptStreaming(input, signal ? { signal } : undefined)) {
    full = merge(full, chunk);
    yield full;
  }
}

export async function promptJSON(sess, input, schema, signal) {
  let raw;
  try {
    raw = await sess.prompt(input, { responseConstraint: schema, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    raw = await sess.prompt(input + '\n\nReply only with JSON.', { signal });
  }
  const m = raw.match(/[[{][\s\S]*[\]}]/);
  return JSON.parse(m ? m[0] : raw);
}

export const isTooLong = (e) => /quota|too large|context|exceed|tokens/i.test(errText(e));
