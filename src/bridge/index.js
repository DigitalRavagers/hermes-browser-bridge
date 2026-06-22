const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const chromium = require('playwright').chromium;
const path = require('path');

const PORT = parseInt(process.env.HERMES_BRIDGE_PORT || '8765', 10);
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'pages')));

let browser = null;
let wsClients = new Set();

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  return browser;
}

async function renderPage({ url, width = 1280, height = 800, fullPage = false }) {
  const b = await getBrowser();
  const page = await b.newPage({ viewport: { width, height } });
  await page.setExtraHTTPHeaders({ 'user-agent': 'Mozilla/5.0 (compatible; Hermes Browser Bridge)' });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Give SPA shells time to paint
    await page.waitForTimeout(1500);
    const buffer = await page.screenshot({ fullPage, type: 'png' });
    await page.close();
    return buffer.toString('base64');
  } catch (e) {
    await page.close();
    throw e;
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

// Health
app.get('/health', async () => json({ ok: true, service: 'hermes-browser-bridge', time: new Date().toISOString() }));

// Screenshot endpoint
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

// Light page summary: title + text + links
app.post('/summarize', async (req, res) => {
  const { url, width } = req.body || {};
  if (!url) return json({ error: 'url required' }, 400);
  try {
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

// Lightweight browser control – sends simulated input to the local Chromium instance
app.post('/control', async (req, res) => {
  const { action, selector, url, text, x, y } = req.body || {};
  const b = await getBrowser();
  const context = await b.contexts().catch(() => null);
  const pages = context?.pages?.() || [];
  // Prefer a visible tab when available, else create one
  let page = pages.find(p => !p.isClosed());
  if (!page) page = await getBrowser().then(b => b.newPage());
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

app.post('/event', (req, res) => {
  const msg = { id: uuidv4(), ...req.body, receivedAt: new Date().toISOString() };
  const payload = JSON.stringify(msg);
  wsClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(payload);
  });
  res.status(202).json({ queued: wsClients.size });
});

// Agent-friendly transport
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
    // fan to everyone except sender
    wsClients.forEach((client) => {
      if (client !== ws && client.readyState === 1) client.send(JSON.stringify({ id, from: 'ws', body: msg }));
    });
    // minimal echo confirming receipt
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
