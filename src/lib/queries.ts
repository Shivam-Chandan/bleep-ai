import 'server-only';
import { db } from './db';
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

export function createUser(username: string, passwordHash: string): UserRow {
  const user: UserRow = {
    id: randomUUID(),
    username,
    password_hash: passwordHash,
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO users (id, username, password_hash, created_at)
     VALUES (@id, @username, @password_hash, @created_at)`
  ).run(user);
  return user;
}

export function getUserByUsername(username: string): UserRow | undefined {
  return db
    .prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`)
    .get(username) as UserRow | undefined;
}

export function getUserById(id: string): UserRow | undefined {
  return db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
    | UserRow
    | undefined;
}

export function countUsers(): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number };
  return row.n;
}

// ---------- Chats ----------

export function listChats(userId: string): ChatRow[] {
  return db
    .prepare(`SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC`)
    .all(userId) as ChatRow[];
}

export function getChat(userId: string, chatId: string): ChatRow | undefined {
  return db
    .prepare(`SELECT * FROM chats WHERE id = ? AND user_id = ?`)
    .get(chatId, userId) as ChatRow | undefined;
}

export function createChat(userId: string, id: string, title = 'New Chat'): ChatRow {
  const now = Date.now();
  const chat: ChatRow = {
    id,
    user_id: userId,
    title,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO chats (id, user_id, title, created_at, updated_at)
     VALUES (@id, @user_id, @title, @created_at, @updated_at)`
  ).run(chat);
  return chat;
}

export function updateChatTitle(userId: string, chatId: string, title: string): void {
  db.prepare(
    `UPDATE chats SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`
  ).run(title, Date.now(), chatId, userId);
}

export function touchChat(chatId: string): void {
  db.prepare(`UPDATE chats SET updated_at = ? WHERE id = ?`).run(Date.now(), chatId);
}

export function deleteChat(userId: string, chatId: string): void {
  db.prepare(`DELETE FROM chats WHERE id = ? AND user_id = ?`).run(chatId, userId);
}

// ---------- Messages ----------

export function listMessages(chatId: string): MessageRow[] {
  return db
    .prepare(`SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC`)
    .all(chatId) as MessageRow[];
}

export function addMessage(
  chatId: string,
  role: 'user' | 'assistant',
  content: string
): MessageRow {
  const msg: MessageRow = {
    id: randomUUID(),
    chat_id: chatId,
    role,
    content,
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO messages (id, chat_id, role, content, created_at)
     VALUES (@id, @chat_id, @role, @content, @created_at)`
  ).run(msg);
  touchChat(chatId);
  return msg;
}

// Verify a chat belongs to a user (authorization helper).
export function userOwnsChat(userId: string, chatId: string): boolean {
  return getChat(userId, chatId) !== undefined;
}