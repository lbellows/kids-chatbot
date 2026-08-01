/* Sparky — front end.
 *
 * One conversation at a time. `chatId` is null for a chat that hasn't been
 * saved yet; the server creates the row on the first message and sends the new
 * id back on the stream, which is when it appears in the history sidebar.
 */
(function () {
  "use strict";

  var KID_KEY = "kids-chatbot.kid";

  var MAX_NAME = 24; // keep in step with MAX_NAME_CHARS in server.js

  /* Hides the per-chat trash icon in the sidebar. Everything behind it is
     intentionally left in place — deleteChat() below, the DELETE /api/chats/:id
     route, and the soft delete in db.js — so flipping this back to true is the
     only change needed to bring the button back. */
  var SHOW_DELETE_BUTTON = false;

  var state = {
    kid: null,
    ready: false,
    chatId: null,
    messages: [], // {role, content}[] — mirrors what the server has stored
    busy: false,
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    app: $("app"),
    picker: $("namePicker"),
    nameForm: $("nameForm"),
    nameInput: $("nameInput"),
    nameHint: $("nameHint"),
    sidebar: $("sidebar"),
    scrim: $("scrim"),
    history: $("history"),
    messages: $("messages"),
    chatTitle: $("chatTitle"),
    input: $("input"),
    send: $("send"),
    composer: $("composer"),
    scrollDown: $("scrollDown"),
    whoami: $("whoami"),
    whoamiName: $("whoamiName"),
    emojiBtn: $("emojiBtn"),
    emojiPanel: $("emojiPanel"),
  };

  /* ---------- boot ---------- */

  fetch("/api/config")
    .then(function (r) { return r.json(); })
    .then(function (cfg) {
      state.ready = !!cfg.ready;

      var saved = cleanName(localStorage.getItem(KID_KEY) || "");
      if (saved) {
        startAs(saved);
      } else {
        showPicker();
      }
    })
    .catch(function () {
      els.app.hidden = false;
      renderMessages();
      showError("I can't reach the server. Is it running?");
    });

  /* Mirror of kidFrom() in server.js: strip control characters, collapse
     runs of whitespace, trim, and cap the length. Doing it here too means the
     name shown in the UI is exactly the one the server will store. */
  function cleanName(value) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_NAME);
  }

  function showPicker() {
    els.picker.hidden = false;
    els.app.hidden = true;
    els.nameHint.hidden = true;
    els.nameInput.value = "";
    els.nameInput.focus();
  }

  els.nameForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var name = cleanName(els.nameInput.value);
    if (!name) {
      els.nameHint.textContent = "Please type your name so I know who you are!";
      els.nameHint.hidden = false;
      els.nameInput.focus();
      return;
    }
    localStorage.setItem(KID_KEY, name);
    startAs(name);
  });

  function startAs(name) {
    state.kid = name;
    els.picker.hidden = true;
    els.app.hidden = false;
    // No emoji here on purpose: this label is written during boot and Chromium
    // paints it before the emoji font is ready, then never re-lays it out.
    // The log-out icon next to it is inline SVG in index.html for the same
    // reason. See docs/fonts.md.
    els.whoamiName.textContent = name + " — not you?";
    newChat();
    autoGrow(); // now that the app is visible, size the input for real
    loadHistory();
  }

  /* ---------- history sidebar ---------- */

  function loadHistory() {
    fetch("/api/chats?kid=" + encodeURIComponent(state.kid))
      .then(function (r) { return r.json(); })
      .then(renderHistory)
      .catch(function () { /* sidebar is non-critical; leave it as-is */ });
  }

  function renderHistory(chats) {
    els.history.innerHTML = "";
    if (!chats || !chats.length) {
      var empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "No chats yet. Ask me something!";
      els.history.appendChild(empty);
      return;
    }

    chats.forEach(function (chat) {
      var row = document.createElement("div");
      row.className = "history-item" + (chat.id === state.chatId ? " active" : "");

      var open = document.createElement("button");
      open.className = "open";
      open.textContent = chat.title;
      open.title = chat.title;
      open.addEventListener("click", function () { openChat(chat.id); });

      row.appendChild(open);

      if (SHOW_DELETE_BUTTON) {
        var del = document.createElement("button");
        del.className = "del";
        del.textContent = "🗑";
        del.title = "Delete this chat";
        del.setAttribute("aria-label", "Delete chat: " + chat.title);
        del.addEventListener("click", function (e) {
          e.stopPropagation();
          deleteChat(chat.id);
        });
        row.appendChild(del);
      }

      els.history.appendChild(row);
    });
  }

  function openChat(id) {
    if (state.busy) return;
    fetch("/api/chats/" + id + "?kid=" + encodeURIComponent(state.kid))
      .then(function (r) {
        if (!r.ok) throw new Error("not found");
        return r.json();
      })
      .then(function (data) {
        state.chatId = data.chat.id;
        state.messages = data.messages.map(function (m) {
          return { role: m.role, content: m.content };
        });
        els.chatTitle.textContent = data.chat.title;
        renderMessages();
        closeSidebar();
        loadHistory();
      })
      .catch(function () { showError("I couldn't open that chat."); });
  }

  function deleteChat(id) {
    fetch("/api/chats/" + id + "?kid=" + encodeURIComponent(state.kid), {
      method: "DELETE",
    })
      .then(function () {
        if (state.chatId === id) newChat();
        loadHistory();
      })
      .catch(function () { /* ignore */ });
  }

  function newChat() {
    if (state.busy) return;
    state.chatId = null;
    state.messages = [];
    els.chatTitle.textContent = "Sparky";
    renderMessages();
    renderHistoryActive();
    closeSidebar();
    els.input.focus();
  }

  // Cheap re-highlight without a round trip (used when starting a new chat).
  function renderHistoryActive() {
    Array.prototype.forEach.call(
      els.history.querySelectorAll(".history-item"),
      function (row) { row.classList.remove("active"); }
    );
  }

  /* ---------- rendering ---------- */

  function escapeHtml(s) {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* Tiny markdown renderer for the bot's replies. Everything is HTML-escaped
     *before* any formatting is applied, so model output can never inject
     markup. Only the handful of things the prompt asks for: paragraphs, bold,
     italics, inline code, and short lists. */
  function renderMarkdown(md) {
    var lines = escapeHtml(md).split("\n");
    var out = [];
    var listType = null;

    function inline(s) {
      return s
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|\s)\*([^*\n]+)\*/g, "$1<em>$2</em>");
    }
    function closeList() {
      if (listType) { out.push("</" + listType + ">"); listType = null; }
    }

    lines.forEach(function (line) {
      var m;
      if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
        if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
        out.push("<li>" + inline(m[1]) + "</li>");
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
        out.push("<li>" + inline(m[1]) + "</li>");
      } else if ((m = line.match(/^#{1,6}\s+(.*)$/))) {
        closeList();
        out.push("<p><strong>" + inline(m[1]) + "</strong></p>");
      } else if (line.trim() !== "") {
        closeList();
        out.push("<p>" + inline(line) + "</p>");
      } else {
        closeList();
      }
    });
    closeList();
    return out.join("");
  }

  /* The welcome screen shows a few of these, picked at random each time it is
     drawn (first load, and every new chat) so the home page feels different
     every visit. Keep them short enough to fit on one line of a pill. */
  var SUGGESTIONS = [
    "Why is the sky blue?",
    "Tell me a funny joke",
    "How do birds fly?",
    "Help me with my spelling",
    "Why do we have to sleep?",
    "How big is a blue whale?",
    "Tell me a story about a dragon",
    "What do dinosaurs eat?",
    "Why is the ocean salty?",
    "How do rainbows happen?",
    "What's inside a volcano?",
    "How does a plant grow?",
    "Why do cats purr?",
    "What are stars made of?",
    "Help me with my times tables",
    "Give me a riddle to solve",
    "How does a bicycle stay up?",
    "Why do we get hiccups?",
    "What's the fastest animal?",
    "How do bees make honey?",
    "Tell me a fun fact about space",
    "Why do leaves change colour?",
    "How does a rocket work?",
    "What should I draw today?",
    "Teach me a new word",
    "Why do we yawn?",
    "How deep is the sea?",
    "Tell me about the moon",
  ];

  var SUGGESTIONS_SHOWN = 4;

  /* Random sample without replacement: shuffle a copy and take the front.
     `slice()` first so the constant above keeps its order for the next call. */
  function pickSuggestions(n) {
    var pool = SUGGESTIONS.slice();
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = pool[i];
      pool[i] = pool[j];
      pool[j] = tmp;
    }
    return pool.slice(0, n);
  }

  function renderWelcome() {
    var wrap = document.createElement("div");
    wrap.className = "welcome";

    var big = document.createElement("div");
    big.className = "big";
    big.textContent = "⭐";

    var h = document.createElement("h3");
    h.textContent = state.kid ? "Hi " + state.kid + "!" : "Hi there!";

    var p = document.createElement("p");
    p.textContent = state.ready
      ? "Ask me anything you're curious about."
      : "I'm not quite awake yet — a grown-up needs to finish setting me up.";

    wrap.appendChild(big);
    wrap.appendChild(h);
    wrap.appendChild(p);

    if (state.ready) {
      var sug = document.createElement("div");
      sug.className = "suggestions";
      pickSuggestions(SUGGESTIONS_SHOWN).forEach(function (text) {
        var b = document.createElement("button");
        b.textContent = text;
        b.addEventListener("click", function () { sendMessage(text); });
        sug.appendChild(b);
      });
      wrap.appendChild(sug);
    } else {
      wrap.appendChild(setupNote());
    }
    els.messages.appendChild(wrap);
  }

  function setupNote() {
    var note = document.createElement("div");
    note.className = "setup-note";
    note.innerHTML =
      "<h3>Setup needed</h3>" +
      "<p>Copy <code>.env.example</code> to <code>.env</code> and fill in " +
      "<code>CLOUDFLARE_ACCOUNT_ID</code> and <code>CLOUDFLARE_API_TOKEN</code>, " +
      "then restart the container.</p>";
    return note;
  }

  function addBubble(role, text) {
    var msg = document.createElement("div");
    msg.className = "msg " + role;

    var avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = role === "user" ? "🙂" : role === "error" ? "😅" : "⭐";
    avatar.setAttribute("aria-hidden", "true");

    var bubble = document.createElement("div");
    bubble.className = "bubble";
    if (role === "assistant") {
      bubble.innerHTML = renderMarkdown(text);
    } else {
      bubble.textContent = text;
    }

    msg.appendChild(avatar);
    msg.appendChild(bubble);
    els.messages.appendChild(msg);
    maybeScroll(role === "user");
    return msg;
  }

  function renderMessages() {
    els.messages.innerHTML = "";
    if (!state.messages.length) {
      renderWelcome();
    } else {
      state.messages.forEach(function (m) { addBubble(m.role, m.content); });
    }
    maybeScroll(true);
  }

  function showError(text) {
    addBubble("error", text);
  }

  /* ---------- scrolling ----------
     Follow the stream only while the reader is already at the bottom; once
     they scroll up to re-read something, stop yanking them back down. */

  var stickToBottom = true;

  function atBottom() {
    return (
      els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 60
    );
  }
  function maybeScroll(force) {
    if (force || stickToBottom) {
      els.messages.scrollTop = els.messages.scrollHeight;
      stickToBottom = true;
    }
    els.scrollDown.hidden = atBottom();
  }
  els.messages.addEventListener("scroll", function () {
    stickToBottom = atBottom();
    els.scrollDown.hidden = stickToBottom;
  });
  els.scrollDown.addEventListener("click", function () { maybeScroll(true); });

  /* ---------- sending ---------- */

  function sendMessage(text) {
    if (state.busy || !text) return;

    if (!state.messages.length) els.messages.innerHTML = ""; // drop the welcome
    state.messages.push({ role: "user", content: text });
    addBubble("user", text);

    state.busy = true;
    els.send.disabled = true;

    var pending = addBubble("assistant", "");
    pending.classList.add("thinking");
    pending.querySelector(".bubble").innerHTML = "<span></span><span></span><span></span>";
    var answer = "";
    var streamError = null;

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kid: state.kid, chatId: state.chatId, text: text }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json()
            .catch(function () { return {}; })
            .then(function (data) {
              throw new Error(data.error || "Something went wrong. Try again!");
            });
        }

        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";

        function pump() {
          return reader.read().then(function (result) {
            if (result.done) return;
            buffer += decoder.decode(result.value, { stream: true });
            var frames = buffer.split("\n\n");
            buffer = frames.pop();
            frames.forEach(function (frame) {
              if (frame.indexOf("data: ") !== 0) return;
              var payload;
              try {
                payload = JSON.parse(frame.slice(6));
              } catch (_) {
                return;
              }
              if (payload.chatId) {
                // First message of a brand-new conversation: adopt the id the
                // server just created so follow-ups land in the same chat.
                state.chatId = payload.chatId;
                els.chatTitle.textContent = payload.title;
                loadHistory();
              }
              if (payload.text) {
                answer += payload.text;
                pending.classList.remove("thinking");
                pending.querySelector(".bubble").innerHTML = renderMarkdown(answer);
                maybeScroll(false);
              } else if (payload.error) {
                streamError = payload.error;
              }
            });
            return pump();
          });
        }
        return pump();
      })
      .then(function () {
        if (answer) {
          state.messages.push({ role: "assistant", content: answer });
        } else {
          pending.remove();
          state.messages.pop(); // let them retry the unanswered question
        }
        if (streamError) showError(streamError);
      })
      .catch(function (err) {
        pending.remove();
        if (!answer) state.messages.pop();
        showError(err.message || "Something went wrong. Try again!");
      })
      .finally(function () {
        state.busy = false;
        els.send.disabled = false;
        els.input.focus();
        loadHistory();
      });
  }

  /* ---------- input ---------- */

  els.composer.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = els.input.value.trim();
    if (!text) return;
    els.input.value = "";
    autoGrow();
    setEmojiOpen(false);
    sendMessage(text);
  });

  els.input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      els.composer.requestSubmit();
    }
  });

  /* Size the box to its content. Scrolling is suppressed in CSS and only
     switched on once we're clamped at max-height, so a single-line box never
     shows a stub scrollbar. */
  var MAX_INPUT_H = 160;
  function autoGrow() {
    var el = els.input;
    el.style.height = "auto";
    // While the app is still `hidden` nothing has been laid out, so scrollHeight
    // reads 0 and we'd pin the box to a few pixels tall for good. Leave the
    // stylesheet height alone until the element is actually on screen.
    if (el.scrollHeight === 0) {
      el.style.overflowY = "hidden";
      return;
    }
    // scrollHeight excludes the border, but `box-sizing: border-box` (set
    // globally) means style.height includes it. Without adding the border back
    // the box lands a few px short of its own content, which both clips the
    // last line and is what produced the stub scrollbar on a one-line input.
    var cs = getComputedStyle(el);
    var borders =
      (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    var wanted = el.scrollHeight + borders;
    el.style.height = Math.min(wanted, MAX_INPUT_H) + "px";
    el.style.overflowY = wanted > MAX_INPUT_H ? "auto" : "hidden";
  }
  els.input.addEventListener("input", autoGrow);

  /* ---------- emoji picker ---------- */

  var EMOJI = (
    "😀 😃 😄 😁 😆 😊 🙂 😉 😍 🥰 😘 😋 😜 🤪 🤗 🤔 " +
    "😎 🥳 😢 😮 😴 🤢 🤠 👻 🤖 👽 🎃 💩 " +
    "❤️ 🧡 💛 💚 💙 💜 ⭐ 🌟 ✨ 💫 🔥 ⚡ 🌈 ☀️ 🌙 ☁️ " +
    "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🦄 " +
    "🐝 🦋 🐢 🐍 🐙 🐳 🐬 🐟 🦕 🦖 🦔 🦉 🐴 🐛 " +
    "🌸 🌼 🌻 🌷 🌵 🌲 🍀 🍎 🍌 🍓 🍕 🍔 🍟 🍦 🍪 🍩 " +
    "🎂 🍭 🥕 🌽 ⚽ 🏀 🎾 🎨 🎵 🎸 🚀 ✈️ 🚗 🚂 🏰 🎁 " +
    "👍 👎 👋 🙌 👏 🤝 💪 🎉 ❓ ❗"
  ).split(" ");

  var emojiOpen = false;

  function buildEmojiPanel() {
    EMOJI.forEach(function (ch) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = ch;
      b.setAttribute("aria-label", "Insert " + ch);
      b.addEventListener("click", function () { insertEmoji(ch); });
      els.emojiPanel.appendChild(b);
    });
  }

  /* Insert at the caret rather than appending, so a kid can drop an emoji into
     the middle of what they've already typed. */
  function insertEmoji(ch) {
    var el = els.input;
    var start = el.selectionStart != null ? el.selectionStart : el.value.length;
    var end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, start) + ch + el.value.slice(end);
    var caret = start + ch.length;
    el.setSelectionRange(caret, caret);
    el.focus();
    autoGrow();
  }

  function setEmojiOpen(open) {
    emojiOpen = open;
    els.emojiPanel.hidden = !open;
    els.emojiBtn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  els.emojiBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    setEmojiOpen(!emojiOpen);
  });
  els.emojiPanel.addEventListener("click", function (e) { e.stopPropagation(); });
  document.addEventListener("click", function () {
    if (emojiOpen) setEmojiOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && emojiOpen) {
      setEmojiOpen(false);
      els.input.focus();
    }
  });

  buildEmojiPanel();

  /* ---------- chrome ---------- */

  function openSidebar() {
    els.sidebar.classList.add("open");
    els.scrim.hidden = false;
  }
  function closeSidebar() {
    els.sidebar.classList.remove("open");
    els.scrim.hidden = true;
  }

  $("newChat").addEventListener("click", newChat);
  $("newChatMobile").addEventListener("click", newChat);
  $("openSidebar").addEventListener("click", openSidebar);
  $("closeSidebar").addEventListener("click", closeSidebar);
  els.scrim.addEventListener("click", closeSidebar);

  els.whoami.addEventListener("click", function () {
    localStorage.removeItem(KID_KEY);
    state.kid = null;
    showPicker();
  });
})();
