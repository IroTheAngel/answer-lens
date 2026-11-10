// Study tab: flashcard sets made by the AI or from your answers.
import { session, promptJSON, whenReady, notReadyText, errText } from './ai.js';
import { icon } from './icons.js';
import { esc } from './md.js';
import { load, save, uid, timeAgo } from './store.js';
import { isHebrew, heReady, heNotReadyText, toEn, toHe } from './translate.js';

const $ = (s) => document.querySelector(s);
let ctx;
let sets = [];
let view = 'list'; // list | new | view | edit
let cur = null; // open set
let order = []; // card order in the viewer
let pos = 0;
let flipped = false;
let making = null; // AbortController while the AI makes cards

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: { q: { type: 'string' }, a: { type: 'string' } },
        required: ['q', 'a'],
      },
    },
  },
  required: ['title', 'cards'],
};

export async function initStudy(context) {
  ctx = context;
  sets = await load('sets', []);
  document.addEventListener('keydown', onKey);
  render();
}

const persist = () => save('sets', sets);
const box = () => $('#study-view');

function go(v) {
  view = v;
  render();
}

function render() {
  if (view === 'new') return renderNew();
  if (view === 'view' && cur) return renderViewer();
  if (view === 'edit' && cur) return renderEdit();
  renderList();
}

// ---------- list ----------

function renderList() {
  const b = box();
  b.innerHTML = `
    <div class="study-head">
      <h3>Study sets</h3>
      <button class="btn small" id="st-new">${icon('plus', 16)} New set</button>
    </div>
    <button class="btn-line wide" id="st-from">${icon('cards', 16)} Make flashcards from my answers</button>
    <div class="set-list"></div>`;
  b.querySelector('#st-new').addEventListener('click', () => go('new'));
  b.querySelector('#st-from').addEventListener('click', fromAnswers);
  const list = b.querySelector('.set-list');
  if (!sets.length) {
    list.innerHTML = `
      <div class="empty">
        <h3>Flashcards</h3>
        <p class="muted">Tell the AI a topic and it makes flashcards for you. Or turn the questions you've snapped into a set for revision.</p>
      </div>`;
    return;
  }
  for (const s of sets) {
    const row = document.createElement('button');
    row.className = 'set-row';
    row.innerHTML = `<span class="set-ic">${icon('cards', 20)}</span><span class="set-txt"><b dir="auto"></b><small></small></span>${icon('right', 16)}`;
    row.querySelector('b').textContent = s.title;
    row.querySelector('small').textContent = `${s.cards.length} cards · ${timeAgo(s.created)}`;
    row.addEventListener('click', () => openSet(s));
    list.append(row);
  }
}

function openSet(s) {
  cur = s;
  order = s.cards.map((_, i) => i);
  pos = 0;
  flipped = false;
  go('view');
}

function fromAnswers() {
  const done = ctx.history().filter((e) => e.status === 'done' && e.answer).slice(0, 30);
  if (!done.length) {
    ctx.toast('Snap some questions first, then turn them into flashcards.');
    return;
  }
  const set = {
    id: uid(),
    title: `My answers · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`,
    topic: 'Made from your snapped answers',
    created: Date.now(),
    cards: done.map((e) => ({ q: e.question || '(snapped question)', a: e.answer })),
  };
  sets.unshift(set);
  persist();
  openSet(set);
}

// ---------- new set ----------

function renderNew() {
  const b = box();
  b.innerHTML = `
    <div class="viewer-head">
      <button class="icon-btn" id="st-back" title="Back">${icon('left', 20)}</button>
      <div class="vh-title">New study set</div>
    </div>
    <form class="new-set" autocomplete="off">
      <label for="st-topic">What do you want to study?</label>
      <textarea id="st-topic" dir="auto" rows="3" maxlength="600" placeholder="e.g. The planets of the solar system, for a 7th grade science test"></textarea>
      <p class="muted small">The more specific, the better the cards.</p>
      <label for="st-count">Number of cards</label>
      <select id="st-count"><option>5</option><option selected>10</option><option>15</option><option>20</option></select>
      <div class="new-actions"><button class="btn" id="st-make">${icon('spark', 16)} Create</button></div>
      <div id="st-progress"></div>
    </form>`;
  b.querySelector('#st-back').addEventListener('click', () => {
    making?.abort();
    go('list');
  });
  b.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    make();
  });
  b.querySelector('#st-topic').focus();
}

