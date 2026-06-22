# Hermes Browser Bridge

Chrome extension + local bridge that lets any agent (Hermes, Claude Code, OpenClaw, etc.) see and control your Chrome browser.

## What it gives an agent

- See the current URL and page title
- Read DOM and visible text
- Capture screenshots
- Click elements, type into inputs, scroll
- Execute arbitrary JS in page context
- Receive live messages over WebSocket

## Quick start (requires Node.js 18+)

```bash
git clone https://github.com/DigitalRavagers/hermes-browser-bridge.git
cd hermes-browser-bridge
npm install
npm run dev
```

Then in Chrome:
1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select `src/extension`
4. Pin the extension so you can access it

Open the bridge dashboard: `http://localhost:8765`

## Agent protocol (HTTP)

Base URL: `http://127.0.0.1:8765`

```bash
# Health
curl http://127.0.0.1:8765/health

# Screenshot a page
curl -X POST http://127.0.0.1:8765/screenshot -H 'content-type: application/json' -d '{"url":"https://example.com","width":1280,"height":800}'

# Run a control action (click, type, screenshot from current browsers, evaluate JS)
curl -X POST http://127.0.0.1:8765/control -H 'content-type: application/json' -d '{"action":"screenshot"}'
curl -X POST http://127.0.0.1:8765/control -H 'content-type: application/json' -d '{"action":"click","selector":"a[href*=github]"}'
curl -X POST http://127.0.0.1:8765/control -H 'content-type: application/json' -d '{"action":"type","selector":"input[name=q]","text":"hello"}'
curl -X POST http://127.0.0.1:8765/control -H 'content-type: application/json' -d '{"action":"evaluate","fn":"document.title"}'
```

### Actions

| Action | Params | Returns |
|--------|--------|---------|
| `get_url` | — | `{ url }` |
| `get_title` | — | `{ title }` |
| `get_html` | — | full HTML |
| `get_text` | — | `{ text }` |
| `screenshot` | `width`, `height`, `fullPage` | `{ dataUrl }` |
| `summarize` | `url` | `{ title, url, text, links }` |
| `navigate` | `url` | `{ navigated }` |
| `click` | `selector` | `{ clicked }` |
| `type` | `selector`, `text` | `{ typed }` |
| `scroll` | `x`, `y` | `{ scrolled }` |
| `evaluate` | `fn`, `args` | `{ result }` |

## Architecture

```
Chrome <-> Extension <-> (localhost) <-> Bridge server <-> Playwright <-> Agent terms HTTP/WS
```

The extension annotates pages and forwards agent commands. The bridge runs Playwright so it can render even URLs the extension can’t reach directly (login-protected apps, SPAs).

## Disclaimer

This is an early prototype. Treat it like developer preview. Anything it can see, the connected local server can read. Don’t point it at a session you don’t want exposed.
