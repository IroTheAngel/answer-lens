// Chat tab: a full AI chat with saved history, pictures and "think harder".
import { ai, session, stream, SYSTEMS, THINK_NOTE, errText, isTooLong, whenReady, notReadyText } from './ai.js';
import { icon } from './icons.js';
import { md, plain } from './md.js';
import { load, save, uid, toJpeg, dataUrlToBlob, dayGroup, copyText, getSettings, setSettings } from './store.js';
import { isHebrew, heReady, heNotReadyText, toEn, mdToHe } from './translate.js';

const MAX_CHATS = 100;
const MAX_PICS = 10;
const $ = (s) => document.querySelector(s);

let ctx;
let chats = []; // saved chats, newest first
let active = null; // the open chat
let sess = null; // AI session that remembers the open chat
let sessKey = ''; // which chat / length / mode the session matches
let busy = null; // AbortController while the AI is writing
let pics = []; // pictures waiting to be sent (JPEG data URLs)

export async function initChat(context) {
  ctx = context;
  chats = await load('chats', []);
  const s = await getSettings();
  $('#chat-think').checked = !!s.thinkHarder;
  $('#chat-think').addEventListener('change', () => setSettings({ thinkHarder: $('#chat-think').checked }));

  $('#chat-new').addEventListener('click', () => { newChat(); closeDrawer(); });
  $('#chat-new-2').addEventListener('click', () => { newChat(); closeDrawer(); });
  $('#chat-history-btn').addEventListener('click', toggleDrawer);
  $('#chat-search').addEventListener('input', renderList);
  $('#composer').addEventListener('submit', (e) => { e.preventDefault(); onSend(); });
  $('#chat-send').addEventListener('click', (e) => {
    if (busy) { e.preventDefault(); busy.abort(); }
  });
  const input = $('#chat-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      onSend();
    }
  });
  input.addEventListener('input', grow);
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      addPics(files);
    }
  });
  $('#chat-attach').addEventListener('click', () => $('#chat-file').click());
  $('#chat-file').addEventListener('change', (e) => {
    addPics([...e.target.files]);
    e.target.value = '';
  });
  const page = $('#tab-chat');
  page.addEventListener('dragover', (e) => { e.preventDefault(); page.classList.add('drop'); });
  page.addEventListener('dragleave', (e) => { if (!page.contains(e.relatedTarget)) page.classList.remove('drop'); });
  page.addEventListener('drop', (e) => {
    e.preventDefault();
    page.classList.remove('drop');
    addPics([...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/')));
  });
  $('#chat-msgs').addEventListener('click', (e) => {
    const b = e.target.closest('.code-copy');
    if (b) {
      copyText(b.nextElementSibling.textContent);
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = 'Copy'; }, 1200);
    }
  });
  newChat();
  renderList();
}

// Opens a new chat about a snapped answer.
export function openChatWith(entry) {
  newChat();
  active.title = (entry.question || 'Snapped question').slice(0, 60);
  active.messages.push(
    { role: 'user', text: `Here's a question I snapped:\n${entry.question || '(see the picture)'}`, images: entry.thumbs.slice(0, 1) },
    { role: 'assistant', text: `**Answer:** ${entry.answer}${entry.steps.length ? '\n\n' + entry.steps.map((s, i) => `${i + 1}. ${s}`).join('\n') : ''}` },
  );
  renderAll();
  ctx.showTab('chat');
  $('#chat-input').placeholder = 'Ask about this answer…';
  $('#chat-input').focus();
}

export function focusChat() {
  ctx.showTab('chat');
  $('#chat-input').focus();
}

function newChat() {
  busy?.abort();
  active = { id: uid(), title: 'New chat', created: Date.now(), updated: Date.now(), messages: [] };
  sess = null;
  sessKey = '';
  pics = [];
  $('#chat-input').placeholder = 'Message Answer Lens…';
  renderAll();
}

function openChat(id) {
  const c = chats.find((x) => x.id === id);
  if (!c) return;
  busy?.abort();
  active = c;
  sess = null;
  sessKey = '';
  renderAll();
  closeDrawer();
}

