// Saved data: settings, answer history, chats and study sets.

export const DEFAULTS = {
  enabled: true, // master switch
  smartScan: true, // off = only multiple-choice questions are answered
  shiftArea: true, // Shift+click the button to select an area
  showButton: true, // floating button on pages
  displayTime: 3, // seconds a short answer stays up (0 = until closed)
  position: 'bc', // tl tc tr ml mc mr bl bc br, or "near" (next to the snap)
  thinkHarder: false, // chat: reason before answering
  subtle: false, // small faded button + one-line answers that don't cover the page
  pageAnswers: true, // off = answers only show in the side panel
  invisibleButton: false, // subtle mode: button can't be seen but its spot still works
  answerLang: 'auto', // auto = Hebrew answers for Hebrew questions, or 'en' / 'he'
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: s });
  return s;
}

export async function resetSettings() {
  await chrome.storage.local.set({ settings: { ...DEFAULTS } });
  await chrome.storage.local.remove('fabPos');
}

export async function load(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? fallback;
}

export function save(key, value) {
  return chrome.storage.local.set({ [key]: value }).catch(() => {});
}

export const uid = () => crypto.randomUUID();

// Shrinks a picture (Blob or data URL) to a JPEG data URL for saving.
export async function toJpeg(src, maxSide = 640, quality = 0.75) {
  const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const out = await c.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(out);
  });
}

export async function dataUrlToBlob(d) {
  return (await fetch(d)).blob();
}

export function timeAgo(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function dayGroup(t) {
  const d = new Date(t);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  if (diff < 30) return 'Previous 30 days';
  return 'Older';
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
