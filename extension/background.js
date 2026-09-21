// Self-contained Autonomous Browser Agent Background Script
const SYSTEM_PROMPT = `You are a world-class browser automation AI. Your job is to fulfill the user's request by calling available tools.
You have access to a real Chrome browser. Act quickly. If asked to go to a site, use browser_navigate. If asked to play a song or search, use a combination of navigating, typing, and clicking.
To find things to click, you can use browser_get_elements to see what's on the page.

IMPORTANT: When typing into search boxes, it's often best to press 'Enter' afterwards using browser_trusted_press_key('Enter').
`;

let activeConfig = null;
let currentAbortController = null;
let stopRequested = false;

chrome.storage.local.get(['aiConfig'], (result) => {
  if (result.aiConfig) {
    activeConfig = result.aiConfig;
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.aiConfig) {
    activeConfig = changes.aiConfig.newValue;
  }
});

// Allow users to open side panel by clicking the extension action
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);


function updateChat(text) {
  chrome.runtime.sendMessage({ type: 'AGENT_UPDATE', text }).catch(() => {}); // Ignore error if sidepanel is closed
}

// -----------------------------------------------------------------------------
// CDP & Browser Control Functions
// -----------------------------------------------------------------------------
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
  }
}

// Helper to evaluate scripts via Chrome DevTools Protocol to bypass CSP
async function runScriptCDP(tabId, scriptStr) {
  await ensureDebuggerAttached(tabId);
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression: scriptStr,
    returnByValue: true,
    awaitPromise: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception.description || 'Script execution failed');
  }
  return result.result.value;
}

const keyMap = {
  'Enter': { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  'Escape': { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  'Tab': { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }
};

const browserTools = {
  browser_navigate: async ({ url }) => {
    if (stopRequested) throw new Error("Stopped");
    let tab = await getActiveTab();
    if (!url.startsWith('http')) url = 'https://' + url;
    await chrome.tabs.update(tab.id, { url });
    await ensureDebuggerAttached(tab.id);

    // Fast resolve on DOMContentLoaded
    return new Promise((resolve, reject) => {
      let isResolved = false;
      let timeoutId;
      let intervalId;

      const cleanup = () => {
        if (isResolved) return;
        isResolved = true;
        chrome.tabs.onUpdated.removeListener(listener);
        if (chrome.webNavigation) chrome.webNavigation.onDOMContentLoaded.removeListener(webNavListener);
        clearTimeout(timeoutId);
        clearInterval(intervalId);
      };

      const listener = (navTabId, changeInfo) => {
        if (navTabId === tab.id && changeInfo.status === 'complete') {
          cleanup(); resolve("Navigated to " + url);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);

      const webNavListener = (details) => {
        if (details.tabId === tab.id && details.frameId === 0) {
          cleanup(); resolve("Navigated to " + url);
        }
      };
      if (chrome.webNavigation) chrome.webNavigation.onDOMContentLoaded.addListener(webNavListener);

      // Stop checker
      intervalId = setInterval(() => {
        if (stopRequested) {
          cleanup();
          reject(new Error("Stopped"));
        }
      }, 100);

      timeoutId = setTimeout(() => { cleanup(); resolve("Navigation timeout (but likely loaded)"); }, 8000);
    });
  },

  browser_get_elements: async () => {
    if (stopRequested) throw new Error("Stopped");
    let tab = await getActiveTab();
    const script = `(() => {
      const items = [];
      const selectors = 'button, a, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
      const els = document.querySelectorAll(selectors);
      els.forEach(el => {
         const rect = el.getBoundingClientRect();
         if (rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== 'hidden') {
           items.push({
             tag: el.tagName.toLowerCase(),
             text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().substring(0, 50),
             selector: \`\${el.tagName.toLowerCase()}\${el.id ? '#'+el.id : ''}\${el.getAttribute('class') ? '.'+el.getAttribute('class').split(' ').join('.') : ''}\`,
             x: rect.left + rect.width / 2,
             y: rect.top + rect.height / 2,
           });
         }
      });
      return items;
    })()`;
    const elements = await runScriptCDP(tab.id, script);
    // Truncate to avoid massive context
    return JSON.stringify((elements || []).slice(0, 40));
  },

  browser_trusted_click: async ({ x, y }) => {
    if (stopRequested) throw new Error("Stopped");
    let tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return `Clicked at ${x}, ${y}`;
  },

  browser_trusted_type: async ({ text }) => {
    if (stopRequested) throw new Error("Stopped");
    let tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    for (const char of text) {
      if (stopRequested) throw new Error("Stopped");
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', { type: 'keyDown', text: char, unmodifiedText: char });
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', { type: 'keyUp' });
    }
    return `Typed: ${text}`;
  },

  browser_trusted_press_key: async ({ key }) => {
    if (stopRequested) throw new Error("Stopped");
    let tab = await getActiveTab();
    await ensureDebuggerAttached(tab.id);
    const keyInfo = keyMap[key] || { key: key, code: key };
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: keyInfo.windowsVirtualKeyCode, nativeVirtualKeyCode: keyInfo.nativeVirtualKeyCode, key: keyInfo.key, code: keyInfo.code });
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: keyInfo.key, code: keyInfo.code });
    return `Pressed ${key}`;
  },

  browser_get_page_content: async () => {
    if (stopRequested) throw new Error("Stopped");
    let tab = await getActiveTab();
    const content = await runScriptCDP(tab.id, "document.body.innerText");
    // Truncate to a reasonable amount to avoid massive token usage
    return (content || "").substring(0, 10000);
  },

  browser_execute_script: async ({ script }) => {
    if (stopRequested) throw new Error("Stopped");
    let tab = await getActiveTab();
    try {
       const result = await runScriptCDP(tab.id, script);
       return `Script executed. Result: ${result}`;
    } catch (e) {
       return `Script executed with error. Result: ${e.message}`;
    }
  }
};

