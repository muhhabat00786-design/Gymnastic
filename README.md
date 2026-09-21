# Ultra-Fast Chrome Browser Controller & MCP Automation Suite

A production-grade, ultra-fast, zero-lag Chrome Browser Automation Suite composed of a Manifest V3 Chrome Extension, a Model Context Protocol (MCP) Server (Python FastMCP), and a local WebSocket + HTTP REST Bridge providing instantaneous sub-50ms execution latency.

## Architecture

1. **Manifest V3 Google Chrome Extension**: Uses `chrome.debugger` to provide trusted hardware input and fast DOM interactions.
2. **High-Performance MCP Server (`server/server.py`)**: Built with Python's `fastmcp` to expose browser control tools to AI coding agents over stdio.
3. **Local REST Bridge**: `127.0.0.1:18823` allows CLI tools to trigger commands quickly.
4. **WebSocket Connection**: `127.0.0.1:18822` maintains a persistent sub-millisecond link between the extension and the server.

## Features

- **Zero Artificial Delays**: Smart DOM polling (`requestAnimationFrame` / 20ms intervals).
- **Fast Navigation**: Resolves as soon as `DOMContentLoaded` occurs to avoid modern stream site hangs.
- **Persistent Service Worker**: Active heartbeat pings keep the background worker alive 24/7.
- **Clean STDIO**: MCP server strictly outputs JSON-RPC on STDOUT. All logs go to STDERR.

## Requirements

- Python 3.10+
- `pip install fastmcp websockets`
- Google Chrome browser

## Setup Guide

### 1. Start the MCP Server

```bash
pip install fastmcp websockets
python -m server.server
```
*Note: Run via your IDE's MCP config (see below) for full AI integration.*

### 2. Install the Chrome Extension

1. Open Google Chrome.
2. Navigate to `chrome://extensions/`.
3. Enable **Developer mode** in the top right.
4. Click **Load unpacked** and select the `extension/` directory from this repository.
5. You should see the "Ultra-Fast Chrome Automation" extension added. Click its icon in the toolbar to see the status.

### 3. Connect IDEs via MCP

#### Claude Desktop Configuration
Add the following to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "chrome": {
      "command": "python",
      "args": ["-m", "server.server"]
    }
  }
}
```

#### Cursor Configuration
1. Open Cursor Settings > Features > MCP.
2. Add a new MCP server.
3. Name: `chrome`
4. Command: `python -m server.server`
5. Type: `stdio`

#### Antigravity Configuration
Add to your environment config or MCP list:
```json
{
  "mcpServers": {
    "chrome": {
      "command": "python",
      "args": ["-m", "server.server"]
    }
  }
}
```

## Tools Provided to AI Agents

- `browser_status()`
- `browser_navigate(url, new_tab, wait_until)`
- `browser_trusted_click(selector, x, y)`
- `browser_trusted_type(text)`
- `browser_trusted_press_key(key)`
- `browser_wait_and_click(selector, timeout_seconds)`
- `browser_batch(steps)`
- `browser_upload_file(file_paths, selector)`
- `browser_screenshot(full_page, output_path)`
- `browser_annotate_elements()`
- `browser_clear_annotations()`
- `browser_get_elements()`
- `browser_get_text()`
- `browser_scroll(direction, amount)`
- `browser_eval(script)`
- `browser_cdp(method, params)`
- `browser_cookies(action, domain, name, value)`
- `browser_tabs(action, tab_id, url)`

## Troubleshooting

- **Server Offline in Extension UI**: Make sure `python -m server.server` is running.
- **WebSocket Disconnected**: Click the extension icon and hit "Reconnect" if the connection drops. The background script also attempts to auto-reconnect every 2 seconds.
- **Missing python packages**: Make sure to `pip install fastmcp websockets`.