async function make() {
  const topic = $('#st-topic').value.trim();
  if (!topic) return;
  const count = +$('#st-count').value;
  const btn = $('#st-make');
  const prog = $('#st-progress');
  btn.disabled = true;
  making = new AbortController();
  const ctl = making;
  const cards = [];
  let title = topic.slice(0, 50);
  try {
    if (!(await whenReady())) throw new Error(notReadyText());
    // Hebrew: make the cards in English, then translate them.
    const lang = ctx.settings().answerLang;
    const qHe = isHebrew(topic);
    const wantHe = lang === 'he' || (lang !== 'en' && qHe);
    const hebrew = (qHe || wantHe) && (await heReady());
    if ((qHe || lang === 'he') && !hebrew) ctx.toast(heNotReadyText());
    const topicEn = qHe && hebrew ? await toEn(topic) : topic;
    const sess = await session('study');
    // Small batches work better with the on-device AI.
    while (cards.length < count && !ctl.signal.aborted) {
      const n = Math.min(5, count - cards.length);
      prog.innerHTML = `<div class="thinking"><div class="spin"></div><span>Making cards… ${cards.length} / ${count}</span></div>`;
      const prompt = cards.length
        ? `Make ${n} more different flashcards about the same topic. Don't repeat these fronts: ${cards.map((c) => c.q).join(' | ')}`
        : `Make ${n} flashcards about: ${topicEn}\nAlso give the set a short title.`;
      const r = await promptJSON(sess, prompt, SCHEMA, ctl.signal);
      if (!cards.length && r.title) title = String(r.title).slice(0, 60);
      const fresh = (r.cards || [])
        .map((c) => ({ q: String(c.q || '').trim(), a: String(c.a || '').trim() }))
        .filter((c) => c.q && c.a && !cards.some((x) => x.q.toLowerCase() === c.q.toLowerCase()));
      if (!fresh.length) break;
      cards.push(...fresh.slice(0, count - cards.length));
    }
    sess.destroy?.();
    if (ctl.signal.aborted) return;
    if (!cards.length) throw new Error('The AI didn\'t make any cards. Try describing the topic differently.');
    if (wantHe && hebrew) {
      prog.innerHTML = '<div class="thinking"><div class="spin"></div><span>Translating to Hebrew…</span></div>';
      title = qHe ? topic.slice(0, 60) : await toHe(title);
      for (const c of cards) {
        c.q = await toHe(c.q);
        c.a = await toHe(c.a);
      }
      if (ctl.signal.aborted) return;
    }
    const set = { id: uid(), title, topic, created: Date.now(), cards };
    sets.unshift(set);
    persist();
    openSet(set);
  } catch (e) {
    if (ctl.signal.aborted) return;
    prog.innerHTML = `<div class="error">${icon('warn', 18)}<span>${esc(errText(e))}</span></div>`;
    btn.disabled = false;
  }
}

// ---------- viewer ----------

function renderViewer() {
  const b = box();
  const card = cur.cards[order[pos]];
  b.innerHTML = `
    <div class="viewer-head">
      <button class="icon-btn" id="st-back" title="All sets">${icon('left', 20)}</button>
      <div class="vh-title" dir="auto"></div>
      <button class="icon-btn" id="st-info" title="Set info">${icon('info', 18)}</button>
      <button class="icon-btn" id="st-edit" title="Edit cards">${icon('edit', 18)}</button>
      <button class="icon-btn" id="st-del" title="Delete set">${icon('trash', 18)}</button>
    </div>
    <div class="set-info" hidden></div>
    ${card ? `
    <div class="flashcard${flipped ? ' flipped' : ''}" tabindex="0" title="Click to flip">
      <div class="fc-inner">
        <div class="face front"><span class="side">QUESTION</span><div class="fc-text" dir="auto"></div></div>
        <div class="face back"><span class="side">ANSWER</span><div class="fc-text" dir="auto"></div></div>
      </div>
    </div>
    <div class="viewer-nav">
      <button class="icon-btn" id="st-prev" title="Previous (←)">${icon('left', 22)}</button>
      <span class="count">${pos + 1} / ${order.length}</span>
      <button class="icon-btn" id="st-next" title="Next (→)">${icon('right', 22)}</button>
    </div>
    <div class="viewer-tools">
      <button class="chip" id="st-shuffle">${icon('shuffle', 15)} Shuffle</button>
      <button class="chip" id="st-reset">${icon('reset', 15)} Reset</button>
    </div>
    <p class="muted small center">Click the card or press Space to flip · ← → to move</p>` : '<div class="empty"><p class="muted">This set has no cards. Press the pencil to add some.</p></div>'}`;
  b.querySelector('.vh-title').textContent = cur.title;
  b.querySelector('#st-back').addEventListener('click', () => go('list'));
  b.querySelector('#st-edit').addEventListener('click', () => go('edit'));
  const info = b.querySelector('.set-info');
  info.innerHTML = '<div><b>Cards:</b> <span class="i-n"></span></div><div><b>Made:</b> <span class="i-d"></span></div><div><b>Topic:</b> <span class="i-t"></span></div>';
  info.querySelector('.i-n').textContent = cur.cards.length;
  info.querySelector('.i-d').textContent = new Date(cur.created).toLocaleString();
  info.querySelector('.i-t').textContent = cur.topic || '—';
  b.querySelector('#st-info').addEventListener('click', () => { info.hidden = !info.hidden; });
  const del = b.querySelector('#st-del');
  del.addEventListener('click', () => {
    if (!del.classList.contains('sure')) {
      del.classList.add('sure');
      del.innerHTML = '<span class="sure-txt">Delete?</span>';
      setTimeout(() => { if (del.isConnected) { del.classList.remove('sure'); del.innerHTML = icon('trash', 18); } }, 2500);
      return;
    }
    sets = sets.filter((s) => s !== cur);
    persist();
    cur = null;
    go('list');
  });
  if (!card) return;
  const [front, back] = b.querySelectorAll('.fc-text');
  front.textContent = card.q;
  back.textContent = card.a;
  b.querySelector('.flashcard').addEventListener('click', flip);
  b.querySelector('#st-prev').addEventListener('click', () => move(-1));
  b.querySelector('#st-next').addEventListener('click', () => move(1));
  b.querySelector('#st-shuffle').addEventListener('click', () => {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    pos = 0;
    flipped = false;
    renderViewer();
  });
  b.querySelector('#st-reset').addEventListener('click', () => {
    order = cur.cards.map((_, i) => i);
    pos = 0;
    flipped = false;
    renderViewer();
  });
}

