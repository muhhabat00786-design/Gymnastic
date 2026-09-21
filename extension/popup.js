document.addEventListener('DOMContentLoaded', () => {
  const wsStatus = document.getElementById('ws-status');
  const latencyMs = document.getElementById('latency-ms');
  const activeTabEl = document.getElementById('active-tab');
  const btnCopyConfig = document.getElementById('btn-copy-config');
  const mcpConfig = document.getElementById('mcp-config');

  let annotationsVisible = false;

  function updateStatus() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        activeTabEl.textContent = tabs[0].title || tabs[0].url;
      }
    });

    // Check WS status by sending a ping to the background script?
    // Since background script doesn't easily expose WS state to popup without messaging,
    // we can do a quick check via chrome.runtime.getBackgroundPage or messaging.

    // Instead of complex messaging for this simple UI, we ping the background script.
    // However, MV3 doesn't have getBackgroundPage. We'll use chrome.runtime.sendMessage if we set it up,
    // or just assume if background is running, it tries to connect.

    // For now, let's just show standard connection status via fetch to local server
    const start = performance.now();
    fetch('http://127.0.0.1:18823/status')
      .then(res => res.json())
      .then(data => {
        const end = performance.now();
        wsStatus.textContent = data.extension_connected ? 'Connected' : 'Waiting';
        wsStatus.className = data.extension_connected ? 'pill connected' : 'pill disconnected';
        latencyMs.textContent = Math.round(end - start) + ' ms';
      })
      .catch(() => {
        wsStatus.textContent = 'Server Offline';
        wsStatus.className = 'pill disconnected';
        latencyMs.textContent = '-- ms';
      });
  }

  setInterval(updateStatus, 1000);
  updateStatus();

  // Button actions (delegating to server via HTTP bridge for simplicity,
  // or sending message to background script. Let's send message to background script if possible,
  // but since we didn't add chrome.runtime.onMessage in background.js, we can trigger via HTTP Bridge!)

  document.getElementById('btn-annotate').addEventListener('click', () => {
    annotationsVisible = !annotationsVisible;
    fetch('http://127.0.0.1:18823/api', {
      method: 'POST',
      body: JSON.stringify({
        method: annotationsVisible ? 'browser_annotate_elements' : 'browser_clear_annotations'
      })
    });
  });

  document.getElementById('btn-snap').addEventListener('click', () => {
    fetch('http://127.0.0.1:18823/api', {
      method: 'POST',
      body: JSON.stringify({ method: 'browser_screenshot' })
    }).then(res => res.json()).then(data => {
       if (data.status === 'captured') {
         // Create a temporary link to download the image
         const a = document.createElement('a');
         a.href = 'data:image/png;base64,' + data.data;
         a.download = 'screenshot.png';
         a.click();
       }
    });
  });

  document.getElementById('btn-scroll').addEventListener('click', () => {
    fetch('http://127.0.0.1:18823/api', {
      method: 'POST',
      body: JSON.stringify({ method: 'browser_scroll', params: { direction: 'down', amount: 500 } })
    });
  });

  document.getElementById('btn-reconnect').addEventListener('click', () => {
    chrome.runtime.reload(); // Reloads the extension
  });

  btnCopyConfig.addEventListener('click', () => {
    navigator.clipboard.writeText(mcpConfig.textContent.trim()).then(() => {
      const originalText = btnCopyConfig.textContent;
      btnCopyConfig.textContent = '✅ Copied!';
      setTimeout(() => btnCopyConfig.textContent = originalText, 2000);
    });
  });
});
