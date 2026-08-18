/**
 * TokenWatch AI Advisor Floating Widget
 * Clean plain-text rendering and quota tracking.
 */
(() => {
  const STORAGE_KEY = 'tw_advisor_quota';
  const MAX_QUERIES = 4;
  const WINDOW_MS = 24 * 60 * 60 * 1000;

  function getQuota() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      const now = Date.now();
      if (!stored.firstSeen || now - stored.firstSeen > WINDOW_MS) {
        return { count: 0, firstSeen: now };
      }
      return stored;
    } catch {
      return { count: 0, firstSeen: Date.now() };
    }
  }

  function incrementQuota() {
    const quota = getQuota();
    quota.count += 1;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(quota));
    return quota;
  }

  function initWidget() {
    if (document.getElementById('tw-advisor-container')) return;
    if (!document.body) {
      setTimeout(initWidget, 50);
      return;
    }

    const container = document.createElement('div');
    container.id = 'tw-advisor-container';
    container.className = 'tw-advisor-container';
    container.innerHTML = `
      <div id="tw-advisor-bubble" class="tw-advisor-bubble" title="Ask TokenWatch Advisor" aria-label="Open AI Advisor" role="button" tabindex="0">
        <span class="tw-advisor-icon">💬</span>
        <span class="tw-advisor-label">Ask Advisor</span>
      </div>
      <div id="tw-advisor-panel" class="tw-advisor-panel hidden" aria-hidden="true">
        <div class="tw-advisor-header">
          <div class="tw-advisor-title">
            <span>💰 TokenWatch AI Advisor</span>
            <span class="tw-advisor-badge">Beta</span>
          </div>
          <button id="tw-advisor-close" class="tw-advisor-close" aria-label="Close advisor" type="button">&times;</button>
        </div>
        <div class="tw-advisor-meta">
          <span id="tw-advisor-quota-text">4/4 queries remaining today</span>
        </div>
        <div id="tw-advisor-messages" class="tw-advisor-messages">
          <div class="tw-msg tw-msg-system">
            👋 Hi! I can help you compare model prices, find Zero Data Retention (ZDR) options, or check benchmark scores. Ask me anything!
          </div>
        </div>
        <div class="tw-advisor-input-row">
          <input type="text" id="tw-advisor-input" placeholder="e.g. Cheapest coding model with ZDR?" maxlength="250" autocomplete="off" />
          <button id="tw-advisor-send" aria-label="Send query" type="button">Send</button>
        </div>
      </div>
    `;

    document.body.appendChild(container);

    const bubble = container.querySelector('#tw-advisor-bubble');
    const panel = container.querySelector('#tw-advisor-panel');
    const closeBtn = container.querySelector('#tw-advisor-close');
    const messagesBox = container.querySelector('#tw-advisor-messages');
    const input = container.querySelector('#tw-advisor-input');
    const sendBtn = container.querySelector('#tw-advisor-send');
    const quotaText = container.querySelector('#tw-advisor-quota-text');

    if (!bubble || !panel || !closeBtn || !messagesBox || !input || !sendBtn || !quotaText) {
      return;
    }

    let conversationHistory = [];

    function updateQuotaDisplay() {
      const q = getQuota();
      const remaining = Math.max(0, MAX_QUERIES - q.count);
      quotaText.textContent = `${remaining}/${MAX_QUERIES} queries remaining today`;
      if (remaining === 0) {
        input.disabled = true;
        sendBtn.disabled = true;
        input.placeholder = "Daily limit reached (4/4). Check back tomorrow!";
      } else {
        input.disabled = false;
        sendBtn.disabled = false;
      }
    }

    function appendMessage(role, text) {
      const msg = document.createElement('div');
      msg.className = `tw-msg tw-msg-${role}`;
      // Clean plain text without raw markdown tags
      msg.textContent = text;
      messagesBox.appendChild(msg);
      messagesBox.scrollTop = messagesBox.scrollHeight;
    }

    function togglePanel() {
      const isHidden = panel.classList.toggle('hidden');
      panel.setAttribute('aria-hidden', isHidden ? 'true' : 'false');
      if (!isHidden) {
        updateQuotaDisplay();
        setTimeout(() => input.focus(), 50);
      }
    }

    bubble.addEventListener('click', togglePanel);
    bubble.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        togglePanel();
      }
    });

    closeBtn.addEventListener('click', () => {
      panel.classList.add('hidden');
      panel.setAttribute('aria-hidden', 'true');
    });

    async function handleSend() {
      const prompt = input.value.trim();
      if (!prompt) return;

      const quota = getQuota();
      if (quota.count >= MAX_QUERIES) {
        updateQuotaDisplay();
        return;
      }

      appendMessage('user', prompt);
      conversationHistory.push({ role: 'user', content: prompt });
      input.value = '';
      input.disabled = true;
      sendBtn.disabled = true;

      const loadingMsg = document.createElement('div');
      loadingMsg.className = 'tw-msg tw-msg-assistant tw-msg-loading';
      loadingMsg.textContent = 'Thinking...';
      messagesBox.appendChild(loadingMsg);
      messagesBox.scrollTop = messagesBox.scrollHeight;

      try {
        const res = await fetch('/api/advisor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: conversationHistory }),
        });

        loadingMsg.remove();

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          appendMessage('system', errData.error || 'Unable to connect to the advisor right now.');
        } else {
          const data = await res.json();
          appendMessage('assistant', data.reply);
          conversationHistory.push({ role: 'assistant', content: data.reply });
          incrementQuota();
        }
      } catch (e) {
        loadingMsg.remove();
        appendMessage('system', 'Network error reaching the advisor.');
      } finally {
        updateQuotaDisplay();
      }
    }

    sendBtn.addEventListener('click', handleSend);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSend();
    });

    updateQuotaDisplay();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initWidget);
  } else {
    initWidget();
  }
})();
