const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const chromium = require('playwright').chromium;
const path = require('path');

const PORT = parseInt(process.env.HERMES_BRIDGE_PORT || '8765', 10);
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'pages')));

const CDP_ENDPOINT = process.env.CDP_ENDPOINT || null;
const USE_CDP = !!CDP_ENDPOINT;

let browser = null;
let cdpClient = null;
let cdpTargetId = null;
let wsClients = new Set();

// Track tab meta we learn from the extension
const remoteTabs = new Map(); // tabId -> { url, title, active, loginState, lastSeen }

function upsertRemoteTab(update) {
  const prev = remoteTabs.get(update.tabId) || {};
  remoteTabs.set(update.tabId, { ...prev, ...update, lastSeen: Date.now() });
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  return browser;
}

async function getCDP() {
  if (!USE_CDP) return null;
  if (cdpClient && cdpClient.connected) return cdpClient;
  const wsEndpoint = new URL(CDP_ENDPOINT).toString().replace(/^http/, 'ws') + '/json/version';
  const ws = new (require('ws'))(wsEndpoint);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('CDP connect timeout')), 15000);
  });
  ws.close();
  const http = require('http');
  const targets = await new Promise((resolve, reject) => {
    http.get(new URL('/json/list', CDP_ENDPOINT).toString(), (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
  const page = targets.find(t => t.type === 'page') || targets[0];
  if (!page) throw new Error('No CDP target found. Launch Chrome with --remote-debugging-port=9222');
  cdpTargetId = page.id;
  const wsUrl = page.webSocketDebuggerUrl || new URL('/devtools/page/' + page.id, CDP_ENDPOINT).toString().replace(/^http/, 'ws');
  cdpClient = new (require('ws'))(wsUrl);
  await new Promise((resolve, reject) => {
    cdpClient.on('open', resolve);
    cdpClient.on('error', reject);
    setTimeout(() => reject(new Error('CDP ws timeout')), 15000);
  });
  return cdpClient;
}

async function cdpSend(method, params = {}) {
  const client = await getCDP();
  return new Promise((resolve, reject) => {
    const id = 1;
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id === id) {
        client.off('message', handler);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    client.on('message', handler);
    client.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { client.off('message', handler); reject(new Error('cdp timeout: ' + method)); }, 20000);
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// Health
app.get('/health', async () => json({ ok: true, service: 'hermes-browser-bridge', time: new Date().toISOString() }));

// Multi-tab orchestration: list tabs known to the extension
app.get('/tabs', async (req, res) => {
  const useExtension = req.query.source !== 'cdp';
  if (USE_CDP && !useExtension) {
    try {
      const http = require('http');
      const targets = await new Promise((resolve, reject) => {
        http.get(new URL('/json/list', CDP_ENDPOINT).toString(), (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve(JSON.parse(body)));
        }).on('error', reject);
      });
      return res.json({ source: 'cdp', tabs: targets.map(t => ({ id: t.id, url: t.url, title: t.title, type: t.type })) });
    } catch (e) {
      return res.json({ source: 'cdp', error: String(e) });
    }
  }
  // Fallback to extension-reported tabs
  const tabs = [];
  remoteTabs.forEach((meta, tabId) => tabs.push({ tabId, ...meta }));
  tabs.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  res.json({ source: 'extension', tabs });
});

// Switch / activate a specific tab (proxied to extension via event bus)
app.post('/tabs/:tabId/activate', async (req, res) => {
  const { tabId } = req.params;
  broadcastToWS({ type: 'switch_tab', tabId: Number(tabId) });
  res.json({ queued: true, tabId: Number(tabId) });
});

// Login state detection via extension
app.post('/tabs/login-states', async (req, res) => {
  broadcastToWS({ type: 'detect_all_login_states' });
  // Return extension-known states immediately; live updates arrive via WS
  const states = [];
  remoteTabs.forEach((meta, tabId) => states.push({ tabId, ...meta }));
  res.json({ queued: true, states });
});

// Screenshot
app.post('/screenshot', async (req, res) => {
  const { url, width, height, fullPage } = req.body || {};
  if (!url) return json({ error: 'url required' }, 400);
  try {
    const base64 = await renderPage({ url: String(url), width: width || 1280, height: height || 800, fullPage: fullPage || false });
    return json({ dataUrl: `data:image/png;base64,${base64}`, url, width, height });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// Page summary
app.post('/summarize', async (req, res) => {
  const { url, width } = req.body || {};
  if (!url) return json({ error: 'url required' }, 400);
  try {
    if (USE_CDP) {
      const client = await getCDP();
      await cdpSend('Page.navigate', { url: String(url) });
      await new Promise(r => setTimeout(r, 1500));
      const js = `(() => ({ title: document.title, url: document.location.href, text: document.body?.innerText?.slice(0, 4000), links: Array.from(document.querySelectorAll('a')).slice(0, 40).map(a => ({ text: (a.innerText || a.textContent || '').trim(), href: a.getAttribute('href') })) }))()`;
      const { result } = await cdpSend('Runtime.evaluate', { expression: js, returnByValue: true });
      return json(result.value);
    }
    const b = await getBrowser();
    const page = await b.newPage({ viewport: { width: width || 1280, height: 900 } });
    await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    const data = await page.evaluate(() => ({
      title: document.title,
      url: document.location.href,
      text: document.body?.innerText?.slice(0, 4000),
      links: Array.from(document.querySelectorAll('a')).slice(0, 40).map(a => ({
        text: a.innerText?.trim?.() || '',
        href: a.getAttribute('href')
      }))
    }));
    await page.close();
    return json(data);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// CDP connect
app.post('/cdp/connect', async (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return json({ error: 'endpoint required (http://127.0.0.1:9222)' }, 400);
  process.env.CDP_ENDPOINT = String(endpoint);
  try { cdpClient = null; await getCDP(); } catch (e) { return json({ error: String(e) }, 500); }
  return json({ mode: 'cdp', connected: true, targetId: cdpTargetId });
});

// Control routed by extension (requires extension-connected host)
app.post('/control', async (req, res) => {
  // When running headless, use Playwright as before
  const b = browser || (await getBrowser());
  const context = await b.contexts().catch(() => null);
  const pages = context?.pages?.() || [];
  let page = pages.find(p => !p.isClosed());
  if (!page) page = await getBrowser().then(b => b.newPage());
  const { action, selector, url, text, x, y } = req.body || {};
  if (url) {
    await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1200);
  }
  try {
    if (action === 'screenshot') {
      const buf = await page.screenshot({ type: 'png' });
      return json({ dataUrl: `data:image/png;base64,${buf.toString('base64')}` });
    }
    if (action === 'evaluate') {
      const { fn, args } = req.body || {};
      const result = await page.evaluate((f, a) => {
        try { return { ok: true, value: f(...a) }; } catch (e) { return { ok: false, error: String(e) }; }
      }, fn, args || []);
      return json(result);
    }
    if (action === 'click' && selector) {
      await page.click(selector);
      await page.waitForTimeout(250);
      return json({ clicked: true, selector });
    }
    if (action === 'type' && selector && typeof text === 'string') {
      await page.fill(selector, text);
      await page.waitForTimeout(100);
      return json({ typed: true, selector });
    }
    if (action === 'scroll' && (x != null || y != null)) {
      await page.evaluate((x, y) => window.scrollTo(x, y), x ?? 0, y ?? 0);
      return json({ scrolled: true, x, y });
    }
    return json({ error: 'Unsupported control action' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// Events coming from extension (tab updates, login states)
app.post('/event', (req, res) => {
  const payload = req.body || {};
  if (payload.type === 'tab_update' && payload.tabId) {
    upsertRemoteTab({ tabId: payload.tabId, url: payload.url, title: payload.title, active: false });
  }
  if (payload.type === 'tab_activated' && payload.tabId) {
    upsertRemoteTab({ tabId: payload.tabId, url: payload.url, title: payload.title, active: true });
  }
  if (payload.type === 'tab_removed' && payload.tabId) {
    remoteTabs.delete(payload.tabId);
  }
  if (payload.type === 'login_state' && payload.tabId) {
    upsertRemoteTab({ tabId: payload.tabId, loginState: payload.loginState });
  }
  const msg = { id: uuidv4(), ...payload, receivedAt: new Date().toISOString() };
  const raw = JSON.stringify(msg);
  wsClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(raw);
  });
  res.status(202).json({ queued: wsClients.size });
});

// Push commands from bridge to extension via WS
function broadcastToWS(msg) {
  const raw = JSON.stringify({ ...msg, _bridge: true });
  wsClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(raw);
  });
}

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[hermes-browser-bridge] HTTP + WS on http://127.0.0.1:${PORT}`);
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify({ type: 'connected', at: new Date().toISOString() }));
  ws.on('close', () => wsClients.delete(ws));
  ws.on('error', () => wsClients.delete(ws));
  ws.on('message', (raw) => {
    const msg = raw.toString();
    const id = uuidv4();
    wsClients.forEach((client) => {
      if (client !== ws && client.readyState === 1) client.send(JSON.stringify({ id, from: 'ws', body: msg }));
    });
    ws.send(JSON.stringify({ id, ok: true, bytes: Buffer.byteLength(msg) }));
  });
});

process.on('SIGINT', async () => {
  console.log('\n[hermes-browser-bridge] shutting down…');
  wss.close();
  server.close();
  try { if (browser) await browser.close(); } catch {}
  process.exit(0);
});
