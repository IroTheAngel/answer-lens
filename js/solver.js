// Answers a snapped question with Chrome's built-in AI. No screen and no
// chrome.* APIs here, so it can run in the hidden engine page (side panel
// closed) or inside the side panel.
import { ai, session, stream, whenReady, notReadyText, errText, checkAI } from './ai.js';
import { he, checkHe, isHebrew, heReady, heNotReadyText, textToEn, matchChoice, toHe, mdToHe } from './translate.js';
import { dataUrlToBlob } from './store.js';

export const isNoResult = (e) =>
  e.type === 'none' || !e.answer || /^no (multiple[- ]choice )?question/i.test(e.answer);

const LABELS = ['QUESTION', 'TYPE', 'ANSWER', 'STEPS', 'EXPLANATION', 'WHY'];

// Splits the "ANSWER / TYPE / STEPS / QUESTION" reply into parts (any order).
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
export async function crop(dataUrl, r, vw) {
  const bmp = await createImageBitmap(await dataUrlToBlob(dataUrl));
  const k = bmp.width / vw;
  const sx = r ? Math.max(0, Math.round(r.x * k)) : 0;
  const sy = r ? Math.max(0, Math.round(r.y * k)) : 0;
  const sw = r ? Math.max(1, Math.min(bmp.width - sx, Math.round(r.w * k))) : bmp.width;
  const sh = r ? Math.max(1, Math.min(bmp.height - sy, Math.round(r.h * k))) : bmp.height;
  const long = Math.max(sw, sh);
  let z = 1;
  if (long < 600) z = Math.min(2.5, 600 / long);
  if (long * z > 1024) z = 1024 / long; // smaller pictures are quicker for the AI
  const c = new OffscreenCanvas(Math.max(1, Math.round(sw * z)), Math.max(1, Math.round(sh * z)));
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
  bmp.close();
  return c.convertToBlob({ type: 'image/png' });
}

// The panel may have just finished the one-time setup: look again.
async function readyNow() {
  if (!['ready', 'loading', 'checking', 'downloading'].includes(ai.state)) await checkAI();
  if (he.state !== 'ready' && he.state !== 'downloading') await checkHe();
  return whenReady();
}

// Solves one question.
//   parts: [{ blob (picture or null), text }]
//   emit(entry, extra, final): called whenever there's something new to show
export async function solve(entry, parts, s, emit, signal, fresh = false) {
  const first = fresh ? { fresh: true } : {};
  const fail = (text) => {
    entry.status = 'error';
    entry.error = text;
    emit(entry, first, true);
  };
  emit(entry, first, true);
  if (!(await readyNow())) return fail(notReadyText());

  const useImage = ai.mode === 'image' && parts.some((p) => p.blob);
  if (!useImage && !parts.some((p) => p.text.trim())) {
    return fail('I couldn\'t find any text there. Try snapping the question again.');
  }
  let intro = parts.length > 1
    ? `Here ${useImage ? 'are' : 'is the text from'} ${parts.length} snaps of the same page. Together they show the question.`
    : entry.source === 'menu' && !parts[0]?.blob
      ? 'Here is some text I selected on a web page.'
      : useImage ? 'Here is a snap of part of a web page.' : 'Here is the text from part of a web page I snapped.';
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
    // All the snaps are translated at the same time.
    const done = await Promise.all(parts.map((p) => (p.text.trim() ? textToEn(p.text) : null)));
    done.forEach((t, i) => {
      if (!t) return;
      parts[i].textEn = t.text;
      pieces.push(...t.pieces);
    });
    intro += useImage
      ? '\nThe question is in Hebrew. Read the English translation below; the picture shows the original Hebrew.'
      : '\nThe question was in Hebrew; this is an English translation.';
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
  const each = parts.length > 1 ? 1200 : 2000; // less text = the AI starts sooner
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

  const t0 = performance.now();
  try {
    const sess = await session('snap');
    let heAnswer = false; // Hebrew answer already shown?
    for await (const full of stream(sess, input, signal)) {
      const reply = parseReply(full);
      if (toHebrew) {
        entry.en = reply;
        // Show the Hebrew answer as soon as its line is finished; the steps
        // get translated at the end.
        if (!heAnswer && reply.answer && /ANSWER\s*:[^\n]*\n/i.test(full) && !isNoResult(reply)) {
          heAnswer = true;
          entry.answer = matchChoice(reply.answer, pieces) || (await toHe(reply.answer));
          entry.lang = 'he';
          entry.status = 'streaming';
          emit(entry, {}, true);
        }
        continue;
      }
      Object.assign(entry, reply);
      entry.status = 'streaming';
      emit(entry);
    }
    sess.destroy?.();
    if (toHebrew && entry.en) {
      const en = entry.en;
      entry.type = en.type;
      if (isNoResult(en)) Object.assign(entry, { answer: en.answer, steps: en.steps, question: en.question });
      else {
        // Everything left is translated at the same time.
        const [answer, question, ...steps] = await Promise.all([
          heAnswer ? entry.answer : matchChoice(en.answer, pieces) || toHe(en.answer),
          en.question ? toHe(en.question) : '',
          ...en.steps.map((st) => toHe(st)),
        ]);
        Object.assign(entry, { answer, question, steps, lang: 'he' });
      }
    }
    entry.secs = (performance.now() - t0) / 1000;
    entry.status = isNoResult(entry.en && toHebrew ? entry.en : entry) ? 'noresult' : 'done';
    emit(entry, {}, true);
  } catch (e) {
    fail(signal?.aborted ? 'Stopped, because you snapped something new.' : errText(e));
  }
}

// Explains a saved answer step by step.
export async function explain(entry, emit) {
  entry.explaining = true;
  entry.explanation = '';
  emit(entry, { explaining: true }, true);
  try {
    if (!(await readyNow())) throw new Error(notReadyText());
    const sess = await session('explain');
    // Hebrew answers keep their English version for the AI.
    const src = entry.lang === 'he' && entry.en ? entry.en : entry;
    const text = `Explain this question and how to get the answer.\nQuestion: ${src.question || '(see the picture)'}\nAnswer: ${src.answer}${src.steps?.length ? '\nShort steps: ' + src.steps.join(' ') : ''}`;
    const pic = ai.mode === 'image' && entry.thumbs?.[0] ? await dataUrlToBlob(entry.thumbs[0]) : null;
    const input = pic ? [{ role: 'user', content: [{ type: 'text', value: text }, { type: 'image', value: pic }] }] : text;
    const hebrew = entry.lang === 'he' && (await heReady());
    let full = '';
    for await (full of stream(sess, input)) {
      if (hebrew) continue; // shown once it's translated
      entry.explanation = full;
      emit(entry, { explaining: true });
    }
    sess.destroy?.();
    if (hebrew) entry.explanation = await mdToHe(full);
  } catch (e) {
    entry.explanation = '⚠ ' + errText(e);
  }
  entry.explaining = false;
  emit(entry, { explaining: false }, true);
}
