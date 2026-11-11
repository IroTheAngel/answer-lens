// Hebrew support through Chrome's built-in translator (runs on this PC, free).
// The AI only understands English well, so Hebrew questions are translated to
// English first, and the answer is translated back to Hebrew.

export const he = {
  state: 'checking', // checking | missing | unavailable | downloadable | downloading | ready | error
  progress: 0,
  error: '',
};

const subs = new Set();
export function onHe(fn) {
  subs.add(fn);
  fn(he);
}
function set(patch) {
  Object.assign(he, patch);
  subs.forEach((f) => f(he));
}

const HEB = /[א-ת]/g;
const LAT = /[A-Za-z]/g;

// True when the text is mostly Hebrew.
export function isHebrew(text) {
  const t = String(text || '');
  const h = (t.match(HEB) || []).length;
  if (h < 2) return false;
  return h >= (t.match(LAT) || []).length * 0.5;
}

async function availability(s, t) {
  try {
    return await Translator.availability({ sourceLanguage: s, targetLanguage: t });
  } catch {
    return 'unavailable';
  }
}

export async function checkHe() {
  if (!('Translator' in self)) return set({ state: 'missing' });
  const both = [await availability('he', 'en'), await availability('en', 'he')];
  if (both.includes('unavailable')) set({ state: 'unavailable' });
  else if (both.every((x) => x === 'available')) set({ state: 'ready' });
  else if (both.includes('downloading')) {
    set({ state: 'downloading' });
    setupHe();
  } else set({ state: 'downloadable' });
}

// The first time, Chrome downloads the translation models. That needs a
// click, so the "Set up Hebrew" button (or "Set up the AI") calls this.
export async function setupHe() {
  if (!('Translator' in self) || he.state === 'unavailable') return false;
  set({ state: 'downloading', progress: 0, error: '' });
  try {
    await Promise.all([pair('he', 'en', true), pair('en', 'he', true)]);
    set({ state: 'ready' });
    return true;
  } catch (e) {
    set({ state: 'downloadable', error: String(e?.message || e) });
    return false;
  }
}

const pairs = new Map(); // "he>en" -> Promise<Translator>
function pair(s, t, monitor = false) {
  const key = s + '>' + t;
  if (!pairs.has(key)) {
    const opts = { sourceLanguage: s, targetLanguage: t };
    if (monitor) {
      opts.monitor = (m) => m.addEventListener('downloadprogress', (e) => set({ state: 'downloading', progress: e.loaded }));
    }
    pairs.set(key, Translator.create(opts).catch((e) => {
      pairs.delete(key);
      throw e;
    }));
  }
  return pairs.get(key);
}

// Ready to translate right now? (Never starts a download by itself.)
export async function heReady() {
  for (let i = 0; i < 25 && he.state === 'checking'; i++) await new Promise((r) => setTimeout(r, 200));
  if (he.state !== 'ready') return false;
  try {
    await Promise.all([pair('he', 'en'), pair('en', 'he')]);
    return true;
  } catch {
    return false;
  }
}

export function heNotReadyText() {
  if (he.state === 'missing' || he.state === 'unavailable') return 'This Chrome can\'t translate Hebrew, so the answer is in English.';
  if (he.state === 'downloading') return 'Hebrew is still downloading, so this answer is in English.';
  return 'Hebrew needs a one-time setup: Settings → Language → Set up Hebrew.';
}

