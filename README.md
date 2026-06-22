# Hermes Browser Bridge

Chrome extension + local bridge that lets any agent see and drive your browser.

## What it gives an agent

- See current URL / page title
- Read DOM, visible text, links, metadata
- Capture screenshots of the active browser or any URL
- Click buttons, type inputs, scroll
- Run arbitrary JS in-page
- Connect to your real running Chrome via CDP for live-tab control
- Communicate with the bridge using Chrome's native messaging (no open port)

## Modes

| Mode | How | Best for |
|------|-----|----------|
| **headless** | Bridge launches its own Chromium | Private page renders, screenshots |
| **CDP** | Bridge attaches to an existing Chrome via `--remote-debugging-port` | Control your real browser tabs with login state intact |

CDP is the closer-to-magic mode. It keeps your sessions (email, dashboards, logged-in apps) available to the agent.

## Quick start

```bash
git clone https://github.com/DigitalRavagers/hermes-browser-bridge.git
cd hermes-browser-bridge
npm install
npx playwright install chromium   # needed for headless renders
npm run dev
```

Then in Chrome:
1. `chrome://extensions` → Developer mode → **Load unpacked** → `src/extension`
2. Pin the extension
3. Bridge dashboard at `http://localhost:8765`

**CDP mode (real Chrome):**
1. Close all Chrome windows completely
2. Restart with remote debugging: `chrome.exe --remote-debugging-port=9222`
3. In bridge dashboard or extension popup, connect to `http://127.0.0.1:9222`

## Native messaging (Windows)

Register the host so the extension can call the bridge without a port:

```powershell
# From the repo root
node scripts/register-native-host.js
```

Restart Chrome after running the script.

## Running in the background (tray)

On desktop machines, use the bundled Electron tray:

```bash
npm install
npm run tray
```

This keeps the bridge warm in the notification area without a terminal window. Requires `electron` (already in devDependencies).

## Agent protocol (HTTP)

Base URL: `http://127.0.0.1:8765`

```bash
curl http://127.0.0.1:8765/health

# Headless screenshot
curl -X POST http://127.0.0.1:8765/screenshot -H 'content-type: application/json' -d '{"url":"https://example.com"}'

# Connect CDP (then subsequent calls operate on real browser)
curl -X POST http://127.0.0.1:8765/cdp/connect -H 'content-type: application/json' -d '{"endpoint":"http://127.0.0.1:9222"}'
```

## Actions

| Action | Params | Returns |
|--------|--------|---------|
| `get_url` | — | `{ url }` |
| `get_title` | — | `{ title }` |
| `get_html` | — | full HTML |
| `get_text` | — | `{ text }` |
| `screenshot` | `url`, `width`, `height`, `fullPage` | `{ dataUrl }` |
| `summarize` | `url` | `{ title, url, text, links }` |
| `navigate` | `url` | `{ navigated }` |
| `click` | `selector` | `{ clicked }` |
| `type` | `selector`, `text` | `{ typed }` |
| `scroll` | `x`, `y` | `{ scrolled }` |
| `evaluate` | `fn`, `args` | `{ result or error }` |

## Architecture

```
Chrome ↔ Extension ↔ (native pipe) ↔ Bridge ↔ Playwright / CDP ↔ Agent (HTTP/WS)
```

- **Extension** surfaces current tab state, forwards commands, optionally uses native messaging.
- **Bridge** renders pages, controls Chromium headless, or attaches via CDP.
- **Agent** talks over REST/WebSocket. After SSH tunnel fix, the VPS can reach the desktop bridge through the tunnel.

## Disclaimer

Developer preview. Treat it as trusted local software. Anything it can see, the connected local server can read. Review before pointing it at a sensitive session.
