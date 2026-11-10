// Settings tab: switches, answer display time, popup position.
import { DEFAULTS, getSettings, setSettings } from './store.js';

const $ = (s) => document.querySelector(s);
let s = { ...DEFAULTS };
let onChange = () => {};
let lastTime = 3; // remembered while "keep until I close it" is on

const CELLS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
const TOGGLES = [
  ['opt-enabled', 'enabled'],
  ['opt-smart', 'smartScan'],
  ['opt-shift', 'shiftArea'],
  ['opt-button', 'showButton'],
  ['opt-subtle', 'subtle'],
  ['opt-ghost', 'invisibleButton'],
  ['opt-page', 'pageAnswers'],
];

export const settings = () => s;

export async function initSettings(cb) {
  onChange = cb;
  s = await getSettings();
  if (s.displayTime > 0) lastTime = s.displayTime;

  for (const [id, key] of TOGGLES) {
    $('#' + id).addEventListener('change', (e) => setSettings({ [key]: e.target.checked }));
  }
  $('#power').addEventListener('change', (e) => setSettings({ enabled: e.target.checked }));

  const range = $('#opt-time');
  range.addEventListener('input', () => { $('#dt-val').textContent = fmt(+range.value); });
  range.addEventListener('change', () => {
    lastTime = +range.value;
    setSettings({ displayTime: lastTime });
  });
  $('#opt-keep').addEventListener('change', (e) => setSettings({ displayTime: e.target.checked ? 0 : lastTime }));

  const grid = $('#pos-grid');
  for (const c of CELLS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pos-cell';
    b.dataset.pos = c;
    b.title = posName(c);
    b.addEventListener('click', () => setSettings({ position: c }));
    grid.append(b);
  }
  $('#opt-near').addEventListener('change', (e) => setSettings({ position: e.target.checked ? 'near' : 'bc' }));
  $('#opt-lang').addEventListener('change', (e) => setSettings({ answerLang: e.target.value }));

  chrome.storage.onChanged.addListener((ch) => {
    if (!ch.settings) return;
    s = { ...DEFAULTS, ...(ch.settings.newValue || {}) };
    paint();
    onChange(s);
  });
  paint();
  onChange(s);
}

const fmt = (v) => (v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.round(v)) + ' s';

function posName(c) {
  const row = { t: 'Top', m: 'Middle', b: 'Bottom' }[c[0]];
  const col = { l: 'left', c: 'centre', r: 'right' }[c[1]];
  return c === 'mc' ? 'Centre' : `${row} ${col}`;
}

function paint() {
  for (const [id, key] of TOGGLES) $('#' + id).checked = !!s[key];
  // The invisible button is part of Subtle mode.
  $('#opt-ghost').disabled = !s.subtle;
  $('#opt-ghost').closest('.opt').classList.toggle('dim', !s.subtle);
  $('#power').checked = s.enabled;
  $('#opt-lang').value = s.answerLang || 'auto';
  $('#power-txt').textContent = s.enabled ? 'On' : 'Off';
  const keep = s.displayTime === 0;
  $('#opt-keep').checked = keep;
  $('#opt-time').disabled = keep;
  $('#opt-time').value = keep ? lastTime : s.displayTime;
  $('#dt-val').textContent = keep ? 'until closed' : fmt(s.displayTime);

  const near = s.position === 'near';
  $('#opt-near').checked = near;
  const screen = $('#pos-screen');
  screen.classList.toggle('near', near);
  screen.dataset.pos = near ? 'near' : s.position;
  document.querySelectorAll('.pos-cell').forEach((b) => b.classList.toggle('on', !near && b.dataset.pos === s.position));
  $('#pos-name').textContent = near ? 'Next to what you snapped' : posName(s.position);
}