function flip() {
  flipped = !flipped;
  box().querySelector('.flashcard')?.classList.toggle('flipped', flipped);
}

function move(d) {
  if (!order.length) return;
  pos = (pos + d + order.length) % order.length;
  flipped = false;
  renderViewer();
}

function onKey(e) {
  if (view !== 'view' || !cur || $('#tab-study').hidden) return;
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'ArrowLeft') move(-1);
  else if (e.key === 'ArrowRight') move(1);
  else if (e.key === ' ' || e.key === 'Enter') flip();
  else return;
  e.preventDefault();
}

// ---------- edit ----------

function renderEdit() {
  const b = box();
  const draft = cur.cards.map((c) => ({ ...c }));
  b.innerHTML = `
    <div class="viewer-head">
      <button class="icon-btn" id="st-back" title="Back">${icon('left', 20)}</button>
      <div class="vh-title">Edit set</div>
    </div>
    <label class="field-label" for="st-title">Title</label>
    <input id="st-title" class="field" maxlength="80" dir="auto">
    <div class="edit-cards"></div>
    <button class="btn-line wide" id="st-add">${icon('plus', 16)} Add card</button>
    <div class="new-actions"><button class="btn-line" id="st-cancel">Cancel</button><button class="btn" id="st-save">Save</button></div>`;
  b.querySelector('#st-title').value = cur.title;
  const list = b.querySelector('.edit-cards');
  const draw = () => {
    list.textContent = '';
    draft.forEach((c, i) => {
      const row = document.createElement('div');
      row.className = 'edit-card';
      row.innerHTML = `<div class="ec-head"><span>Card ${i + 1}</span><button class="mini" title="Remove card">${icon('x', 14)}</button></div><textarea rows="2" dir="auto" placeholder="Question / term"></textarea><textarea rows="2" dir="auto" placeholder="Answer"></textarea>`;
      const [q, a] = row.querySelectorAll('textarea');
      q.value = c.q;
      a.value = c.a;
      q.addEventListener('input', () => { c.q = q.value; });
      a.addEventListener('input', () => { c.a = a.value; });
      row.querySelector('button').addEventListener('click', () => { draft.splice(i, 1); draw(); });
      list.append(row);
    });
  };
  draw();
  b.querySelector('#st-add').addEventListener('click', () => {
    draft.push({ q: '', a: '' });
    draw();
    list.lastElementChild?.querySelector('textarea')?.focus();
  });
  const back = () => go('view');
  b.querySelector('#st-back').addEventListener('click', back);
  b.querySelector('#st-cancel').addEventListener('click', back);
  b.querySelector('#st-save').addEventListener('click', () => {
    cur.title = b.querySelector('#st-title').value.trim() || cur.title;
    cur.cards = draft.map((c) => ({ q: c.q.trim(), a: c.a.trim() })).filter((c) => c.q || c.a);
    persist();
    order = cur.cards.map((_, i) => i);
    pos = 0;
    flipped = false;
    go('view');
  });
}

export async function clearSets() {
  sets = [];
  cur = null;
  await persist();
  go('list');
}
