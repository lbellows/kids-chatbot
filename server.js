import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createChat,
  getChat,
  listChats,
  deleteChat,
  getMessages,
  addMessage,
} from "./db.js";
import { SYSTEM_PROMPT, titleFromMessage } from "./prompt.js";
import { streamReply, isConfigured, modelName, AIError } from "./ai.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Who can use the bot. The kid picks a name on first visit and it's remembered
// in their browser; the name scopes the history sidebar and is stored on every
// chat row. Override with KIDS_NAMES=Ada,Grace in .env.
const KID_NAMES = (process.env.KIDS_NAMES || "Ada,Grace,Sam")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);

const MAX_MESSAGE_CHARS = 1000; // a 6-year-old's question is never this long
const MAX_TURNS = 20; // messages of history sent to the model

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(join(__dirname, "public")));

/** The kid's name, as supplied by the client. Only names on the configured
 *  list are accepted, so `kid` can never become arbitrary user-controlled
 *  data in the database. */
function kidFrom(value) {
  const name = String(value || "").trim();
  return KID_NAMES.find((n) => n.toLowerCase() === name.toLowerCase()) || null;
}

// Names for the picker + whether the server can actually reach a model. The
// front end shows a plain-English setup message instead of a broken chat box
// when Cloudflare credentials are missing.
app.get("/api/config", (_req, res) => {
  res.json({ kids: KID_NAMES, ready: isConfigured(), model: modelName() });
});

// History sidebar: this kid's conversations, newest first.
app.get("/api/chats", (req, res) => {
  const kid = kidFrom(req.query.kid);
  if (!kid) return res.status(400).json({ error: "Unknown name" });
  res.json(listChats(kid));
});

// One conversation, with its messages, for when a kid clicks it in the sidebar.
app.get("/api/chats/:id", (req, res) => {
  const kid = kidFrom(req.query.kid);
  const chat = getChat(req.params.id);
  if (!chat || !kid || chat.kid !== kid) {
    return res.status(404).json({ error: "Chat not found" });
  }
  res.json({ chat, messages: getMessages(chat.id) });
});

app.delete("/api/chats/:id", (req, res) => {
  const kid = kidFrom(req.query.kid);
  const chat = getChat(req.params.id);
  if (!chat || !kid || chat.kid !== kid) {
    return res.status(404).json({ error: "Chat not found" });
  }
  deleteChat(chat.id);
  res.json({ ok: true });
});

/* Send a message and stream the reply back as SSE.
 *
 * Body: { kid, chatId | null, text }
 * Events: {chatId, title} once when a new chat is created, then {text} deltas,
 *         then {done} — or {error} with a message written for a child.
 *
 * The child's message is written to the database BEFORE the model is called,
 * so the log is complete even if the model call fails or the tab is closed
 * mid-answer. That matters: this DB is the record a parent reviews. */
app.post("/api/chat", async (req, res) => {
  const kid = kidFrom(req.body?.kid);
  if (!kid) return res.status(400).json({ error: "Please pick your name first." });

  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ error: "Type a message first!" });
  if (text.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({ error: "That message is a bit too long!" });
  }

  let chat = null;
  if (req.body?.chatId != null) {
    chat = getChat(req.body.chatId);
    if (!chat || chat.kid !== kid) {
      return res.status(404).json({ error: "Chat not found" });
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  if (!chat) {
    chat = createChat({ kid, title: titleFromMessage(text) });
    send({ chatId: chat.id, title: chat.title });
  }
  addMessage({ chatId: chat.id, role: "user", content: text });

  // Stop generating if the child closes the tab or hits "New chat" mid-answer.
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  let answer = "";
  try {
    answer = await streamReply({
      messages: getMessages(chat.id)
        .slice(-MAX_TURNS)
        .map(({ role, content }) => ({ role, content })),
      system: SYSTEM_PROMPT,
      onDelta: (delta) => send({ text: delta }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      // Client went away. Fall through and log whatever was generated.
    } else {
      const message =
        err instanceof AIError
          ? err.message
          : "Oops, something went wrong. Can you ask me again?";
      if (!(err instanceof AIError)) console.error("chat error", err);
      send({ error: message });
    }
  }

  // Log the reply even on a partial/aborted stream — the transcript should
  // reflect what the child actually saw.
  if (answer.trim()) {
    addMessage({ chatId: chat.id, role: "assistant", content: answer });
  }

  send({ done: true });
  res.end();
});

app.get("/api/health", (_req, res) => res.json({ ok: true, ready: isConfigured() }));

app.listen(PORT, () => {
  console.log(`kids-chatbot listening on http://0.0.0.0:${PORT}`);
  console.log(`  kids:  ${KID_NAMES.join(", ")}`);
  console.log(`  model: ${modelName()}`);
  if (!isConfigured()) {
    console.warn(
      "  WARNING: CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN are not set — " +
        "chat will not work. See .env.example."
    );
  }
});
