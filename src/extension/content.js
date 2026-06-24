(() => {
  'use strict';

  const BRIDGE_VERSION = '0.1.0';

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
    },
    detectLoginState: () => {
      // Mirror of background.js detectLoginState logic, adapted for content script
      // We post it to background which aggregates across tabs
      const hasPassword = !!document.querySelector('input[type="password"]');
      const text = (document.body?.innerText || '').toLowerCase();
      const hasSignIn = /sign in|log in|login|signin/.test(text);
      const hasSignUp = /sign up|register|create account/.test(text);
      const isAuthRoute = /\/login|\/signin|\/auth|\/signup|\/register|\/forgot-password/i.test(document.location.pathname);

      // Try storage (may be sandboxed, best-effort)
      let hasToken = false;
      try {
        const storage = { ...(window.localStorage || {}), ...(window.sessionStorage || {}) };
        hasToken = Object.entries(storage).some(([k, v]) => /token|access_token|id_token|session|auth|jwt|bearer|refresh/i.test(k) && typeof v === 'string' && v.length > 20);
      } catch {}

      chrome.runtime.sendMessage({
        type: 'login_state_update',
        loginState: {
          logged_out: hasPassword || (hasSignIn && !hasSignUp) || isAuthRoute,
          logged_in: !hasPassword && hasToken,
          hasPassword,
          hasSignIn,
          hasSignUp,
          isAuthRoute,
          hasToken,
          url: document.location.href,
          hostname: document.location.hostname
        }
      }).catch(() => {});
    }
  };

  // Run detection on load and after DOM changes
  const runDetection = () => {
    try { window.__HERMES_BRIDGE__.detectLoginState(); } catch {}
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runDetection);
  } else {
    runDetection();
  }

  // Re-run on URL hash changes (SPA navigations)
  window.addEventListener('hashchange', runDetection);
  // Poll periodically for SPA state changes
  setInterval(runDetection, 5000);

  // Keep background informed we exist
  chrome.runtime.sendMessage({ type: 'bridge_ping' }).catch(() => {});
})();
