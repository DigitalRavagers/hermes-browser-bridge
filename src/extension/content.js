(() => {
  'use strict';

  const BRIDGE_VERSION = '0.1.0';

  // Expose APIs to page for scripts that want it
  window.__HERMES_BRIDGE__ = {
    read: () => document.documentElement.outerHTML,
    text: () => document.body?.innerText,
    click: (sel) => document.querySelector(sel)?.click(),
    type: (sel, text) => {
      const el = document.querySelector(sel);
      if (!el) return 'not_found';
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    }
  };

  // On load, tell background we're ready
  chrome.runtime.sendMessage({ type: 'bridge:ping' }).catch(() => {});
})();
