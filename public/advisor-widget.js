/**
 * TokenWatch AI Advisor
 * Closed launcher mounts into the existing header actions so it never floats
 * over calculator controls or results. The panel opens only on a deliberate
 * click/keypress, is bounded to the viewport, and closes with Escape or the
 * Close button (focus returns to the launcher).
 * Clean plain-text rendering and quota tracking are unchanged.
 */
(() => {
  const STORAGE_KEY = 'tw_advisor_quota';
  const MAX_QUERIES = 4;
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const PANEL_MAX_WIDTH = 360;
  const PANEL_MAX_HEIGHT = 480;
  const VIEWPORT_MARGIN = 12;

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

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildLauncher() {
    const launcher = el('button', 'tw-advisor-bubble');
    launcher.id = 'tw-advisor-bubble';
    launcher.type = 'button';
    launcher.title = 'Ask TokenWatch Advisor';
    launcher.setAttribute('aria-label', 'Ask Advisor — TokenWatch');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.setAttribute('aria-controls', 'tw-advisor-panel');
    launcher.appendChild(el('span', 'tw-advisor-icon', '💬'));
    launcher.appendChild(el('span', 'tw-advisor-label', 'Ask Advisor'));
    return launcher;
  }

  function buildPanel() {
    const panel = el('div', 'tw-advisor-panel hidden');
    panel.id = 'tw-advisor-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', 'TokenWatch AI Advisor');
    panel.setAttribute('aria-hidden', 'true');

    const header = el('div', 'tw-advisor-header');
    const title = el('div', 'tw-advisor-title');
    title.appendChild(el('span', null, '💰 TokenWatch AI Advisor'));
    title.appendChild(el('span', 'tw-advisor-badge', 'Beta'));
    const closeBtn = el('button', 'tw-advisor-close', '×');
    closeBtn.id = 'tw-advisor-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close advisor');
    header.appendChild(title);
    header.appendChild(closeBtn);

    const meta = el('div', 'tw-advisor-meta');
    const quotaText = el('span', null, `${MAX_QUERIES}/${MAX_QUERIES} queries remaining today`);
    quotaText.id = 'tw-advisor-quota-text';
    meta.appendChild(quotaText);

    const messagesBox = el('div', 'tw-advisor-messages');
    messagesBox.id = 'tw-advisor-messages';
    const greeting = el('div', 'tw-msg tw-msg-system',
      '👋 Hi! I can help you compare model prices, find Zero Data Retention (ZDR) options, or check benchmark scores. Ask me anything!');
    messagesBox.appendChild(greeting);

    const inputRow = el('div', 'tw-advisor-input-row');
    const input = el('input');
    input.id = 'tw-advisor-input';
    input.type = 'text';
    input.placeholder = 'e.g. Cheapest coding model with ZDR?';
    input.maxLength = 250;
    input.autocomplete = 'off';
    const sendBtn = el('button', null, 'Send');
    sendBtn.id = 'tw-advisor-send';
    sendBtn.type = 'button';
    sendBtn.setAttribute('aria-label', 'Send query');
    inputRow.appendChild(input);
    inputRow.appendChild(sendBtn);

    panel.appendChild(header);
    panel.appendChild(meta);
    panel.appendChild(messagesBox);
    panel.appendChild(inputRow);
    return { panel, closeBtn, messagesBox, input, sendBtn, quotaText };
  }

  /**
   * Prefer the shared header actions container; fall back to the header row
   * itself, then to a body-flow block so a headerless page never gets a
   * floating closed button over its content.
   */
  function mountLauncher(container) {
    const headerLinks = document.querySelector('.header-links');
    const headerRow = document.querySelector('.header-row');
    const host = headerLinks || headerRow;
    if (host) {
      container.classList.add('tw-advisor-container--header');
      host.appendChild(container);
      return 'header';
    }
    container.classList.add('tw-advisor-container--flow');
    const main = document.querySelector('main');
    if (main && main.parentNode) {
      main.parentNode.insertBefore(container, main);
    } else {
      document.body.insertBefore(container, document.body.firstChild);
    }
    return 'flow';
  }

  function initWidget() {
    if (document.getElementById('tw-advisor-container')) return;
    if (!document.body) {
      setTimeout(initWidget, 50);
      return;
    }

    const container = el('div', 'tw-advisor-container');
    container.id = 'tw-advisor-container';
    const launcher = buildLauncher();
    container.appendChild(launcher);
    mountLauncher(container);

    const { panel, closeBtn, messagesBox, input, sendBtn, quotaText } = buildPanel();
    // The panel is a top-level overlay so no ancestor can clip it.
    document.body.appendChild(panel);

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

    function isOpen() {
      return !panel.classList.contains('hidden');
    }

    /** Keep the open panel inside the viewport, anchored under the launcher. */
    function positionPanel() {
      if (!isOpen()) return;
      const rect = launcher.getBoundingClientRect();
      const vw = window.innerWidth || document.documentElement.clientWidth || 0;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const width = Math.min(PANEL_MAX_WIDTH, Math.max(0, vw - VIEWPORT_MARGIN * 2));
      const maxRight = Math.max(VIEWPORT_MARGIN, vw - VIEWPORT_MARGIN - width);
      const right = Math.min(Math.max(vw - rect.right, VIEWPORT_MARGIN), maxRight);
      let top = Math.round(rect.bottom + 8);
      const maxTop = Math.max(VIEWPORT_MARGIN, vh - 220);
      if (top > maxTop) top = maxTop;
      const maxHeight = Math.max(160, vh - top - VIEWPORT_MARGIN);
      panel.style.width = width + 'px';
      panel.style.right = right + 'px';
      panel.style.left = 'auto';
      panel.style.top = top + 'px';
      panel.style.bottom = 'auto';
      panel.style.maxHeight = Math.min(PANEL_MAX_HEIGHT, maxHeight) + 'px';
    }

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePanel();
      }
    }

    function openPanel() {
      if (isOpen()) return;
      panel.classList.remove('hidden');
      panel.setAttribute('aria-hidden', 'false');
      launcher.setAttribute('aria-expanded', 'true');
      updateQuotaDisplay();
      positionPanel();
      document.addEventListener('keydown', onKeydown);
      window.addEventListener('resize', positionPanel);
      input.focus();
    }

    function closePanel() {
      if (!isOpen()) return;
      panel.classList.add('hidden');
      panel.setAttribute('aria-hidden', 'true');
      launcher.setAttribute('aria-expanded', 'false');
      document.removeEventListener('keydown', onKeydown);
      window.removeEventListener('resize', positionPanel);
      launcher.focus();
    }

    function togglePanel() {
      if (isOpen()) closePanel();
      else openPanel();
    }

    launcher.addEventListener('click', togglePanel);
    launcher.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        togglePanel();
      }
    });

    closeBtn.addEventListener('click', closePanel);

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
