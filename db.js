import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Where the SQLite file lives. In Docker this is a mounted volume so the chat
// log survives container rebuilds/updates. Every conversation a kid has is
// stored here — this file is the record a grown-up can review.
const DB_PATH = process.env.DB_PATH || "./data/chat.db";

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Free text the kid typed on the welcome screen. NOCASE so "alex" and
    -- "Alex" are one person, in both lookups and the index below.
    kid        TEXT    NOT NULL COLLATE NOCASE,
    title      TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    role    TEXT    NOT NULL,
    content TEXT    NOT NULL,
    ts      INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chats_kid     ON chats(kid, updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
`);

/* Deleting a chat is a SOFT delete: the row is stamped with `deleted_at` and
 * disappears from the kid's sidebar, but it and all its messages stay in the
 * database. This database is the record a grown-up reviews, so a child must not
 * be able to erase a conversation from it. Nothing in the app ever issues a
 * DELETE — pruning, if it's ever wanted, is a deliberate act with sqlite3.
 *
 * Added after the first deploy, hence the migration rather than a column in the
 * CREATE TABLE above. */
const hasDeletedAt = db
  .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('chats') WHERE name = 'deleted_at'")
  .get().n > 0;
if (!hasDeletedAt) {
  db.exec("ALTER TABLE chats ADD COLUMN deleted_at INTEGER");
  console.log("db: added chats.deleted_at (soft delete)");
}

const createChatStmt = db.prepare(
  "INSERT INTO chats (kid, title, created_at, updated_at) VALUES (?, ?, ?, ?)"
);
const touchChatStmt = db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?");
const getChatStmt = db.prepare(
  "SELECT id, kid, title, created_at, updated_at, deleted_at FROM chats WHERE id = ?"
);
const listChatsStmt = db.prepare(`
  SELECT id, kid, title, created_at, updated_at FROM chats
  WHERE kid = ? AND deleted_at IS NULL
  ORDER BY updated_at DESC
  LIMIT ?
`);
const softDeleteStmt = db.prepare(
  "UPDATE chats SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
);

const insertMessageStmt = db.prepare(
  "INSERT INTO messages (chat_id, role, content, ts) VALUES (?, ?, ?, ?)"
);
const messagesStmt = db.prepare(`
  SELECT id, role, content, ts FROM messages
  WHERE chat_id = ?
  ORDER BY id ASC
`);

/** Start a new conversation. Called on the first message, not when the kid
 *  clicks "New chat" — that keeps empty shells out of the history list. */
export function createChat({ kid, title }) {
  const now = Date.now();
  const info = createChatStmt.run(kid, title, now, now);
  return getChatStmt.get(info.lastInsertRowid);
}

export function getChat(id) {
  return getChatStmt.get(Number(id));
}

export function listChats(kid, limit = 100) {
  return listChatsStmt.all(kid, Math.min(Math.max(Number(limit) || 100, 1), 500));
}

/** Hide a chat from the sidebar. The row and its messages are kept. */
export function deleteChat(id) {
  return softDeleteStmt.run(Date.now(), Number(id)).changes > 0;
}

export function getMessages(chatId) {
  return messagesStmt.all(Number(chatId));
}

/** Append a message and bump the chat's updated_at so it sorts to the top of
 *  the history list. Both halves in one transaction: a logged message always
 *  has a correctly-ordered parent chat. */
export const addMessage = db.transaction(({ chatId, role, content }) => {
  const ts = Date.now();
  const info = insertMessageStmt.run(chatId, role, content, ts);
  touchChatStmt.run(ts, chatId);
  return { id: info.lastInsertRowid, role, content, ts };
});

export default db;
