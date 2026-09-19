import 'server-only';
import { execute, select } from './db';
import { randomUUID } from 'node:crypto';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  created_at: number;
}

export interface ChatRow {
  id: string;
  user_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

// ---------- Users ----------

export async function createUser(
  username: string,
  passwordHash: string
): Promise<UserRow> {
  const user: UserRow = {
    id: randomUUID(),
    username,
    password_hash: passwordHash,
    created_at: Date.now(),
  };
  await execute(
    `INSERT INTO users (id, username, password_hash, created_at)
     VALUES (?, ?, ?, ?)`,
    [user.id, user.username, user.password_hash, user.created_at]
  );
  return user;
}

export async function getUserByUsername(
  username: string
): Promise<UserRow | undefined> {
  const rows = await select<UserRow>(
    `SELECT * FROM users WHERE username = ? COLLATE NOCASE`,
    [username]
  );
  return rows[0];
}

export async function getUserById(id: string): Promise<UserRow | undefined> {
  const rows = await select<UserRow>(`SELECT * FROM users WHERE id = ?`, [id]);
  return rows[0];
}

export async function updateUserPassword(
  userId: string,
  passwordHash: string
): Promise<void> {
  await execute(`UPDATE users SET password_hash = ? WHERE id = ?`, [
    passwordHash,
    userId,
  ]);
}

export async function countUsers(): Promise<number> {
  const rows = await select<{ n: number }>(`SELECT COUNT(*) AS n FROM users`);
  return rows[0]?.n ?? 0;
}

// ---------- Chats ----------

export async function listChats(userId: string): Promise<ChatRow[]> {
  return select<ChatRow>(
    `SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC`,
    [userId]
  );
}

export async function getChat(
  userId: string,
  chatId: string
): Promise<ChatRow | undefined> {
  const rows = await select<ChatRow>(
    `SELECT * FROM chats WHERE id = ? AND user_id = ?`,
    [chatId, userId]
  );
  return rows[0];
}

export async function createChat(
  userId: string,
  id: string,
  title = 'New Chat'
): Promise<ChatRow> {
  const now = Date.now();
  const chat: ChatRow = {
    id,
    user_id: userId,
    title,
    created_at: now,
    updated_at: now,
  };
  await execute(
    `INSERT INTO chats (id, user_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    [chat.id, chat.user_id, chat.title, chat.created_at, chat.updated_at]
  );
  return chat;
}

export async function updateChatTitle(
  userId: string,
  chatId: string,
  title: string
): Promise<void> {
  await execute(
    `UPDATE chats SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    [title, Date.now(), chatId, userId]
  );
}

export async function touchChat(chatId: string): Promise<void> {
  await execute(`UPDATE chats SET updated_at = ? WHERE id = ?`, [
    Date.now(),
    chatId,
  ]);
}

export async function deleteChat(
  userId: string,
  chatId: string
): Promise<void> {
  // Remove messages explicitly; remote libSQL does not enforce the
  // ON DELETE CASCADE foreign key by default.
  await execute(`DELETE FROM messages WHERE chat_id = ?`, [chatId]);
  await execute(`DELETE FROM chats WHERE id = ? AND user_id = ?`, [
    chatId,
    userId,
  ]);
}

// ---------- Messages ----------

export async function listMessages(chatId: string): Promise<MessageRow[]> {
  return select<MessageRow>(
    `SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC`,
    [chatId]
  );
}

export async function addMessage(
  chatId: string,
  role: 'user' | 'assistant',
  content: string
): Promise<MessageRow> {
  const msg: MessageRow = {
    id: randomUUID(),
    chat_id: chatId,
    role,
    content,
    created_at: Date.now(),
  };
  await execute(
    `INSERT INTO messages (id, chat_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [msg.id, msg.chat_id, msg.role, msg.content, msg.created_at]
  );
  await touchChat(chatId);
  return msg;
}

// Upsert a streamed assistant chunk into the in-flight response identified by
// `messageId` (the same id the client assigned its placeholder). Called for
// every chunk during generation so the partial answer is persisted to the DB
// and survives a client disconnect; idempotent across retries.
export async function addAssistantChunk(
  chatId: string,
  messageId: string,
  content: string
): Promise<void> {
  const info = await execute(
    `UPDATE messages SET content = ? WHERE id = ? AND chat_id = ?`,
    [content, messageId, chatId]
  );
  if (info.rowsAffected > 0) return;
  await execute(
    `INSERT INTO messages (id, chat_id, role, content, created_at)
     VALUES (?, ?, 'assistant', ?, ?)`,
    [messageId, chatId, content, Date.now()]
  );
  await touchChat(chatId);
}

export async function getLastAssistantMessage(
  chatId: string
): Promise<MessageRow | undefined> {
  const rows = await select<MessageRow>(
    `SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant'
     ORDER BY created_at ASC, rowid ASC`,
    [chatId]
  );
  return rows[rows.length - 1];
}

// Verify a chat belongs to a user (authorization helper).
export async function userOwnsChat(
  userId: string,
  chatId: string
): Promise<boolean> {
  return (await getChat(userId, chatId)) !== undefined;
}

// ---------- Ingest tokens ----------

export interface IngestTokenRow {
  token_hash: string;
  user_id: string;
  label: string;
  created_at: number;
  last_used_at: number | null;
}

export async function createIngestToken(
  userId: string,
  tokenHash: string,
  label: string
): Promise<void> {
  await execute(
    `INSERT INTO ingest_tokens (token_hash, user_id, label, created_at)
     VALUES (?, ?, ?, ?)`,
    [tokenHash, userId, label, Date.now()]
  );
}

export async function getUserIdByTokenHash(
  tokenHash: string
): Promise<string | undefined> {
  const rows = await select<{ user_id: string }>(
    `SELECT user_id FROM ingest_tokens WHERE token_hash = ?`,
    [tokenHash]
  );
  return rows[0]?.user_id;
}

export async function touchIngestToken(tokenHash: string): Promise<void> {
  await execute(`UPDATE ingest_tokens SET last_used_at = ? WHERE token_hash = ?`, [
    Date.now(),
    tokenHash,
  ]);
}

export async function listIngestTokens(
  userId: string
): Promise<IngestTokenRow[]> {
  return select<IngestTokenRow>(
    `SELECT * FROM ingest_tokens WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
}

export async function deleteIngestToken(
  userId: string,
  tokenHash: string
): Promise<void> {
  await execute(`DELETE FROM ingest_tokens WHERE token_hash = ? AND user_id = ?`, [
    tokenHash,
    userId,
  ]);
}

// ---------- Digest items ----------

export type DigestSource = 'gmail' | 'calendar' | 'slack' | 'zoom';

export interface DigestItemInput {
  source: DigestSource;
  day: string; // YYYY-MM-DD
  externalId?: string | null;
  payload: unknown; // serialized to JSON
}

export interface DigestItemRow {
  id: string;
  user_id: string;
  source: string;
  day: string;
  external_id: string | null;
  payload: string;
  created_at: number;
}

// Idempotent batch insert. Re-POSTing the same (user, source, externalId)
// is a no-op so integrations can safely retry. Returns items actually stored.
export async function addDigestItems(
  userId: string,
  items: DigestItemInput[]
): Promise<number> {
  let stored = 0;
  for (const item of items) {
    const info = await execute(
      `INSERT INTO digest_items
         (id, user_id, source, day, external_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, source, external_id) DO NOTHING`,
      [
        randomUUID(),
        userId,
        item.source,
        item.day,
        item.externalId ?? null,
        JSON.stringify(item.payload ?? null),
        Date.now(),
      ]
    );
    if (info.rowsAffected > 0) stored += 1;
  }
  return stored;
}

export async function listDigestItems(
  userId: string,
  day: string
): Promise<DigestItemRow[]> {
  return select<DigestItemRow>(
    `SELECT * FROM digest_items WHERE user_id = ? AND day = ?
     ORDER BY source ASC, created_at ASC`,
    [userId, day]
  );
}

// Distinct user ids that have any items for a given day (drives the cron loop).
export async function listUsersWithItemsForDay(day: string): Promise<string[]> {
  const rows = await select<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM digest_items WHERE day = ?`,
    [day]
  );
  return rows.map((r) => r.user_id);
}

// ---------- Digest summaries ----------

export interface DigestSummaryRow {
  user_id: string;
  day: string;
  content: string;
  created_at: number;
}

export async function upsertDigestSummary(
  userId: string,
  day: string,
  content: string
): Promise<void> {
  const info = await execute(
    `UPDATE digest_summaries SET content = ?, created_at = ?
     WHERE user_id = ? AND day = ?`,
    [content, Date.now(), userId, day]
  );
  if (info.rowsAffected > 0) return;
  await execute(
    `INSERT INTO digest_summaries (user_id, day, content, created_at)
     VALUES (?, ?, ?, ?)`,
    [userId, day, content, Date.now()]
  );
}

export async function getDigestSummary(
  userId: string,
  day: string
): Promise<DigestSummaryRow | undefined> {
  const rows = await select<DigestSummaryRow>(
    `SELECT * FROM digest_summaries WHERE user_id = ? AND day = ?`,
    [userId, day]
  );
  return rows[0];
}

export async function listRecentDigestSummaries(
  userId: string,
  limit = 14
): Promise<DigestSummaryRow[]> {
  return select<DigestSummaryRow>(
    `SELECT * FROM digest_summaries WHERE user_id = ?
     ORDER BY day DESC LIMIT ?`,
    [userId, limit]
  );
}

// Paginated feed for the infinite scroller. Returns the newest `limit` days
// strictly older than `before` (a YYYY-MM-DD cursor). Omit `before` for the
// first page. Fetches limit+1 to tell the client if more remain.
export async function listDigestSummariesPage(
  userId: string,
  limit: number,
  before?: string
): Promise<{ days: DigestSummaryRow[]; nextCursor: string | null }> {
  const fetchN = limit + 1;
  const rows = before
    ? await select<DigestSummaryRow>(
        `SELECT * FROM digest_summaries WHERE user_id = ? AND day < ?
         ORDER BY day DESC LIMIT ?`,
        [userId, before, fetchN]
      )
    : await select<DigestSummaryRow>(
        `SELECT * FROM digest_summaries WHERE user_id = ?
         ORDER BY day DESC LIMIT ?`,
        [userId, fetchN]
      );

  const hasMore = rows.length > limit;
  const days = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? days[days.length - 1].day : null;
  return { days, nextCursor };
}
