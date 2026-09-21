document.addEventListener('DOMContentLoaded', () => {
  const chatContainer = document.getElementById('chatContainer');
  const userInput = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const typingIndicator = document.getElementById('typingIndicator');
  const openSettings = document.getElementById('openSettings');

  openSettings.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  function addMessage(text, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}`;
    msgDiv.textContent = text;
    chatContainer.insertBefore(msgDiv, typingIndicator);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function setTyping(isTyping) {
    typingIndicator.style.display = isTyping ? 'flex' : 'none';
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  async function handleSend() {
    const text = userInput.value.trim();
    if (!text) return;

    addMessage(text, 'user');
    userInput.value = '';
    setTyping(true);

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'CHAT_REQUEST', text }, (resp) => {
          resolve(resp);
        });
      });

      setTyping(false);

      if (response && response.error) {
        addMessage(`Error: ${response.error}. Make sure your API key is set in Settings.`, 'system');
      } else if (response && response.text) {
        addMessage(response.text, 'bot');
      } else {
         addMessage('Done!', 'bot');
      }

    } catch (err) {
      setTyping(false);
      addMessage(`Error communicating with background agent: ${err.message}`, 'system');
    }
  }

  sendBtn.addEventListener('click', handleSend);
  userInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSend();
  });

  // Listen for agent progress updates (e.g. "Navigating to youtube...")
  chrome.runtime.onMessage.addListener((message) => {
     if (message.type === 'AGENT_UPDATE') {
        addMessage(message.text, 'system');
     }
  });
});
