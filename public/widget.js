/**
 * VAI IA — Embeddable Web Chat Widget
 *
 * Embed snippet:
 *   <script src="https://YOUR_VAI_DOMAIN/widget.js" data-tenant="your-tenant-slug"></script>
 *
 * Behavior:
 *   - Renders a floating chat bubble in the bottom-right corner
 *   - Click opens a chat panel
 *   - Creates a session via GET /api/session?slug=<tenant> on first use
 *   - Persists the sessionId in localStorage, scoped per tenant slug, so a
 *     returning visitor keeps their conversation across page reloads
 *   - Sends messages via POST /api/chat
 *   - Renders AI replies, shows a loading indicator while waiting
 *   - Shows a clear message on network error or HTTP 429 (rate limited)
 *
 * No build step. No external dependencies. No npm install required by the
 * customer. This file is loaded directly by <script src="...">.
 */
(function () {
  "use strict";

  // ── Locate this script's own tag to read data-tenant and infer the API origin ──
  var scriptEl = document.currentScript;
  if (!scriptEl) {
    // Fallback for older browsers without document.currentScript: find the
    // last <script> tag pointing at widget.js.
    var scripts = document.getElementsByTagName("script");
    for (var i = scripts.length - 1; i >= 0; i--) {
      if (scripts[i].src && scripts[i].src.indexOf("widget.js") !== -1) {
        scriptEl = scripts[i];
        break;
      }
    }
  }
  if (!scriptEl) {
    console.error("[VAI Widget] Could not locate its own <script> tag. Embed snippet must be a <script src> tag, not loaded another way.");
    return;
  }

  var TENANT = scriptEl.getAttribute("data-tenant");
  if (!TENANT) {
    console.error("[VAI Widget] Missing required data-tenant attribute on the <script> tag.");
    return;
  }

  // The API origin is wherever this script itself was loaded from — this
  // makes the widget work correctly whether VAI IA is on its production
  // domain, a staging domain, or a custom domain, with zero configuration.
  var API_ORIGIN = (function () {
    try {
      var u = new URL(scriptEl.src);
      return u.origin;
    } catch (e) {
      console.error("[VAI Widget] Could not determine API origin from script src.", e);
      return "";
    }
  })();

  if (!API_ORIGIN) return;

  var STORAGE_KEY = "vai_widget_session_" + TENANT;

  // ── State ────────────────────────────────────────────────────────────────────
  var sessionId = null;
  var isOpen = false;
  var isLoading = false;
  var sessionReady = false; // becomes true once /api/session has resolved

  // ── Styles (injected once, scoped under #vai-widget-root to avoid collisions) ──
  var STYLE = ""
    + "#vai-widget-root{position:fixed;bottom:20px;right:20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}"
    + "#vai-widget-bubble{width:60px;height:60px;border-radius:50%;background:#1a73e8;color:#fff;border:none;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;font-size:26px;transition:transform .15s ease;}"
    + "#vai-widget-bubble:hover{transform:scale(1.06);}"
    + "#vai-widget-panel{display:none;flex-direction:column;width:320px;height:440px;max-height:70vh;background:#fff;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.22);overflow:hidden;position:absolute;bottom:74px;right:0;}"
    + "#vai-widget-panel.vai-open{display:flex;}"
    + "#vai-widget-header{background:#1a73e8;color:#fff;padding:14px 16px;font-size:15px;font-weight:600;display:flex;justify-content:space-between;align-items:center;}"
    + "#vai-widget-close{cursor:pointer;background:none;border:none;color:#fff;font-size:20px;line-height:1;padding:0;}"
    + "#vai-widget-messages{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;background:#f7f8fa;}"
    + ".vai-msg{max-width:80%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.4;word-wrap:break-word;white-space:pre-wrap;}"
    + ".vai-msg-user{align-self:flex-end;background:#1a73e8;color:#fff;}"
    + ".vai-msg-bot{align-self:flex-start;background:#e9ebef;color:#1c1c1c;}"
    + ".vai-msg-error{align-self:flex-start;background:#fde7e7;color:#9b2c2c;}"
    + ".vai-msg-loading{align-self:flex-start;background:#e9ebef;color:#666;font-style:italic;}"
    + "#vai-widget-inputrow{display:flex;border-top:1px solid #e3e5e8;padding:8px;gap:6px;background:#fff;}"
    + "#vai-widget-input{flex:1;border:1px solid #d8dadf;border-radius:18px;padding:8px 14px;font-size:14px;outline:none;}"
    + "#vai-widget-input:focus{border-color:#1a73e8;}"
    + "#vai-widget-send{background:#1a73e8;color:#fff;border:none;border-radius:18px;padding:8px 16px;font-size:14px;cursor:pointer;}"
    + "#vai-widget-send:disabled{background:#a9c2ef;cursor:not-allowed;}";

  function injectStyles() {
    var tag = document.createElement("style");
    tag.textContent = STYLE;
    document.head.appendChild(tag);
  }

  // ── Build DOM ────────────────────────────────────────────────────────────────
  var root, panel, messagesEl, inputEl, sendBtn, bubble;

  function buildDom() {
    root = document.createElement("div");
    root.id = "vai-widget-root";

    bubble = document.createElement("button");
    bubble.id = "vai-widget-bubble";
    bubble.setAttribute("aria-label", "Open chat");
    bubble.textContent = "💬";

    panel = document.createElement("div");
    panel.id = "vai-widget-panel";

    var header = document.createElement("div");
    header.id = "vai-widget-header";
    var headerTitle = document.createElement("span");
    headerTitle.textContent = "Chat with us";
    var closeBtn = document.createElement("button");
    closeBtn.id = "vai-widget-close";
    closeBtn.setAttribute("aria-label", "Close chat");
    closeBtn.textContent = "✕";
    header.appendChild(headerTitle);
    header.appendChild(closeBtn);

    messagesEl = document.createElement("div");
    messagesEl.id = "vai-widget-messages";

    var inputRow = document.createElement("div");
    inputRow.id = "vai-widget-inputrow";
    inputEl = document.createElement("input");
    inputEl.id = "vai-widget-input";
    inputEl.type = "text";
    inputEl.placeholder = "Type a message...";
    sendBtn = document.createElement("button");
    sendBtn.id = "vai-widget-send";
    sendBtn.textContent = "Send";
    inputRow.appendChild(inputEl);
    inputRow.appendChild(sendBtn);

    panel.appendChild(header);
    panel.appendChild(messagesEl);
    panel.appendChild(inputRow);

    root.appendChild(panel);
    root.appendChild(bubble);
    document.body.appendChild(root);

    bubble.addEventListener("click", togglePanel);
    closeBtn.addEventListener("click", togglePanel);
    sendBtn.addEventListener("click", sendMessage);
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") sendMessage();
    });
  }

  function togglePanel() {
    isOpen = !isOpen;
    panel.classList.toggle("vai-open", isOpen);
    if (isOpen) {
      ensureSession();
      inputEl.focus();
    }
  }

  // ── Message rendering ────────────────────────────────────────────────────────
  function appendMessage(text, kind) {
    var el = document.createElement("div");
    el.className = "vai-msg vai-msg-" + kind;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  // ── Session handling ─────────────────────────────────────────────────────────
  function loadStoredSessionId() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      // localStorage can throw in some privacy modes — degrade gracefully,
      // the widget still works, it just won't persist across reloads.
      return null;
    }
  }

  function storeSessionId(id) {
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch (e) {
      // Ignore — non-fatal, see loadStoredSessionId.
    }
  }

  function ensureSession() {
    if (sessionReady) return Promise.resolve(sessionId);

    var stored = loadStoredSessionId();
    if (stored) {
      sessionId = stored;
      sessionReady = true;
      return Promise.resolve(sessionId);
    }

    return fetch(
      API_ORIGIN + "/api/session?slug=" + encodeURIComponent(TENANT),
      { method: "GET" }
    )
      .then(function (res) {
        if (!res.ok) throw new Error("session_http_" + res.status);
        return res.json();
      })
      .then(function (data) {
        if (!data || !data.sessionId) throw new Error("session_missing_id");
        sessionId = data.sessionId;
        sessionReady = true;
        storeSessionId(sessionId);
        return sessionId;
      })
      .catch(function (err) {
        console.error("[VAI Widget] Failed to create session:", err);
        appendMessage("Could not start chat session. Please refresh and try again.", "error");
        throw err;
      });
  }

  // ── Sending messages ─────────────────────────────────────────────────────────
  function setLoading(state) {
    isLoading = state;
    sendBtn.disabled = state;
    inputEl.disabled = state;
  }

  function sendMessage() {
    var text = inputEl.value.trim();
    if (!text || isLoading) return;

    appendMessage(text, "user");
    inputEl.value = "";
    setLoading(true);

    var loadingEl = appendMessage("...", "loading");

    ensureSession()
      .then(function (sid) {
        return fetch(API_ORIGIN + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slug: TENANT,
            sessionId: sid,
            prompt: text,
          }),
        });
      })
      .then(function (res) {
        loadingEl.remove();

        if (res.status === 429) {
          return res.json().catch(function () { return {}; }).then(function (body) {
            var msg = (body && body.error) || "Too many messages. Please wait a moment and try again.";
            appendMessage(msg, "error");
          });
        }

        if (!res.ok) {
          throw new Error("chat_http_" + res.status);
        }

        return res.json().then(function (data) {
          var reply = (data && data.reply) || "Sorry, I didn't get a response. Please try again.";
          appendMessage(reply, "bot");
        });
      })
      .catch(function (err) {
        if (loadingEl.parentNode) loadingEl.remove();
        console.error("[VAI Widget] Chat request failed:", err);
        appendMessage("Connection error. Please check your internet connection and try again.", "error");
      })
      .finally(function () {
        setLoading(false);
      });
  }

  // ── Boot ──────────────────────────────────────────────────────────────────────
  function init() {
    injectStyles();
    buildDom();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