function persist() {
  if (!active.messages.length) return;
  active.updated = Date.now();
  chats = [active, ...chats.filter((c) => c.id !== active.id)].slice(0, MAX_CHATS);
  save('chats', chats);
  renderList();
}

// ---------- sending ----------

function onSend() {
  if (busy) return;
  const text = $('#chat-input').value.trim();
  if (!text && !pics.length) return;
  $('#chat-input').value = '';
  grow();
  const images = pics;
  pics = [];
  renderPics();
  send(text, images);
}

async function send(text, images) {
  const user = { role: 'user', text, images };
  active.messages.push(user);
  if (active.title === 'New chat') active.title = (text || 'Picture question').replace(/\s+/g, ' ').slice(0, 60);
  const reply = { role: 'assistant', text: '' };
  active.messages.push(reply);
  setBusy(true);
  renderAll();
  const think = $('#chat-think').checked;
  const system = SYSTEMS.chat + (think ? THINK_NOTE : '');
  const n = active.messages.length - 2; // messages before this turn
  // Hebrew: the AI gets an English translation, and its reply comes back in Hebrew.
  const lang = ctx.settings().answerLang;
  const qHe = isHebrew(text);
  const wantHe = lang === 'he' || (lang !== 'en' && qHe);
  let hebrew = false;
  try {
    if (!(await whenReady())) throw new Error(notReadyText());
    hebrew = (qHe || wantHe) && (await heReady());
    if ((qHe || lang === 'he') && !hebrew) ctx.toast(heNotReadyText());
    if (qHe && hebrew) user.textEn = await toEn(text);
    const key = `${active.id}|${n}|${think}`;
    if (!sess || sessKey !== key) sess = await makeSession(system, active.messages.slice(0, n));
    let input = user.textEn || text || 'What is in this picture?';
    if (images.length) {
      if (ai.mode === 'image') {
        const blobs = await Promise.all(images.map(dataUrlToBlob));
        input = [{ role: 'user', content: [{ type: 'text', value: input }, ...blobs.map((b) => ({ type: 'image', value: b }))] }];
      } else {
        ctx.toast('This Chrome\'s AI can\'t read pictures yet, so only your text was sent.');
      }
    }
    const toHebrew = wantHe && hebrew;
    await run(input, reply, system, false, toHebrew ? 'textEn' : 'text');
    if (toHebrew) {
      // Translate the answer (the "reasoning" part stays in English).
      const { reason, answer } = splitThink(reply.textEn);
      reply.text = (reason ? `<think>${reason}</think>` : '') + (await mdToHe(answer));
      reply.lang = 'he';
    }
    sessKey = `${active.id}|${active.messages.length}|${think}`;
  } catch (e) {
    if (busy?.signal.aborted) {
      reply.text = (reply.text || '') + '\n\n*(stopped)*';
      sess = null; // the session may be half-way through: start clean next time
    } else {
      reply.text = '⚠ ' + errText(e);
      reply.error = true;
      sess = null;
    }
    renderLast();
  }
  setBusy(false);
  renderAll(); // brings back the edit buttons hidden while the AI was writing
  persist();
}

// field = "text" (shown as it's written) or "textEn" (kept hidden until it's translated)
async function run(input, reply, system, retried = false, field = 'text') {
  try {
    for await (const full of stream(sess, input, busy.signal)) {
      reply[field] = full;
      renderLast();
    }
  } catch (e) {
    if (!retried && isTooLong(e) && !busy.signal.aborted) {
      // Too long for the on-device AI: keep only the last few messages.
      const n = active.messages.length - 2;
      sess = await makeSession(system, active.messages.slice(Math.max(0, n - 6), n));
      reply[field] = '';
      return run(input, reply, system, true, field);
    }
    throw e;
  }
}

