# Hermes Browser Bridge

Chrome extension + local bridge that lets any agent (Hermes, Claude Code, etc.) see and drive your browser.

## What it gives an agent

- See current URL, page title, DOM, and visible text
- Capture screenshots of the active browser or any URL
- Click buttons, type inputs, scroll
- Run arbitrary JS in-page
- Connect to your real running Chrome via CDP for live-tab control
- Login state detection across all tabs (logged in / logged out / unknown)
- Multi-tab orchestration: list, switch, close, create, batch-command across tabs
- Communicate via Chrome native messaging or localhost HTTP/WebSocket

## Modes

| Mode | How | Best for |
|------|-----|----------|
| **Headless** | Bridge launches its own Chromium | Private page renders, screenshots |
| **CDP** | Bridge attaches to an existing Chrome via `--remote-debugging-port` | Control your real browser tabs with login state intact |

CDP keeps your session cookies and logged-in state available to the agent.

## Download & install

### 1. Get the code

```bash
git clone https://github.com/DigitalRavagers/hermes-browser-bridge.git
cd hermes-browser-bridge
npm install
```

### 2. Run the bridge

```bash
npm run dev
```

Leave this terminal open. You should see:
```
[hermes-browser-bridge] HTTP + WS on http://127.0.0.1:8765
```

### 3. Load the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select the folder: `C:\path\to\hermes-browser-bridge\src\extension`
5. Pin the extension so its icon is always visible in the toolbar

### 4. Open the bridge dashboard (optional)

Navigate to: `http://localhost:8765`

You’ll see:
- Live tab list with login badges
- Screenshot and summarize tools
- Agent control panel
- Live event console

### 5. Register native messaging (Windows, optional)

Run this once so the extension can talk to the bridge without opening a port:

```powershell
node scripts/register-native-host.js
```

Restart Chrome after running it.

### 6. Use CDP mode with your real browser (optional but powerful)

Close all Chrome windows completely, then restart with remote debugging:

```powershell
chrome.exe --remote-debugging-port=9222
```

Then, from the dashboard or extension popup, connect to `http://127.0.0.1:9222`.

## Quick test

```bash
# Health
curl http://127.0.0.1:8765/health

# List tabs (requires extension loaded)
curl http://127.0.0.1:8765/tabs

# Detect login states across all tabs (requires extension loaded)
curl -X POST http://127.0.0.1:8765/tabs/login-states

# Headless screenshot
curl -X POST http://127.0.0.1:8765/screenshot -H 'content-type: application/json' -d '{"url":"https://example.com"}'
```

## Agent protocol

Base URL: `http://127.0.0.1:8765`

### Multi-tab endpoints

| Endpoint | Method | Body / params | Returns |
|----------|--------|---------------|---------|
| `/tabs` | GET | `?source=extension\|cdp` | Array of tabs with `tabId`, `url`, `title`, `loginState` |
| `/tabs/:tabId/activate` | POST | — | Queued switch command |
| `/tabs/login-states` | POST | — | Triggers detection across all extension-reported tabs |

### Control actions (via `/control` or extension proxy)

| Action | Params | Returns |
|--------|--------|---------|
| `list_tabs` | — | `{ tabs: [{ id, url, title, active, loginState }] }` |
| `switch_tab` | `tabId` | `{ switched, tabId, url, title }` |
| `close_tab` | `tabId` | `{ closed, tabId }` |
| `new_tab` | `url?` | `{ created, tabId }` |
| `batch_command` | `commands[]`, `targetTabIds?` | `{ executed, results }` |
| `detect_login_state` | `tabId` | `{ tabId, loginState }` |
| `detect_all_login_states` | — | `{ detections }` |
| `get_url` | — | `{ url }` |
| `get_title` | — | `{ title }` |
| `get_html` | — | HTML string |
| `get_text` | — | `{ text }` |
| `screenshot` | `width`, `height`, `fullPage` | `{ dataUrl }` |
| `navigate` | `url` | `{ navigated }` |
| `click` | `selector` | `{ clicked }` |
| `type` | `selector`, `text` | `{ typed }` |
| `scroll` | `x`, `y` | `{ scrolled }` |
| `evaluate` | `fn`, `args` | `{ result }` |

## Login state detection

The extension runs `detectLoginState()` in every tab and reports results back to the bridge over WebSocket. Signals checked:

- Visible password / email input fields
- Text cues: *“Sign in”*, *“Log in”*, *“Sign up”*
- Session tokens in `localStorage` / `sessionStorage` (keys matching `token`, `access_token`, `jwt`, `session`, etc.)
- Logged-in UI elements: avatars, profile links, settings routes
- URL route patterns: `/login`, `/signin`, `/signup`, `/forgot-password`

Result shape:
```json
{
  "logged_out": true,
  "confidence": "high",
  "reason": "password_field_present",
  "indicators": ["ui:{...}", "token_keys:[]"],
  "url": "...",
  "hostname": "..."
}
```

## Architecture

```
Chrome ↔ Extension ↔ (native pipe / localhost) ↔ Bridge ↔ Playwright / CDP ↔ Agent (HTTP/WS)
```

- **Extension** surfaces current tab state, forwards commands, detects login state across tabs.
- **Bridge** renders pages, controls Chromium headless, or attaches via CDP to your real browser.
- **Agent** talks over REST/WebSocket.

## Disclaimer

Developer preview. Anything the bridge can see, the connected local server can read. Use only on a trusted desktop.