// Remembers recent translations, so the same question or choices snapped
// again are instant.
const cache = new Map(); // "he>en|text" -> Promise<string>
function translate(s, t, text) {
  const key = `${s}>${t}|${text}`;
  if (!cache.has(key)) {
    cache.set(key, pair(s, t).then((tr) => tr.translate(text)).catch((e) => {
      cache.delete(key);
      throw e;
    }));
    if (cache.size > 800) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

export async function toEn(text) {
  if (!String(text).trim() || !isHebrew(text)) return text;
  return translate('he', 'en', text);
}

// Leaves maths-only text (like "m = 20, p = 1") alone: only real words are translated.
export async function toHe(text) {
  const words = String(text).replace(/\$[^$]*\$/g, '');
  if (!words.trim() || !/[A-Za-z]{3,}/.test(words)) return text;
  return translate('en', 'he', text);
}

const noMath = (s) => String(s).replace(/\$[^$\n]*\$/g, ' ');

// Hebrew with maths in it ($...$): short maths (like $x$) stays inside the
// sentence so the translator keeps the meaning; longer maths isn't translated.
async function mixedToEn(piece) {
  if (!isHebrew(noMath(piece))) return piece;
  const maths = piece.match(/\$[^$\n]*\$/g) || [];
  if (maths.every((m) => m.length <= 14 && !m.includes('\\'))) {
    return toEn(piece.replace(/\$([^$\n]*)\$/g, '$1'));
  }
  const out = await Promise.all(piece.split(/(\$[^$\n]*\$)/)
    .map((part) => (part.startsWith('$') || !isHebrew(part) ? part : toEn(part))));
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// Translates one line, but leaves maths ($...$) and `code` as they are.
async function lineToHe(line) {
  const out = await Promise.all(line.split(/(\$[^$\n]+\$|`[^`\n]+`)/).map(async (p) => {
    if (!p || p.startsWith('$') || p.startsWith('`') || !/[A-Za-z]/.test(p)) return p;
    const lead = p.match(/^\s*/)[0];
    const trail = p.match(/\s*$/)[0];
    return lead + (await toHe(p.trim())) + trail;
  }));
  return out.join('');
}

// Markdown to Hebrew, all lines at once: keeps headings, list marks and code blocks.
export async function mdToHe(md) {
  let code = false;
  const jobs = String(md).split('\n').map((line) => {
    if (/^\s*```/.test(line)) {
      code = !code;
      return line;
    }
    if (code || !/[A-Za-z]/.test(line)) return line;
    const m = line.match(/^(\s*(?:#{1,4}\s+|\d+[.)]\s+|[-*•]\s+)?)(.*)$/);
    return lineToHe(m[2].replace(/\*\*|__/g, '')).then((t) => m[1] + t);
  });
  return (await Promise.all(jobs)).join('\n');
}

// Page text, all pieces translated at once ("a | b" pieces are answer choices).
// Returns the English text plus each piece's original and English version,
// so an English answer can be matched back to the exact Hebrew choice.
export async function textToEn(text) {
  const rows = String(text).split('\n').map((line) => line.split(' | '));
  const en = await Promise.all(rows.map((row) => Promise.all(row.map(mixedToEn))));
  const pieces = rows.flatMap((row, i) => row.map((he, j) => ({ he, en: en[i][j] })));
  return { text: en.map((row) => row.join(' | ')).join('\n'), pieces };
}

const norm = (s) => String(s)
  .toLowerCase()
  .replace(/^\s*\(?[a-d1-4][).:]\s+/i, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

// If the English answer is one of the page's choices, give back that choice
// exactly as the page wrote it (Hebrew words, or maths like "m = 20, p = 1").
export function matchChoice(answerEn, pieces) {
  const a = norm(String(answerEn).replace(/\$/g, ''));
  if (!a) return null;
  let best = null;
  let score = 0;
  for (const p of pieces) {
    const src = p.he.replace(/\$/g, '').trim();
    if (!src || src.length > 90) continue;
    const e = norm(String(p.en).replace(/\$/g, ''));
    if (!e) continue;
    let sc = 0;
    if (e === a) sc = 3;
    else if (e.length >= 3 && a.length >= 3 && (a.includes(e) || e.includes(a))) {
      sc = 1 + Math.min(e.length, a.length) / Math.max(e.length, a.length);
    }
    if (sc > score) {
      score = sc;
      best = src;
    }
  }
  return score >= 1.5 ? best : null;
}
