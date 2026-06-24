const BRIDGE_URL = 'http://127.0.0.1:8765';
const WS_URL = 'ws://127.0.0.1:8765/ws';

// Multi-tab state
const tabState = new Map(); // tabId -> { url, title, loginState, lastSeen }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'hermes-bridge') {
    port.onMessage.addListener((msg) => {
      if (msg.type === 'command') {
        runCommand(msg.payload, msg.id).then((result) => {
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    tabState.set(tabId, {
      url: tab.url || changeInfo.url,
      title: tab.title,
      loginState: null,
      lastSeen: Date.now()
    });
    sendToBridge({
      type: 'tab_update',
      tabId,
      url: tab.url || changeInfo.url,
      title: tab.title,
      changeInfo
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  sendToBridge({ type: 'tab_removed', tabId });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  const tab = tabState.get(activeInfo.tabId);
  if (tab) {
    sendToBridge({
      type: 'tab_activated',
      tabId: activeInfo.tabId,
      url: tab.url,
      title: tab.title
    });
  }
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

// Content script message handler — receives login state updates
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'login_state_update' && sender.tab?.id) {
    const state = tabState.get(sender.tab.id) || {};
    state.loginState = msg.loginState;
    state.lastSeen = Date.now();
    tabState.set(sender.tab.id, state);
    sendToBridge({ type: 'login_state', tabId: sender.tab.id, loginState: msg.loginState });
  }
  if (msg.type === 'bridge_pong' && sender.tab?.id) {
    const state = tabState.get(sender.tab.id) || {};
    state.lastSeen = Date.now();
    tabState.set(sender.tab.id, state);
  }
  return true;
});

async function runCommand(payload, requestId) {
  if (['list_groups', 'create_group', 'update_group', 'add_to_group', 'remove_from_group', 'delete_group'].includes(payload.action)) {
    return runGroupCommand(payload);
  }

  // Multi-tab commands go through the active-tab helper, but we also support explicit tabId
  const explicitTabId = payload.tabId;
  const tabs = explicitTabId
    ? [{ id: explicitTabId }]
    : await chrome.tabs.query({ currentWindow: true });

  if (tabs.length === 0) throw new Error('No tabs found');

  const results = [];
  const targetTabs = payload.allTabs ? tabs : tabs.slice(0, 1);

  for (const tab of targetTabs) {
    if (!tab.id) continue;
    const result = await runOnTab(tab.id, payload);
    results.push({ tabId: tab.id, ...result });
  }

  return payload.allTabs ? { tabs: results } : results[0];
}

async function runGroupCommand(payload) {
  switch (payload.action) {
    case 'list_groups': {
      const groups = await chrome.tabGroups.query({});
      const out = [];
      for (const g of groups) {
        const tabs = await chrome.tabs.query({ groupId: g.id });
        out.push({
          id: g.id,
          title: g.title,
          color: g.color,
          collapsed: g.collapsed,
          windowId: g.windowId,
          tabIds: tabs.map(t => t.id)
        });
      }
      return { groups: out };
    }
    case 'create_group': {
      let groupId;
      if (payload.tabIds && payload.tabIds.length) {
        groupId = await chrome.tabs.group({ tabIds: payload.tabIds });
      } else {
        const tab = await chrome.tabs.create({ url: payload.url || 'about:blank' });
        groupId = await chrome.tabs.group({ tabIds: [tab.id] });
      }
      if (payload.title || payload.color) {
        await chrome.tabGroups.update(groupId, { title: payload.title || '', color: payload.color || 'grey' });
      }
      return { created: true, groupId };
    }
    case 'update_group': {
      const updates = {};
      if (payload.title != null) updates.title = payload.title;
      if (payload.color) updates.color = payload.color;
      if (typeof payload.collapsed === 'boolean') updates.collapsed = payload.collapsed;
      await chrome.tabGroups.update(payload.groupId, updates);
      return { updated: true, groupId: payload.groupId };
    }
    case 'add_to_group': {
      await chrome.tabs.group({ tabIds: payload.tabIds, groupId: payload.groupId });
      return { added: true, groupId: payload.groupId, tabIds: payload.tabIds };
    }
    case 'remove_from_group': {
      await chrome.tabs.ungroup(payload.tabIds);
      return { removed: true, tabIds: payload.tabIds };
    }
    case 'delete_group': {
      const tabs = await chrome.tabs.query({ groupId: payload.groupId });
      await chrome.tabs.ungroup(tabs.map(t => t.id));
      return { deleted: true, groupId: payload.groupId };
    }
    default:
      throw new Error('Unknown group action: ' + payload.action);
  }
}

async function runOnTab(tabId, payload) {
  switch (payload.action) {
    case 'list_tabs': {
      const all = await chrome.tabs.query({ currentWindow: true });
      return all.map(t => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
        favIconUrl: t.favIconUrl,
        loginState: tabState.get(t.id)?.loginState || null
      }));
    }
    case 'switch_tab': {
      await chrome.tabs.update(payload.tabId, { active: true });
      const tab = await chrome.tabs.get(payload.tabId);
      return { switched: true, tabId: payload.tabId, url: tab.url, title: tab.title };
    }
    case 'close_tab': {
      await chrome.tabs.remove(payload.tabId);
      return { closed: true, tabId: payload.tabId };
    }
    case 'new_tab': {
      const tab = await chrome.tabs.create({ url: payload.url || 'about:blank' });
      return { created: true, tabId: tab.id };
    }
    case 'batch_command': {
      const { commands, targetTabIds } = payload;
      const tabIds = targetTabIds || (await chrome.tabs.query({ currentWindow: true })).map(t => t.id);
      const out = [];
      for (const id of tabIds) {
        for (const cmd of commands) {
          out.push({ tabId: id, command: cmd, result: await runOnTab(id, { ...cmd, tabId: id }) });
        }
      }
      return { executed: out.length, results: out };
    }
    case 'detect_login_state': {
      const result = await chrome.scripting.executeScript({
        target: { tabId },
        func: detectLoginState
      });
      const loginState = result?.[0]?.result || { logged_out: true, reason: 'no_result' };
      const state = tabState.get(tabId) || {};
      state.loginState = loginState;
      state.lastSeen = Date.now();
      tabState.set(tabId, state);
      return { tabId, loginState };
    }
    case 'detect_all_login_states': {
      const allTabs = await chrome.tabs.query({ currentWindow: true });
      const detections = [];
      for (const t of allTabs) {
        if (!t.id) continue;
        try {
          const result = await chrome.scripting.executeScript({
            target: { tabId: t.id },
            func: detectLoginState
          });
          const loginState = result?.[0]?.result || { logged_out: true, reason: 'no_result' };
          const state = tabState.get(t.id) || {};
          state.loginState = loginState;
          state.lastSeen = Date.now();
          tabState.set(t.id, state);
          detections.push({ tabId: t.id, url: t.url, title: t.title, loginState });
        } catch (e) {
          detections.push({ tabId: t.id, url: t.url, title: t.title, loginState: { logged_out: true, reason: 'injection_failed', error: String(e) } });
        }
      }
      return { detections };
    }
    case 'get_session_tokens': {
      if (!USE_CDP) return { error: 'session_tokens_require_cdp_mode', hint: 'connect with --remote-debugging-port=9222' };
      const cookies = await cdpSend('Network.getAllCookies');
      const tab = await chrome.tabs.get(tabId);
      const hostname = new URL(tab.url).hostname;
      const relevant = (cookies.cookies || []).filter(c => c.domain.includes(hostname.replace('www.', '')));
      const authCookies = relevant.filter(c => /session|token|auth|jwt|bearer|access|refresh|id/i.test(c.name));
      const storageResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const s = { ...(window.localStorage || {}), ...(window.sessionStorage || {}) };
          return Object.entries(s).filter(([k, v]) => /token|access_token|id_token|session|auth|jwt|bearer|refresh/i.test(k) && typeof v === 'string' && v.length > 20).map(([k, v]) => ({ key: k, length: v.length, snippet: v.slice(0, 40) + '...' }));
        }
      }).catch(() => []);
      return {
        tabId,
        hostname,
        cookieCount: relevant.length,
        authCookieCount: authCookies.length,
        authCookies: authCookies.map(c => ({ name: c.name, domain: c.domain, httpOnly: c.httpOnly, secure: c.secure })),
        storageTokenCount: (storageResult && storageResult[0]?.result)?.length || 0,
        storageTokens: storageResult && storageResult[0]?.result ? storageResult[0].result : [],
      };
    }
    case 'get_all_sessions': {
      if (!USE_CDP) return { error: 'all_sessions_require_cdp_mode' };
      const cookies = await cdpSend('Network.getAllCookies');
      const domains = new Set();
      (cookies.cookies || []).forEach(c => domains.add(c.domain));
      const sessions = [];
      for (const domain of domains) {
        const domainCookies = (cookies.cookies || []).filter(c => c.domain === domain);
        const authCookies = domainCookies.filter(c => /session|token|auth|jwt|bearer|access|refresh|sid|ssid|csrftoken/i.test(c.name));
        if (authCookies.length > 0) {
          sessions.push({
            domain,
            url: `https://${domain}`,
            cookieCount: domainCookies.length,
            authCookieCount: authCookies.length,
            authCookieNames: authCookies.map(c => c.name),
            hasHttpOnly: authCookies.some(c => c.httpOnly),
          });
        }
      }
      return { mode: 'cdp', sessions, totalDomains: domains.size };
    }
    case 'get_url':
      return { url: (await chrome.tabs.get(tabId)).url };
    case 'get_title': {
      const t = await chrome.tabs.get(tabId);
      return { title: t.title, url: t.url };
    }
    case 'get_html':
      return await getDOM(tabId, 'document.documentElement.outerHTML');
    case 'get_text':
      return await getDOM(tabId, 'document.body.innerText');
    case 'get_selection':
      return await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.getSelection().toString()
      });
    case 'screenshot': {
      const dataUrl = await captureTab(tabId);
      return { dataUrl, width: payload.width || 1280, height: payload.height || 800, tabId };
    }
    case 'navigate':
      await chrome.tabs.update(tabId, { url: payload.url });
      return { navigated: true, tabId };
    case 'click': {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => {
          const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
          if (!el) throw new Error('Element not found: ' + selector);
          el.click();
        },
        args: [payload.selector]
      });
      return { clicked: true, tabId, selector: payload.selector };
    }
    case 'type': {
      await chrome.scripting.executeScript({
        target: { tabId },
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
      return { typed: true, tabId };
    }
    case 'scroll': {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y) => window.scrollTo(x, y),
        args: [payload.x ?? 0, payload.y ?? 0]
      });
      return { scrolled: true, tabId };
    }
    case 'execute': {
      const res = await chrome.scripting.executeScript({
        target: { tabId },
        func: payload.fn,
        args: payload.args || []
      });
      return { result: res?.[0]?.result, tabId };
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
  const url = (await chrome.tabs.get(tabId)).url;
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

// Login state detection — injected into page context
function detectLoginState() {
  const state = {
    logged_out: false,
    confidence: 'unknown',
    indicators: [],
    url: document.location.href,
    hostname: document.location.hostname
  };

  // Helper: count visible form fields
  function formFields() {
    const inputs = Array.from(document.querySelectorAll('input'));
    return {
      emailCount: inputs.filter(i => i.type === 'email').length,
      passwordCount: inputs.filter(i => i.type === 'password').length,
      submitCount: inputs.filter(i => i.type === 'submit').length,
      totalFields: inputs.length
    };
  }

  // Helper: detect common auth UI patterns
  function hasLoginUI() {
    const text = (document.body?.innerText || '').toLowerCase();
    const hasSignIn = /sign in|log in|login|signin/.test(text);
    const hasSignUp = /sign up|register|create account/.test(text);
    const hasForgot = /forgot password|reset password/.test(text);
    const fields = formFields();
    return { hasSignIn, hasSignUp, hasForgot, ...fields };
  }

  // 1) Explicit login form detection
  const ui = hasLoginUI();
  state.indicators.push('ui:' + JSON.stringify(ui));
  if (ui.passwordCount > 0) {
    state.logged_out = true;
    state.confidence = 'high';
    state.reason = 'password_field_present';
    return state;
  }
  if (ui.hasSignIn && ui.emailCount > 0 && !ui.hasSignUp) {
    state.logged_out = true;
    state.confidence = 'medium';
    state.reason = 'signin_text_no_password_but_email_only';
    return state;
  }

  // 2) Check for session tokens (localStorage, sessionStorage, cookies)
  const storage = { ...(window.localStorage || {}), ...(window.sessionStorage || {}) };
  const tokenKeys = Object.keys(storage).filter(k =>
    /token|access_token|id_token|session|auth|jwt|bearer|refresh/i.test(k)
  );
  state.indicators.push('token_keys:' + JSON.stringify(tokenKeys));

  const hasToken = tokenKeys.length > 0 && Object.values(storage).some(v => typeof v === 'string' && v.length > 20);
  if (hasToken) {
    state.logged_out = false;
    state.confidence = 'high';
    state.reason = 'auth_token_found_in_storage';
    state.tokenKeys = tokenKeys;
    return state;
  }

  // 3) Check for common logged-in UI elements
  const hasAvatar = !!document.querySelector('img[src*="avatar"], [data-avatar], .avatar, .profile-pic, .user-avatar, img[alt*="avatar" i], img[alt*="profile" i]');
  const hasUserName = !!document.querySelector('[data-username], .username, .user-name, .account-name, [href*="/settings"], [href*="/profile"]');
  const loggedInUI = hasAvatar || hasUserName;
  state.indicators.push('logged_in_ui:' + JSON.stringify({ hasAvatar, hasUserName }));

  if (loggedInUI && !state.logged_out) {
    state.logged_out = false;
    state.confidence = 'medium';
    state.reason = 'logged_in_ui_detected';
    return state;
  }

  // 4) URL-based heuristics (avoid auth routes)
  const isAuthRoute = /\/login|\/signin|\/auth|\/signup|\/register|\/forgot-password/i.test(document.location.pathname);
  if (isAuthRoute) {
    state.logged_out = true;
    state.confidence = 'medium';
    state.reason = 'auth_route_url';
    return state;
  }

  // 5) Fallback
  state.logged_out = null;
  state.confidence = 'low';
  state.reason = 'no_clear_signal';
  return state;
}
