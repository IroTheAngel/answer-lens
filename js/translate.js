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

export async function toEn(text) {
  if (!String(text).trim() || !isHebrew(text)) return text;
  return (await pair('he', 'en')).translate(text);
}

// Leaves maths-only text (like "m = 20, p = 1") alone: only real words are translated.
export async function toHe(text) {
  const words = String(text).replace(/\$[^$]*\$/g, '');
  if (!words.trim() || !/[A-Za-z]{3,}/.test(words)) return text;
  return (await pair('en', 'he')).translate(text);
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
  const out = [];
  for (const part of piece.split(/(\$[^$\n]*\$)/)) {
    out.push(part.startsWith('$') || !isHebrew(part) ? part : await toEn(part));
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

// Translates one line, but leaves maths ($...$) and `code` as they are.
async function lineToHe(line) {
  const parts = line.split(/(\$[^$\n]+\$|`[^`\n]+`)/);
  const out = [];
  for (const p of parts) {
    if (!p || p.startsWith('$') || p.startsWith('`') || !/[A-Za-z]/.test(p)) out.push(p);
    else {
      const lead = p.match(/^\s*/)[0];
      const trail = p.match(/\s*$/)[0];
      out.push(lead + (await toHe(p.trim())) + trail);
    }
  }
  return out.join('');
}

// Markdown to Hebrew, line by line: keeps headings, list marks and code blocks.
export async function mdToHe(md) {
  const out = [];
  let code = false;
  for (const line of String(md).split('\n')) {
    if (/^\s*```/.test(line)) {
      code = !code;
      out.push(line);
      continue;
    }
    if (code || !/[A-Za-z]/.test(line)) {
      out.push(line);
      continue;
    }
    const m = line.match(/^(\s*(?:#{1,4}\s+|\d+[.)]\s+|[-*•]\s+)?)(.*)$/);
    out.push(m[1] + (await lineToHe(m[2].replace(/\*\*|__/g, ''))));
  }
  return out.join('\n');
}

// Page text, translated piece by piece ("a | b" pieces are answer choices).
// Returns the English text plus each piece's original and English version,
// so an English answer can be matched back to the exact Hebrew choice.
export async function textToEn(text) {
  const pieces = [];
  const lines = [];
  for (const line of String(text).split('\n')) {
    const parts = [];
    for (const piece of line.split(' | ')) {
      const en = await mixedToEn(piece);
      pieces.push({ he: piece, en });
      parts.push(en);
    }
    lines.push(parts.join(' | '));
  }
  return { text: lines.join('\n'), pieces };
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
