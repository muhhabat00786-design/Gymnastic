# AI Fast Agent Assistant

A fully autonomous, ultra-fast Chrome extension powered by AI that can navigate, read elements, and directly control your browser using low-level Chrome DevTools Protocol (CDP) commands.

This extension doesn't rely on an external Python server. The entire AI reasoning loop, API calls, and browser interactions run seamlessly within the extension's background service worker, accessible via a beautifully designed glassmorphic Chat UI in the browser's Side Panel.

## Features

- **No Local Server Required:** Fully self-contained JavaScript agent.
- **Fast Chat UI:** A responsive, animated, colorful side panel for direct communication.
- **Hardware-Level Automation:** Uses CDP (`chrome.debugger`) to dispatch native keystrokes and mouse events to avoid bot detection and interact accurately.
- **Autonomous Reasoning:** Automatically fetches elements (`browser_get_elements`), plans actions, and executes steps via OpenAI tool calling.

## Setup Instructions

1. **Load the Extension in Chrome:**
   - Open Chrome and navigate to `chrome://extensions/`.
   - Enable **Developer mode** in the top right corner.
   - Click **Load unpacked** and select the `extension` folder from this directory.

2. **Configure API Settings:**
   - Click the extension icon in your toolbar, or click the **⚙️ Settings** icon in the top right corner of the extension's Side Panel chat.
   - Enter your **API Key** (e.g., an OpenAI API key starting with `sk-...`).
   - (Optional) Configure a custom Base URL or Model name.
   - Click **Save Configuration**.

3. **Start Chatting:**
   - The AI Assistant will appear in the Chrome Side Panel.
   - Ask it to do something! Try:
     - *"Open youtube and search for synthwave music"*
     - *"Go to example.com and tell me what the main header says"*

## Permissions Explained

- `debugger`: Required to use Chrome DevTools Protocol for sending trusted physical inputs (clicks/keys) rather than synthetic JavaScript events that get blocked by modern sites.
- `sidePanel`: Required to render the chat interface alongside your active tabs.
- `storage`: Required to securely save your API configuration locally.
- `scripting`, `activeTab`, `tabs`: Required to read elements off the page and navigate.

## Development

The main reasoning loop resides in `background.js`. It fetches page elements, packages them as tools (`browser_navigate`, `browser_trusted_click`, etc.), and iterates through the LLM response. The UI components live in `sidepanel.html/js`.
