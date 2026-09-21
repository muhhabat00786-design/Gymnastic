// Chrome MV3 background script for zero-lag Browser Automation

const WS_URL = 'ws://127.0.0.1:18822';
let ws = null;
let reconnectInterval = null;
let keepAliveInterval = null;

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  console.log('Connecting to WebSocket...', WS_URL);
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log('WebSocket connected');
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }

    // Setup keep-alive heartbeat loop every 10 seconds to keep service worker active
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
    }
    keepAliveInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'heartbeat' }));
      } else {
        // Also ping chrome alarms to ensure worker stays awake
        chrome.alarms.create('keepAlive', { delayInMinutes: 0.1 });
      }
    }, 10000);
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (e) {
      console.error('Failed to parse WebSocket message', e);
      return;
    }

    if (msg.type === 'heartbeat') return;

    if (msg.id) {
      try {
        const result = await handleCommand(msg);
        ws.send(JSON.stringify({ id: msg.id, success: true, result }));
      } catch (err) {
        ws.send(JSON.stringify({ id: msg.id, success: false, error: err.message || String(err) }));
      }
    }
  };

  ws.onclose = () => {
    console.log('WebSocket closed. Reconnecting in 2 seconds...');
    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    if (!reconnectInterval) {
      reconnectInterval = setInterval(connectWebSocket, 2000);
    }
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
    ws.close();
  };
}

// Keep-alive using alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Just waking up the service worker
    console.log('Service worker woke up via alarm');
  }
});
chrome.alarms.create('keepAlive', { periodInMinutes: 0.1 }); // Every 6 seconds just in case

connectWebSocket();

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) {
    const allTabs = await chrome.tabs.query({});
    if (allTabs.length > 0) return allTabs[0];
    throw new Error("No active tab found");
  }
  return tabs[0];
}

async function ensureDebuggerAttached(tabId) {
  const targets = await chrome.debugger.getTargets();
  const isAttached = targets.some(t => t.tabId === tabId && t.attached);
  if (!isAttached) {
    await chrome.debugger.attach({ tabId }, "1.3");
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    // Input doesn't have an explicit enable command in CDP, but it's available
  }
}

// Helper to run script in tab
async function runScript(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: func,
    args: args
  });
  if (results && results[0] && results[0].result !== undefined) {
    return results[0].result;
  }
  return null;
}

