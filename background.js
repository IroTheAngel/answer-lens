// Answer Lens background: opens the side panel (where the AI runs), takes
// screenshots, and handles the shortcuts and the right-click menu.
// Chrome's built-in AI can't run here, so all answering happens in the panel.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'al-text', title: 'Ask Answer Lens about "%s"', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'al-image', title: 'Ask Answer Lens about this picture', contexts: ['image'] });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender.tab) return false;
  // The page's snap button: open the panel while Chrome still counts it as a click.
  if (msg?.type === 'al-wake') {
    chrome.sidePanel
      .open({ windowId: sender.tab.windowId })
      .then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  // A screenshot of what's visible in the tab.
  if (msg?.type === 'al-capture') {
    chrome.tabs
      .captureVisibleTab(sender.tab.windowId, { format: 'jpeg', quality: 92 })
      .then((dataUrl) => sendResponse({ dataUrl }), (e) => sendResponse({ error: String(e?.message || e) }));
    return true;
  }
  return false;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab) return;
  const mode = command === 'snap-area' ? 'area' : command === 'snap-full' ? 'full' : null;
  if (!mode) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  startInTab(tab.id, mode);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) return;
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  deliver({
    type: 'al-ask',
    tabId: tab.id,
    windowId: tab.windowId,
    pageTitle: tab.title || '',
    text: info.menuItemId === 'al-text' ? info.selectionText || '' : '',
    srcUrl: info.menuItemId === 'al-image' ? info.srcUrl || '' : '',
  });
});

// The panel may still be opening: keep trying for a few seconds.
async function deliver(msg) {
  for (let i = 0; i < 30; i++) {
    try {
      if (await chrome.runtime.sendMessage(msg)) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Tabs that were open before the extension was installed don't have the
// page script yet, so add it.
async function startInTab(tabId, mode) {
  const msg = { type: 'al-start', mode };
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      // chrome:// pages and the Web Store can't be snapped.
    }
  }
}
