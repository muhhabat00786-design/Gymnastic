document.addEventListener('DOMContentLoaded', () => {
  const chatContainer = document.getElementById('chatContainer');
  const userInput = document.getElementById('userInput');
  const actionBtn = document.getElementById('actionBtn');
  const openSettings = document.getElementById('openSettings');

  const menuBtn = document.getElementById('menuBtn');
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('overlay');
  const newChatBtn = document.getElementById('newChatBtn');
  const historyList = document.getElementById('historyList');

  let isProcessing = false;
  let currentSessionId = Date.now().toString();
  let chatHistory = [];
  let sessions = {};

  // Load History
  chrome.storage.local.get(['aiSessions', 'currentSessionId'], (res) => {
    sessions = res.aiSessions || {};
    if (res.currentSessionId && sessions[res.currentSessionId]) {
      currentSessionId = res.currentSessionId;
      chatHistory = sessions[currentSessionId].history || [];
      renderChat();
    } else {
      startNewChat();
    }
    renderSidebar();
  });

  function startNewChat() {
    currentSessionId = Date.now().toString();
    chatHistory = [{ role: 'system', content: 'Hello! I\'m your autonomous navigator. What can I do for you today?' }];
    saveSession();
    renderChat();
    renderSidebar();
    closeSidebar();
  }

  function saveSession() {
    if (!sessions[currentSessionId]) {
      sessions[currentSessionId] = { id: currentSessionId, title: 'New Chat', history: [] };
    }

    // Auto-title
    if (chatHistory.length > 1 && sessions[currentSessionId].title === 'New Chat') {
       const firstUserMsg = chatHistory.find(m => m.role === 'user');
       if (firstUserMsg) {
         sessions[currentSessionId].title = firstUserMsg.content.substring(0, 30) + '...';
       }
    }

    sessions[currentSessionId].history = chatHistory;
    chrome.storage.local.set({ aiSessions: sessions, currentSessionId });
    renderSidebar();
  }

  function renderSidebar() {
    historyList.innerHTML = '';
    const sortedKeys = Object.keys(sessions).sort((a,b) => b - a);
    sortedKeys.forEach(id => {
      const item = document.createElement('div');
      item.className = `history-item ${id === currentSessionId ? 'active' : ''}`;
      item.textContent = sessions[id].title;
      item.onclick = () => {
        currentSessionId = id;
        chatHistory = sessions[id].history;
        saveSession();
        renderChat();
        closeSidebar();
      };
      historyList.appendChild(item);
    });
  }

  const typingIndicatorHTML = `
    <div class="typing-indicator active" id="typingIndicator">
      <div class="bar"></div>
      <div class="bar"></div>
      <div class="bar"></div>
    </div>
  `;

  function renderChat() {
    chatContainer.innerHTML = '';
    chatHistory.forEach(msg => {
      if (msg.role !== 'developer' && msg.role !== 'tool' && !msg.hidden) {
        addMessageUI(msg.content, msg.role === 'user' ? 'user' : (msg.isSystemInfo ? 'system' : 'bot'));
      }
    });
    if (isProcessing) {
       chatContainer.insertAdjacentHTML('beforeend', typingIndicatorHTML);
    }
    scrollToBottom();
  }

  function addMessageUI(text, sender) {
    // Remove typing indicator if it exists
    const existingIndicator = document.getElementById('typingIndicator');
    if (existingIndicator) existingIndicator.remove();

    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}`;
    msgDiv.textContent = text;
    chatContainer.appendChild(msgDiv);

    // Re-add typing indicator if still processing
    if (isProcessing) {
       chatContainer.insertAdjacentHTML('beforeend', typingIndicatorHTML);
    }

    scrollToBottom();
  }

  function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  // Sidebar controls
  function openSidebar() {
    sidebar.classList.add('open');
    overlay.classList.add('active');
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('active');
  }

  menuBtn.addEventListener('click', openSidebar);
  overlay.addEventListener('click', closeSidebar);
  newChatBtn.addEventListener('click', startNewChat);

  openSettings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  function setProcessing(processing) {
    isProcessing = processing;
    if (processing) {
      actionBtn.classList.remove('send');
      actionBtn.classList.add('stop');
    } else {
      actionBtn.classList.remove('stop');
      actionBtn.classList.add('send');
    }
  }

  async function handleAction() {
    if (isProcessing) {
      // STOP Action
      chrome.runtime.sendMessage({ type: 'STOP_REQUEST' });
      setProcessing(false);
      chatHistory.push({ role: 'assistant', content: 'Stopped by user.', isSystemInfo: true });
      saveSession();
      renderChat();
      return;
    }

    // SEND Action
    const text = userInput.value.trim();
    if (!text) return;

    chatHistory.push({ role: 'user', content: text });
    saveSession();
    renderChat();

    userInput.value = '';
    userInput.style.height = 'auto'; // Reset textarea height
    setProcessing(true);

    try {
      // We pass the full history to the agent (filtering out internal UI flags if needed)
      const agentHistory = chatHistory.filter(m => !m.isSystemInfo).map(m => ({role: m.role, content: m.content}));

      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CHAT_REQUEST', history: agentHistory }, (resp) => {
          resolve(resp);
        });
      });

      setProcessing(false);

      if (response && response.error) {
        chatHistory.push({ role: 'assistant', content: `Error: ${response.error}`, isSystemInfo: true });
      } else if (response && response.text) {
        chatHistory.push({ role: 'assistant', content: response.text });
      }
      saveSession();
      renderChat();

    } catch (err) {
      setProcessing(false);
      chatHistory.push({ role: 'assistant', content: `Error: ${err.message}`, isSystemInfo: true });
      saveSession();
      renderChat();
    }
  }

  actionBtn.addEventListener('click', handleAction);

  userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAction();
    }
  });

  // Auto-resize textarea
  userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
  });

  // Listen for live agent progress updates
  chrome.runtime.onMessage.addListener((message) => {
     if (message.type === 'AGENT_UPDATE') {
        chatHistory.push({ role: 'assistant', content: message.text, isSystemInfo: true });
        saveSession();
        addMessageUI(message.text, 'system');
     }
  });
});