const keyMap = {
  'Enter': { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  'Escape': { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  'Tab': { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  'Backspace': { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
};

async function handleCommand(msg) {
  const method = msg.method;
  const params = msg.params || {};

  if (method === 'browser_status') {
    let tabId = null, url = null;
    try {
      const tab = await getActiveTab();
      tabId = tab.id;
      url = tab.url;
    } catch(e) {}
    return { status: 'ok', connected: true, active_tab_id: tabId, active_tab_url: url };
  }

  // General tab handling
  let tab;
  if (params.tabId) {
    tab = await chrome.tabs.get(params.tabId);
  } else if (method !== 'browser_tabs') { // browser_tabs might not need an active tab initially
    try {
      tab = await getActiveTab();
    } catch (e) {}
  }

  if (!tab && method !== 'browser_tabs') {
    throw new Error('No tab available');
  }

  if (tab) {
    await ensureDebuggerAttached(tab.id);
  }

  switch (method) {
    case 'browser_navigate': {
      const { url, new_tab, wait_until } = params;
      let targetTabId = tab ? tab.id : null;
      if (new_tab || !targetTabId) {
        const newTab = await chrome.tabs.create({ url, active: true });
        targetTabId = newTab.id;
        await ensureDebuggerAttached(targetTabId);
      } else {
        await chrome.tabs.update(targetTabId, { url });
      }

      if (wait_until === 'none') {
        return { status: 'navigating' };
      }

      // Wait until DOMContentLoaded
      return new Promise((resolve) => {
        let isResolved = false;
        let timeoutId;

        const cleanup = () => {
          if (isResolved) return;
          isResolved = true;
          chrome.tabs.onUpdated.removeListener(listener);
          if (chrome.webNavigation) {
            chrome.webNavigation.onDOMContentLoaded.removeListener(webNavListener);
          }
          clearTimeout(timeoutId);
        };

        const listener = (navTabId, changeInfo) => {
          if (navTabId === targetTabId && changeInfo.status === 'complete') { // Fallback
            cleanup();
            resolve({ status: 'complete' });
          }
        };
        chrome.tabs.onUpdated.addListener(listener);

        // Also check via webNavigation for DOMContentLoaded
        const webNavListener = (details) => {
          if (details.tabId === targetTabId && details.frameId === 0) {
            cleanup();
            resolve({ status: 'dom_content_loaded' });
          }
        };
        if (chrome.webNavigation) {
          chrome.webNavigation.onDOMContentLoaded.addListener(webNavListener);
        }

        // Timeout safeguard
        timeoutId = setTimeout(() => {
          cleanup();
          resolve({ status: 'timeout' });
        }, 15000);
      });
    }

    case 'browser_trusted_click': {
      const { selector, x, y } = params;
      let clickX = x, clickY = y;

      if (selector) {
        // Resolve coords from selector
        const res = await runScript(tab.id, (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }, [selector]);
        if (!res) throw new Error(`Selector not found: ${selector}`);
        clickX = res.x;
        clickY = res.y;
      }

      if (clickX === undefined || clickY === undefined) {
        throw new Error("Must provide selector or x/y coordinates");
      }

      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: clickX,
        y: clickY,
        button: 'left',
        clickCount: 1
      });
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: clickX,
        y: clickY,
        button: 'left',
        clickCount: 1
      });
      return { status: 'clicked', x: clickX, y: clickY };
    }

    case 'browser_trusted_type': {
      const { text } = params;
      for (const char of text) {
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
          type: 'keyDown',
          text: char,
          unmodifiedText: char
        });
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
          type: 'keyUp'
        });
      }
      return { status: 'typed', length: text.length };
    }

    case 'browser_trusted_press_key': {
      const { key } = params;
      const keyInfo = keyMap[key] || { key: key, code: key, text: key.length === 1 ? key : undefined };

      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        windowsVirtualKeyCode: keyInfo.windowsVirtualKeyCode,
        nativeVirtualKeyCode: keyInfo.nativeVirtualKeyCode,
        key: keyInfo.key,
        code: keyInfo.code
      });
      if (keyInfo.text) {
         await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
            type: 'char',
            text: keyInfo.text,
            unmodifiedText: keyInfo.text
         });
      }
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: keyInfo.key,
        code: keyInfo.code
      });
      return { status: 'pressed', key };
    }

    case 'browser_wait_and_click': {
      const { selector, timeout_seconds = 8 } = params;

      const found = await runScript(tab.id, async (sel, timeout) => {
        return new Promise((resolve) => {
          const el = document.querySelector(sel);
          if (el) {
            el.click();
            resolve(true);
            return;
          }

          const observer = new MutationObserver(() => {
            const el = document.querySelector(sel);
            if (el) {
              observer.disconnect();
              el.click();
              resolve(true);
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });

          let pollInterval = setInterval(() => {
             const el = document.querySelector(sel);
             if (el) {
               observer.disconnect();
               clearInterval(pollInterval);
               el.click();
               resolve(true);
             }
          }, 20);

          setTimeout(() => {
            observer.disconnect();
            clearInterval(pollInterval);
            resolve(false);
          }, timeout * 1000);
        });
      }, [selector, timeout_seconds]);

      if (!found) throw new Error(`Timeout waiting for ${selector}`);
      return { status: 'clicked', selector };
    }

    case 'browser_upload_file': {
      const { file_paths, selector = "input[type='file']" } = params;

      const doc = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.getDocument', { depth: -1 });
      const node = await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: selector
      });

      if (!node.nodeId) throw new Error(`File input selector not found: ${selector}`);

      await chrome.debugger.sendCommand({ tabId: tab.id }, 'DOM.setFileInputFiles', {
        nodeId: node.nodeId,
        files: file_paths
      });
      return { status: 'files_uploaded', count: file_paths.length };
    }

    case 'browser_screenshot': {
      const { full_page } = params;

      if (full_page) {
        const metrics = await runScript(tab.id, () => {
          return {
            width: document.documentElement.scrollWidth,
            height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
          };
        });

        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Emulation.setDeviceMetricsOverride', {
          mobile: false,
          width: metrics.width,
          height: metrics.height,
          deviceScaleFactor: 1
        });
      }

      const res = await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.captureScreenshot', { format: 'png' });

      if (full_page) {
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Emulation.clearDeviceMetricsOverride');
      }

      return { status: 'captured', data: res.data }; // Returns base64
    }

    case 'browser_batch': {
      const { steps } = params;
      const results = [];
      for (const step of steps) {
        const stepMsg = { method: step.method, params: step.params };
        results.push(await handleCommand(stepMsg));
      }
      return { status: 'batch_complete', results };
    }

    case 'browser_annotate_elements': {
      const count = await runScript(tab.id, () => {
        let count = 0;
        const selectors = 'button, a, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
        const elements = document.querySelectorAll(selectors);

        // Remove old
        document.querySelectorAll('.ai-mcp-annotation').forEach(el => el.remove());

        elements.forEach(el => {
           const rect = el.getBoundingClientRect();
           if (rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden') {
             count++;
             const badge = document.createElement('div');
             badge.className = 'ai-mcp-annotation';
             badge.textContent = '[' + count + ']';
             badge.style.position = 'absolute';
             badge.style.left = (rect.left + window.scrollX) + 'px';
             badge.style.top = (rect.top + window.scrollY) + 'px';
             badge.style.backgroundColor = 'rgba(255, 0, 0, 0.8)';
             badge.style.color = 'white';
             badge.style.padding = '2px 4px';
             badge.style.fontSize = '12px';
             badge.style.borderRadius = '3px';
             badge.style.zIndex = '2147483647';
             badge.style.pointerEvents = 'none';
             badge.style.boxShadow = '0 0 5px rgba(0,0,0,0.5)';
             document.body.appendChild(badge);
           }
        });
        return count;
      });
      return { status: 'annotated', count };
    }

    case 'browser_clear_annotations': {
      await runScript(tab.id, () => {
        document.querySelectorAll('.ai-mcp-annotation').forEach(el => el.remove());
      });
      return { status: 'cleared' };
    }

    case 'browser_get_elements': {
      const elements = await runScript(tab.id, () => {
        const items = [];
        const selectors = 'button, a, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
        const els = document.querySelectorAll(selectors);
        let id = 1;
        els.forEach(el => {
           const rect = el.getBoundingClientRect();
           if (rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden') {
             let tag = el.tagName.toLowerCase();
             let text = el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '';
             items.push({
               id: id++,
               tag: tag,
               text: text.trim().substring(0, 100),
               x: rect.left + rect.width / 2,
               y: rect.top + rect.height / 2,
               width: rect.width,
               height: rect.height,
               selector: `${tag}${el.id ? '#'+el.id : ''}${el.className ? '.'+el.className.split(' ').join('.') : ''}`
             });
           }
        });
        return items;
      });
      return { status: 'success', elements };
    }

    case 'browser_get_text': {
      const text = await runScript(tab.id, () => {
         return document.body.innerText;
      });
      const title = await runScript(tab.id, () => document.title);
      return { status: 'success', title, text: text.substring(0, 50000) }; // cap size
    }

    case 'browser_scroll': {
      const { direction, amount } = params;
      await runScript(tab.id, (dir, amt) => {
        if (dir === 'down') window.scrollBy(0, amt);
        else if (dir === 'up') window.scrollBy(0, -amt);
      }, [direction, amount]);
      return { status: 'scrolled', direction, amount };
    }

    case 'browser_eval': {
      const { script } = params;
      const res = await runScript(tab.id, (code) => {
        try {
          // eslint-disable-next-line no-eval
          return eval(code);
        } catch(e) {
          return e.toString();
        }
      }, [script]);
      return { status: 'evaluated', result: res };
    }

    case 'browser_cdp': {
      const { method: cdpMethod, params: cdpParams } = params;
      const res = await chrome.debugger.sendCommand({ tabId: tab.id }, cdpMethod, cdpParams);
      return { status: 'success', result: res };
    }

    case 'browser_cookies': {
      const { action, domain, name, value } = params;
      if (action === 'get_all') {
         const cookies = await chrome.cookies.getAll(domain ? {domain} : {});
         return { cookies };
      } else if (action === 'set') {
         await chrome.cookies.set({ url: domain.startsWith('http') ? domain : `https://${domain}`, name, value });
         return { status: 'set' };
      }
      return { status: 'unknown_action' };
    }

    case 'browser_tabs': {
      const { action, tab_id, url } = params;
      if (action === 'list') {
         const tabs = await chrome.tabs.query({});
         return { tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active })) };
      } else if (action === 'create') {
         const newTab = await chrome.tabs.create({ url, active: true });
         return { tabId: newTab.id };
      } else if (action === 'close') {
         await chrome.tabs.remove(tab_id);
         return { status: 'closed' };
      } else if (action === 'switch') {
         await chrome.tabs.update(tab_id, { active: true });
         return { status: 'switched' };
      }
      return { status: 'unknown_action' };
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}
