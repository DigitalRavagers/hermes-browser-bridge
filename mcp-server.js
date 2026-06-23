#!/usr/bin/env node
// MCP server wrapper for hermes-browser-bridge
// Any MCP-compatible CLI (Claude Code, Kilo, Hermes) adds this to their mcp.json

const readline = require('readline');
const http = require('http');

const BRIDGE = process.env.HERMES_BRIDGE_URL || 'http://127.0.0.1:8765';
const API_KEY = process.env.HERMES_BRIDGE_API_KEY || 'AmRukJ3tUWziMIhToNybvZCjlPX8ancL';

async function call(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BRIDGE);
    const opts = {
      hostname: url.hostname, port: url.port || 80, path: url.pathname + url.search,
      method, headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' }
    };
    const req = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const TOOLS = [
  {
    name: 'get_tabs',
    description: 'List all open browser tabs with URL, title, and login state',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'screenshot',
    description: 'Take a screenshot of a URL or the active tab. Returns base64 PNG.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to screenshot. Omit to use active tab.' },
        width: { type: 'number', default: 1280 },
        height: { type: 'number', default: 800 }
      }
    }
  },
  {
    name: 'summarize',
    description: 'Get the title, visible text, and links from a URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to summarize' } },
      required: ['url']
    }
  },
  {
    name: 'navigate',
    description: 'Navigate the active browser tab to a URL',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab ID to navigate. Uses active tab if omitted.' },
        url: { type: 'string', description: 'URL to navigate to' }
      },
      required: ['url']
    }
  },
  {
    name: 'click',
    description: 'Click an element in the active tab by CSS selector',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of element to click' },
        tabId: { type: 'number' }
      },
      required: ['selector']
    }
  },
  {
    name: 'type_text',
    description: 'Type text into an input field in the active tab',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of input field' },
        text: { type: 'string', description: 'Text to type' },
        tabId: { type: 'number' }
      },
      required: ['selector', 'text']
    }
  },
  {
    name: 'get_page_text',
    description: 'Get the visible text content of the active tab',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } }
    }
  },
  {
    name: 'switch_tab',
    description: 'Switch to a specific tab by tabId',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      required: ['tabId']
    }
  },
  {
    name: 'new_tab',
    description: 'Open a new browser tab, optionally at a URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } }
    }
  },
  {
    name: 'close_tab',
    description: 'Close a browser tab by tabId',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'number' } },
      required: ['tabId']
    }
  },
  {
    name: 'get_login_states',
    description: 'Detect login state across all open tabs',
    inputSchema: { type: 'object', properties: {} }
  }
];

async function handleTool(name, args) {
  switch (name) {
    case 'get_tabs':
      return await call('/tabs');

    case 'screenshot': {
      if (args.url) return await call('/screenshot', 'POST', { url: args.url, width: args.width || 1280, height: args.height || 800 });
      // active tab — use control endpoint
      return await call('/control', 'POST', { action: 'screenshot' });
    }

    case 'summarize':
      return await call('/summarize', 'POST', { url: args.url });

    case 'navigate': {
      const tabId = args.tabId;
      if (tabId) return await call(`/tabs/${tabId}/activate`, 'POST').then(() => call('/control', 'POST', { action: 'navigate', url: args.url }));
      return await call('/control', 'POST', { action: 'navigate', url: args.url });
    }

    case 'click':
      return await call('/control', 'POST', { action: 'click', selector: args.selector });

    case 'type_text':
      return await call('/control', 'POST', { action: 'type', selector: args.selector, text: args.text });

    case 'get_page_text':
      return await call('/control', 'POST', { action: 'get_text' });

    case 'switch_tab':
      return await call(`/tabs/${args.tabId}/activate`, 'POST');

    case 'new_tab':
      return await call('/control', 'POST', { action: 'new_tab', url: args.url });

    case 'close_tab':
      return await call('/control', 'POST', { action: 'close_tab', tabId: args.tabId });

    case 'get_login_states':
      return await call('/tabs/login-states', 'POST');

    default:
      throw new Error('Unknown tool: ' + name);
  }
}

// MCP JSON-RPC over stdio
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

rl.on('line', async line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'hermes-browser-bridge', version: '0.1.0' }
    }});
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    try {
      const result = await handleTool(msg.params.name, msg.params.arguments || {});
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
      }});
    } catch (e) {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true
      }});
    }
  } else if (msg.method === 'notifications/initialized') {
    // no-op
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
});