// The AI remembers the chat in English (Hebrew messages keep an English copy).
function makeSession(system, msgs) {
  const history = msgs
    .filter((m) => !m.error && (m.textEn || m.text))
    .map((m) => ({
      role: m.role,
      content: m.role === 'assistant'
        ? splitThink(m.textEn || m.text).answer
        : (m.textEn || m.text) + (m.images?.length ? `\n[${m.images.length} picture(s) were attached]` : ''),
    }));
  return session('chat', { history, system });
}

function setBusy(on) {
  busy = on ? new AbortController() : null;
  const b = $('#chat-send');
  b.innerHTML = icon(on ? 'stop' : 'send', 18);
  b.title = on ? 'Stop' : 'Send';
  b.classList.toggle('stop', on);
}

// ---------- pictures ----------

async function addPics(files) {
  for (const f of files) {
    if (pics.length >= MAX_PICS) {
      ctx.toast(`Up to ${MAX_PICS} pictures per message.`);
      break;
    }
    try {
      pics.push(await toJpeg(f, 1024, 0.85));
    } catch {}
  }
  renderPics();
}

function renderPics() {
  const row = $('#attach-row');
  row.textContent = '';
  pics.forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = 'pic-chip';
    chip.innerHTML = `<img src="${p}" alt=""><button type="button" title="Remove">${icon('x', 12)}</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      pics.splice(i, 1);
      renderPics();
    });
    row.append(chip);
  });
}

// ---------- drawing the chat ----------

function grow() {
  const t = $('#chat-input');
  t.style.height = 'auto';
  t.style.height = Math.min(160, t.scrollHeight) + 'px';
}

function splitThink(t) {
  const m = t.match(/<think>([\s\S]*?)(<\/think>|$)/i);
  if (!m) return { reason: '', answer: t.trim(), open: false };
  return { reason: m[1].trim(), answer: (t.slice(0, m.index) + t.slice(m.index + m[0].length)).trim(), open: !m[2] };
}

function renderAll() {
  $('#chat-title').textContent = active.title;
  const box = $('#chat-msgs');
  box.textContent = '';
  if (!active.messages.length) {
    box.innerHTML = `
      <div class="chat-empty">
        <div class="big-ic">${icon('chat', 30)}</div>
        <h3>Ask me anything</h3>
        <p class="muted">Add pictures with the picture button, by pasting, or by dropping them here.</p>
        <div class="suggest"></div>
      </div>`;
    const sug = box.querySelector('.suggest');
    for (const t of ['Explain photosynthesis simply', 'Quiz me on the times tables', 'How do I find the area of a circle?']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = t;
      b.addEventListener('click', () => { $('#chat-input').value = t; onSend(); });
      sug.append(b);
    }
    return;
  }
  active.messages.forEach((m, i) => box.append(msgEl(m, i)));
  box.scrollTop = box.scrollHeight;
}

function renderLast() {
  const box = $('#chat-msgs');
  const i = active.messages.length - 1;
  const old = box.lastElementChild;
  const el = msgEl(active.messages[i], i);
  if (old?.dataset.i === String(i)) old.replaceWith(el);
  else box.append(el);
  box.scrollTop = box.scrollHeight;
}

function msgEl(m, i) {
  const el = document.createElement('div');
  el.className = `msg ${m.role}${m.error ? ' err' : ''}`;
  el.dataset.i = i;
  if (m.role === 'user') {
    if (m.images?.length) {
      const g = document.createElement('div');
      g.className = 'msg-pics';
      for (const p of m.images) g.append(Object.assign(document.createElement('img'), { src: p, alt: '' }));
      el.append(g);
    }
    if (m.text) el.append(Object.assign(document.createElement('div'), { className: 'bubble', textContent: m.text, dir: 'auto' }));
    el.append(actions(m, i, true));
  } else {
    const { reason, answer, open } = splitThink(m.text);
    if (reason) {
      const d = document.createElement('details');
      d.className = 'reason';
      d.open = open;
      d.innerHTML = `<summary>${icon('spark', 14)} ${open ? 'Thinking…' : 'Reasoning'}</summary>`;
      d.append(Object.assign(document.createElement('div'), { textContent: reason }));
      el.append(d);
    }
    const body = document.createElement('div');
    body.className = 'bubble md';
    body.dir = m.lang === 'he' ? 'rtl' : 'auto';
    if (!answer && busy && i === active.messages.length - 1 && !open) {
      body.innerHTML = '<div class="thinking"><div class="spin"></div><span>Thinking…</span></div>';
    } else body.innerHTML = md(answer);
    if (answer || !open) el.append(body);
    if (!(busy && i === active.messages.length - 1)) el.append(actions(m, i, false));
  }
  return el;
}

function actions(m, i, isUser) {
  const row = document.createElement('div');
  row.className = 'msg-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'mini';
  copy.title = 'Copy';
  copy.innerHTML = icon('copy', 14);
  copy.addEventListener('click', async () => {
    await copyText(plain(isUser ? m.text : splitThink(m.text).answer));
    copy.innerHTML = icon('check', 14);
    setTimeout(() => { copy.innerHTML = icon('copy', 14); }, 1200);
  });
  row.append(copy);
  if (isUser && !busy) {
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'mini';
    edit.title = 'Edit and resend';
    edit.innerHTML = icon('edit', 14);
    edit.addEventListener('click', () => startEdit(i));
    row.append(edit);
  }
  return row;
}

function startEdit(i) {
  const m = active.messages[i];
  const el = $(`#chat-msgs .msg[data-i="${i}"]`);
  if (!el) return;
  const box = document.createElement('div');
  box.className = 'edit-box';
  box.innerHTML = '<textarea rows="3"></textarea><div class="edit-btns"><button type="button" class="btn-line cancel">Cancel</button><button type="button" class="btn small save">Save & send</button></div>';
  const ta = box.querySelector('textarea');
  ta.value = m.text;
  el.replaceWith(box);
  ta.focus();
  box.querySelector('.cancel').addEventListener('click', renderAll);
  box.querySelector('.save').addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text && !m.images?.length) return;
    active.messages = active.messages.slice(0, i);
    sess = null;
    send(text, m.images || []);
  });
}

