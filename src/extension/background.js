const BRIDGE_URL = 'http://127.0.0.1:8765';
const WS_URL = 'ws://127.0.0.1:8765/ws';

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'hermes-bridge') {
    port.onMessage.addListener((msg) => {
      if (msg.type === 'command') {
        runCommand(msg.payload).then((result) => {
          port.postMessage({ id: msg.id, result });
        }).catch((err) => {
          port.postMessage({ id: msg.id, error: String(err) });
        });
      }
    });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'hermes-inspect',
    title: 'Inspect for Hermes',
    contexts: ['page']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'hermes-inspect') {
    sendToBridge({
      type: 'event',
      event: 'context_click',
      tabId: tab.id,
      url: tab.url,
      selection: info.selectionText
    });
  }
});

async function runCommand(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  switch (payload.action) {
    case 'get_url':
      return { url: tab.url };
    case 'get_title':
      return { title: tab.title };
    case 'get_html':
      return await getDOM(tab.id, 'document.documentElement.outerHTML');
    case 'get_text':
      return await getDOM(tab.id, 'document.body.innerText');
    case 'get_selection':
      return await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection().toString()
      });
    case 'screenshot': {
      const dataUrl = await captureTab(tab.id);
      return { dataUrl, width: payload.width || 1280, height: payload.height || 800 };
    }
    case 'navigate':
      await chrome.tabs.update(tab.id, { url: payload.url });
      return { navigated: true };
    case 'click': {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (selector) => {
          const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
          if (!el) throw new Error('Element not found: ' + selector);
          el.click();
        },
        args: [payload.selector]
      });
      return { clicked: true };
    }
    case 'type': {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (selector, text) => {
          const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
          if (!el) throw new Error('Element not found: ' + selector);
          el.focus();
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        args: [payload.selector, payload.text]
      });
      return { typed: true };
    }
    case 'scroll': {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (x, y) => window.scrollTo(x, y),
        args: [payload.x ?? 0, payload.y ?? 0]
      });
      return { scrolled: true };
    }
    case 'execute': {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: payload.fn,
        args: payload.args || []
      });
      return { result: res ? res[0]?.result : null };
    }
    default:
      throw new Error('Unknown action: ' + payload.action);
  }
}

async function getDOM(tabId, expression) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: (fn) => {
      try { return eval(fn); } catch (e) { return String(e); }
    },
    args: [expression]
  });
  return { value: res?.[0]?.result };
}

async function captureTab(tabId) {
  // Try native messaging to the bridge for screenshot (avoids devtools)
  const result = await chrome.tabs.sendMessage(tabId, { type: 'bridge:ping' }).catch(() => null);
  // Fallback: use the debugger API for a canvas-like capture, or ask the bridge
  return await requestScreenshotFromBridge({ tabId, url: (await chrome.tabs.get(tabId)).url });
}
async function requestScreenshotFromBridge({ tabId, url }) {
  // This is a placeholder — the real PNG capture comes from a content-script-initiated flow
  // The bridge server runs Playwright headless locally and renders urls
  const resp = await fetch(`${BRIDGE_URL}/screenshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, width: 1280, height: 800 })
  });
  return await resp.json();
}

async function sendToBridge(msg) {
  try {
    await fetch(`${BRIDGE_URL}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg)
    });
  } catch (e) {
    // bridge not running — ignore
  }
}