const openAiTools = [
  { type: "function", function: { name: "browser_navigate", description: "Navigate to a URL", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } } },
  { type: "function", function: { name: "browser_get_elements", description: "Get interactive elements on screen (returns JSON with x/y coords)", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "browser_trusted_click", description: "Click at x/y coordinates", parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } } },
  { type: "function", function: { name: "browser_trusted_type", description: "Type text (make sure you clicked an input first)", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
  { type: "function", function: { name: "browser_trusted_press_key", description: "Press a key like 'Enter'", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } } },
  { type: "function", function: { name: "browser_get_page_content", description: "Get all readable text content from the current page", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "browser_execute_script", description: "Execute custom Javascript on the page (e.g., to inject dark mode or scroll)", parameters: { type: "object", properties: { script: { type: "string" } }, required: ["script"] } } }
];

// -----------------------------------------------------------------------------
// OpenAI API Client
// -----------------------------------------------------------------------------
async function callLLM(messages, signal) {
  if (!activeConfig || !activeConfig.apiKey) {
    throw new Error("No API key configured. Please click settings (⚙️).");
  }

  // Ensure baseUrl doesn't have a trailing slash before appending
  let baseUrl = activeConfig.baseUrl || 'https://api.openai.com/v1';
  baseUrl = baseUrl.replace(/\/$/, '');

  const endpoint = `${baseUrl}/chat/completions`;

  const res = await fetch(endpoint, {
    method: 'POST',
    signal: signal,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${activeConfig.apiKey}`
    },
    body: JSON.stringify({
      model: activeConfig.model || 'gpt-4o',
      messages: messages,
      tools: openAiTools,
      tool_choice: "auto"
    })
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`API Error: ${res.status} - ${errorText}`);
  }

  return await res.json();
}

// -----------------------------------------------------------------------------
// Autonomous Loop
// -----------------------------------------------------------------------------
async function runAgentLoop(history) {
  stopRequested = false;
  currentAbortController = new AbortController();

  // Prepare messages array by prepending the system prompt to the user history
  let messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history
  ];

  let stepCount = 0;

  while (!stopRequested && stepCount < 100) { // Safety bound 100
    stepCount++;
    updateChat(`Agent thinking... (Step ${stepCount})`);

    let response;
    try {
      response = await callLLM(messages, currentAbortController.signal);
    } catch (e) {
      if (e.name === 'AbortError') return { error: 'Stopped' };
      return { error: e.message };
    }

    if (stopRequested) return { error: 'Stopped' };

    const responseMessage = response.choices[0].message;
    messages.push(responseMessage);

    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      for (const toolCall of responseMessage.tool_calls) {
        if (stopRequested) break;

        const functionName = toolCall.function.name;
        const functionArgs = JSON.parse(toolCall.function.arguments);

        updateChat(`Action: ${functionName}(${JSON.stringify(functionArgs)})`);
        console.log(`Calling ${functionName}`, functionArgs);

        let functionResponse = "";
        try {
          if (browserTools[functionName]) {
            functionResponse = await browserTools[functionName](functionArgs);
          } else {
            functionResponse = "Tool not found.";
          }
        } catch (err) {
          if (err.message === "Stopped") {
             functionResponse = "Stopped by user.";
          } else {
             functionResponse = `Error executing tool: ${err.message}`;
          }
          console.error(err);
        }

        messages.push({
          tool_call_id: toolCall.id,
          role: "tool",
          name: functionName,
          content: String(functionResponse),
        });
      }
    } else {
      // Done - No more tool calls
      return { text: responseMessage.content };
    }
  }

  if (stopRequested) return { error: 'Stopped' };
  return { text: "Safety limit of 100 steps reached. I've stopped to prevent looping." };
}

// -----------------------------------------------------------------------------
// Message Listener
// -----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'CHAT_REQUEST') {
    runAgentLoop(request.history).then((res) => {
      sendResponse(res);
    });
    return true; // Keep channel open for async response
  } else if (request.type === 'STOP_REQUEST') {
    stopRequested = true;
    if (currentAbortController) {
      currentAbortController.abort();
    }
    sendResponse({status: 'stopped'});
  }
});
