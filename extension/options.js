document.addEventListener('DOMContentLoaded', () => {
  const providerInput = document.getElementById('provider');
  const apiKeyInput = document.getElementById('apiKey');
  const modelInput = document.getElementById('model');
  const baseUrlInput = document.getElementById('baseUrl');
  const saveBtn = document.getElementById('saveBtn');
  const statusDiv = document.getElementById('status');

  // Load existing configuration
  chrome.storage.local.get(['aiConfig'], (result) => {
    if (result.aiConfig) {
      providerInput.value = result.aiConfig.provider || 'openai';
      apiKeyInput.value = result.aiConfig.apiKey || '';
      modelInput.value = result.aiConfig.model || 'gpt-4o';
      baseUrlInput.value = result.aiConfig.baseUrl || '';
    }
  });

  saveBtn.addEventListener('click', () => {
    const aiConfig = {
      provider: providerInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim(),
      baseUrl: baseUrlInput.value.trim()
    };

    chrome.storage.local.set({ aiConfig }, () => {
      statusDiv.textContent = '✅ Configuration saved successfully!';
      setTimeout(() => {
        statusDiv.textContent = '';
      }, 3000);
    });
  });
});
