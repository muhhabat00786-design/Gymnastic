document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const tabs = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  const providerSelect = document.getElementById('providerSelect');
  const modelSelect = document.getElementById('modelSelect');
  const customModelName = document.getElementById('customModelName');
  const presetApiKey = document.getElementById('presetApiKey');

  const customBaseUrl = document.getElementById('customBaseUrl');
  const customApiKey = document.getElementById('customApiKey');
  const customModel = document.getElementById('customModel');

  const saveBtn = document.getElementById('saveBtn');
  const testBtn = document.getElementById('testBtn');
  const statusArea = document.getElementById('statusArea');

  // Provider config defaults
  const providers = {
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo']
    },
    gemini: {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      models: ['gemini-1.5-pro-latest', 'gemini-1.5-flash-latest', 'custom...']
    },
    groq: {
      baseUrl: 'https://api.groq.com/openai/v1',
      models: ['llama3-70b-8192', 'llama3-8b-8192', 'mixtral-8x7b-32768']
    },
    openrouter: {
      baseUrl: 'https://openrouter.ai/api/v1',
      models: ['anthropic/claude-3.5-sonnet', 'meta-llama/llama-3-70b-instruct', 'custom...']
    }
  };

  let currentTab = 'preset';

  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      currentTab = tab.dataset.tab;
      document.getElementById(`${currentTab}-tab`).classList.add('active');
    });
  });

  // Populate models when provider changes
  function updateModelSelect() {
    const p = providerSelect.value;
    modelSelect.innerHTML = '';

    if (providers[p]) {
      providers[p].models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modelSelect.appendChild(opt);
      });
    }
    checkCustomModel();
  }

  function checkCustomModel() {
    if (modelSelect.value === 'custom...') {
      customModelName.style.display = 'block';
    } else {
      customModelName.style.display = 'none';
    }
  }

  providerSelect.addEventListener('change', updateModelSelect);
  modelSelect.addEventListener('change', checkCustomModel);

  // Load saved config
  chrome.storage.local.get(['aiConfig'], (result) => {
    const conf = result.aiConfig || {};

    if (conf.isCustom) {
      document.querySelector('[data-tab="custom"]').click();
      customBaseUrl.value = conf.baseUrl || '';
      customApiKey.value = conf.apiKey || '';
      customModel.value = conf.model || '';
    } else {
      providerSelect.value = conf.provider || 'openai';
      updateModelSelect();

      presetApiKey.value = conf.apiKey || '';

      if (providers[conf.provider] && providers[conf.provider].models.includes(conf.model)) {
        modelSelect.value = conf.model;
      } else if (conf.model) {
        modelSelect.value = 'custom...';
        customModelName.style.display = 'block';
        customModelName.value = conf.model;
      }
    }
  });

  // Init models for default
  if(!modelSelect.options.length) updateModelSelect();

  function showStatus(msg, isError = false) {
    statusArea.textContent = msg;
    statusArea.className = 'status-area ' + (isError ? 'error' : 'success');
  }

  function getFormConfig() {
    if (currentTab === 'custom') {
      return {
        isCustom: true,
        provider: 'custom',
        baseUrl: customBaseUrl.value.trim().replace(/\/$/, ''),
        apiKey: customApiKey.value.trim(),
        model: customModel.value.trim()
      };
    } else {
      const p = providerSelect.value;
      let m = modelSelect.value;
      if (m === 'custom...') m = customModelName.value.trim();

      return {
        isCustom: false,
        provider: p,
        baseUrl: providers[p].baseUrl.replace(/\/$/, ''),
        apiKey: presetApiKey.value.trim(),
        model: m
      };
    }
  }

  saveBtn.addEventListener('click', () => {
    const config = getFormConfig();
    if (!config.apiKey) {
      showStatus("Please enter an API Key", true);
      return;
    }

    chrome.storage.local.set({ aiConfig: config }, () => {
      showStatus("Configuration saved successfully!");
      setTimeout(() => statusArea.style.display = 'none', 3000);
    });
  });

  testBtn.addEventListener('click', async () => {
    const config = getFormConfig();
    if (!config.apiKey || !config.baseUrl || !config.model) {
      showStatus("Please fill in all fields before testing.", true);
      return;
    }

    testBtn.classList.add('testing');
    testBtn.disabled = true;
    showStatus("Testing connection...", false);
    statusArea.className = 'status-area'; // reset color
    statusArea.style.display = 'block';

    try {
      const endpoint = `${config.baseUrl}/chat/completions`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: 'Hi, reply with "OK"' }],
          max_tokens: 5
        })
      });

      if (res.ok) {
        showStatus("Connection successful! API is working.", false);
      } else {
        const txt = await res.text();
        showStatus(`Error ${res.status}: ${txt}`, true);
      }
    } catch (err) {
      showStatus(`Network Error: ${err.message}`, true);
    } finally {
      testBtn.classList.remove('testing');
      testBtn.disabled = false;
    }
  });

});