// ---------- history drawer ----------

function toggleDrawer() {
  const d = $('#chat-drawer');
  d.hidden = !d.hidden;
  if (!d.hidden) {
    renderList();
    $('#chat-search').focus();
  }
}
function closeDrawer() {
  $('#chat-drawer').hidden = true;
}

function renderList() {
  const list = $('#chat-list');
  const q = $('#chat-search').value.trim().toLowerCase();
  list.textContent = '';
  const shown = chats.filter((c) => !q || (c.title + ' ' + c.messages.map((m) => m.text).join(' ')).toLowerCase().includes(q));
  if (!shown.length) {
    list.innerHTML = `<p class="muted pad">${chats.length ? 'No chats match.' : 'Your chats will show up here.'}</p>`;
    return;
  }
  let group = '';
  for (const c of shown) {
    const g = dayGroup(c.updated);
    if (g !== group) {
      group = g;
      list.append(Object.assign(document.createElement('div'), { className: 'group', textContent: g }));
    }
    const row = document.createElement('div');
    row.className = 'chat-row' + (active?.id === c.id ? ' on' : '');
    row.innerHTML = `<span class="t"></span><button class="mini del" title="Delete (Shift+click: no question)">${icon('trash', 14)}</button>`;
    row.querySelector('.t').textContent = c.title;
    row.addEventListener('click', () => openChat(c.id));
    const del = row.querySelector('.del');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!e.shiftKey && !del.classList.contains('sure')) {
        del.classList.add('sure');
        del.innerHTML = 'Delete?';
        setTimeout(() => { del.classList.remove('sure'); del.innerHTML = icon('trash', 14); }, 2500);
        return;
      }
      chats = chats.filter((x) => x.id !== c.id);
      save('chats', chats);
      if (active.id === c.id) newChat();
      renderList();
    });
    list.append(row);
  }
}

export async function clearChats() {
  chats = [];
  await save('chats', chats);
  newChat();
  renderList();
}
