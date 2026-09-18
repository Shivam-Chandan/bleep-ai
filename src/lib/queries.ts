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
