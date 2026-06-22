#!/usr/bin/env node

// Native messaging host: reads JSON-RPC messages from stdin, writes to stdout.
// Registered via Windows registry or ~/.config/google-chrome/NativeMessagingHosts/
const readline = require('readline');

const HOST_PATH = 'http://127.0.0.1:8765';
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch {
    send({ id: null, error: 'invalid_json' });
    return;
  }
  const { id, method, params } = msg;
  try {
    const result = await route(method, params || {});
    send({ id, result });
  } catch (e) {
    send({ id, error: String(e) });
  }
});

async function route(method, params) {
  switch (method) {
    case 'health_check':
      return { ok: true };

    case 'proxy_request': {
      const r = await fetch(`${HOST_PATH}${params.path}`, {
        method: params.method || 'POST',
        headers: { 'Content-Type': 'application/json', ...(params.headers || {}) },
        body: params.body ? JSON.stringify(params.body) : undefined
      });
      if (params.raw) return { status: r.status, text: await r.text() };
      const ct = r.headers.get('content-type') || '';
      return { status: r.status, json: ct.includes('json') ? await r.json() : await r.text() };
    }

    case 'open_dashboard':
      return { opened: true, url: 'http://127.0.0.1:8765' };

    default:
      throw new Error('unknown_method: ' + method);
  }
}

function send(obj) {
  const payload = JSON.stringify(obj);
  const len = Buffer.byteLength(payload, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(len, 0);
  process.stdout.write(header);
  process.stdout.write(payload, 'utf8');
}
