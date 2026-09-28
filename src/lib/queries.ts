import 'server-only';
import { batch, execute, select, type BatchStatement } from './db';
import { randomUUID } from 'node:crypto';
import {
  decrypt,
  encrypt,
  encryptDeterministic,
  isEncrypted,
  normalizeUsername,
  sealUsername,
} from './crypto.mjs';
import type { AttachmentKind, Source } from './types';

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
  // Reference links behind a web-search-grounded answer. Stored as encrypted
  // JSON; null when the answer didn't use web search.
  sources: Source[] | null;
}

// Same shape as MessageRow but the encrypted, unparsed `sources` payload as
// SELECT returns it — used for the raw query before parseSources runs.
interface RawMessageRow {
  id: string;
  chat_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
  sources: string | null;
}

// Decrypt + validate the persisted sources payload into a type-safe array.
function parseSources(raw: string | null | undefined): Source[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(String(decrypt(raw) ?? ''));
    if (!Array.isArray(parsed)) return null;
    const sources = parsed.filter(
      (s): s is Source =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as Source).title === 'string' &&
        typeof (s as Source).url === 'string'
    );
    return sources.length > 0 ? sources : null;
  } catch {
    return null;
  }
}

function toMessageRow(r: RawMessageRow): MessageRow {
  return {
    ...r,
    content: String(decrypt(r.content) ?? ''),
    sources: parseSources(r.sources),
  };
}

// ---------- Attachments ----------

export interface AttachmentRow {
  id: string;
  user_id: string;
  chat_id: string;
  message_id: string | null;
  name: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  chars: number;
  text: string;
  truncated: boolean;
  created_at: number;
}

// What the browser needs. Never carries `text` — the chat transcript and the
// attachment list both ship metadata only, and the extracted body is fetched
// on demand by the single-file preview endpoint.
export type AttachmentMeta = Omit<AttachmentRow, 'user_id' | 'text'>;

function toAttachmentRow(r: AttachmentRow): AttachmentRow {
  return {
    ...r,
    name: String(decrypt(r.name) ?? ''),
    text: String(decrypt(r.text) ?? ''),
    truncated: Boolean(r.truncated),
  };
}

export interface NewAttachment {
  name: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  text: string;
  truncated: boolean;
}

export async function createAttachments(
  userId: string,
  chatId: string,
  files: NewAttachment[]
): Promise<AttachmentRow[]> {
  if (files.length === 0) return [];
  const now = Date.now();
  // One batch so N files cost a single remote round trip.
  await batch(
    files.map((file, i) => ({
      sql: `INSERT INTO attachments
              (id, user_id, chat_id, message_id, name, kind, mime, size, chars, text, truncated, created_at)
            VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        randomUUID(),
        userId,
        chatId,
        encrypt(file.name),
        file.kind,
        file.mime,
        file.size,
        file.text.length,
        encrypt(file.text),
        file.truncated ? 1 : 0,
        // Offset by index so files uploaded in the same millisecond keep the
        // order the user picked them in.
        now + i,
      ],
    }))
  );
  return listAttachments(userId, chatId);
}

// Ownership is enforced in the WHERE clause, so an unknown or foreign chat id
// simply yields an empty list instead of leaking existence.
export async function listAttachments(
  userId: string,
  chatId: string
): Promise<AttachmentRow[]> {
  const rows = await select<AttachmentRow>(
    `SELECT * FROM attachments WHERE user_id = ? AND chat_id = ?
      ORDER BY created_at ASC, rowid ASC`,
    [userId, chatId]
  );
  return rows.map(toAttachmentRow);
}

export async function getAttachment(
  userId: string,
  id: string
): Promise<AttachmentRow | undefined> {
  const rows = await select<AttachmentRow>(
    `SELECT * FROM attachments WHERE id = ? AND user_id = ?`,
    [id, userId]
  );
  const row = rows[0];
  return row ? toAttachmentRow(row) : undefined;
}

export async function countAttachments(userId: string, chatId: string): Promise<number> {
  const rows = await select<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attachments WHERE user_id = ? AND chat_id = ?`,
    [userId, chatId]
  );
  return rows[0]?.n ?? 0;
}

// Bind every not-yet-referenced file in the chat to the message that just
// referenced it. Runs in the same batch as the message insert so a turn and
// its attachments are never half-saved.
export async function bindAttachmentsToMessage(
  chatId: string,
  messageId: string
): Promise<void> {
  await execute(
    `UPDATE attachments SET message_id = ?
      WHERE chat_id = ? AND message_id IS NULL`,
    [messageId, chatId]
  );
}

export async function deleteAttachment(userId: string, id: string): Promise<boolean> {
  const info = await execute(`DELETE FROM attachments WHERE id = ? AND user_id = ?`, [
    id,
    userId,
  ]);
  return info.rowsAffected > 0;
}

// ---------- Users ----------

// Returned rows always carry the plaintext (normalized) username even though the
// column itself stores a deterministic ciphertext for case-insensitive lookup.
function userFromRow(row: UserRow): UserRow {
  return { ...row, username: normalizeUsername(String(decrypt(row.username) ?? '')) };
}

export async function createUser(
  username: string,
  passwordHash: string
): Promise<UserRow> {
  const user: UserRow = {
    id: randomUUID(),
    username: normalizeUsername(username),
    password_hash: passwordHash,
    created_at: Date.now(),
  };
  await execute(
    `INSERT INTO users (id, username, password_hash, created_at)
     VALUES (?, ?, ?, ?)`,
    [user.id, sealUsername(username), user.password_hash, user.created_at]
  );
  return user;
}

export async function getUserByUsername(
  username: string
): Promise<UserRow | undefined> {
  const sealed = sealUsername(username);
  let rows = await select<UserRow>(`SELECT * FROM users WHERE username = ?`, [
    sealed,
  ]);
  if (rows.length === 0) {
    // Row written before encryption was introduced: fall back to the plaintext
    // column and transparently migrate it to the sealed form.
    rows = await select<UserRow>(
      `SELECT * FROM users WHERE username = ? COLLATE NOCASE`,
      [String(username || '').trim()]
    );
    const legacy = rows[0];
    if (legacy && !isEncrypted(legacy.username)) {
      await execute(`UPDATE users SET username = ? WHERE id = ?`, [
        sealed,
        legacy.id,
      ]);
    }
  }
  const row = rows[0];
  return row ? userFromRow(row) : undefined;
}

export async function getUserById(id: string): Promise<UserRow | undefined> {
  const rows = await select<UserRow>(`SELECT * FROM users WHERE id = ?`, [id]);
  const row = rows[0];
  return row ? userFromRow(row) : undefined;
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
  const rows = await select<ChatRow>(
    `SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC`,
    [userId]
  );
  return rows.map((r) => ({ ...r, title: String(decrypt(r.title) ?? '') }));
}

export async function getChat(
  userId: string,
  chatId: string
): Promise<ChatRow | undefined> {
  const rows = await select<ChatRow>(
    `SELECT * FROM chats WHERE id = ? AND user_id = ?`,
    [chatId, userId]
  );
  const row = rows[0];
  return row ? { ...row, title: String(decrypt(row.title) ?? '') } : undefined;
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
    [chat.id, chat.user_id, encrypt(chat.title), chat.created_at, chat.updated_at]
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
    [encrypt(title), Date.now(), chatId, userId]
  );
}

export async function touchChat(chatId: string): Promise<void> {
  await execute(`UPDATE chats SET updated_at = ? WHERE id = ?`, [
    Date.now(),
    chatId,
  ]);
}

// Delete a chat owned by `userId`. Returns false when it does not exist (or is
// not owned), so callers get the ownership check for free instead of issuing a
// separate SELECT. Messages and attachments are removed explicitly first
// because remote libSQL does not enforce the ON DELETE CASCADE foreign key by
// default.
export async function deleteChat(
  userId: string,
  chatId: string
): Promise<boolean> {
  const info = await execute(`DELETE FROM chats WHERE id = ? AND user_id = ?`, [
    chatId,
    userId,
  ]);
  if (info.rowsAffected === 0) return false;
  await batch([
    { sql: `DELETE FROM messages WHERE chat_id = ?`, args: [chatId] },
    { sql: `DELETE FROM attachments WHERE chat_id = ?`, args: [chatId] },
  ]);
  return true;
}

// ---------- Messages ----------

export async function listMessages(chatId: string): Promise<MessageRow[]> {
  const rows = await select<RawMessageRow>(
    `SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC`,
    [chatId]
  );
  return rows.map(toMessageRow);
}

// Lightweight per-chat metadata used before persisting a new user turn: the
// total message count (to decide titling) and the last user message content (to
// make retries idempotent). Also doubles as the authorization check — returns
// null when the chat does not exist or is not owned by `userId`. One query
// replaces the previous ownership SELECT + message-stats SELECT pair.
export interface ChatMessageMeta {
  count: number;
  lastUserContent: string | null;
}

export async function getOwnedChatMeta(
  userId: string,
  chatId: string
): Promise<ChatMessageMeta | null> {
  const rows = await select<{ n: number; last_user: string | null }>(
    `SELECT (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) AS n,
            (SELECT content FROM messages
              WHERE chat_id = c.id AND role = 'user'
              ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_user
       FROM chats c
      WHERE c.id = ? AND c.user_id = ?`,
    [chatId, userId]
  );
  if (rows.length === 0) return null;
  const lastUser = rows[0]?.last_user;
  return {
    count: rows[0]?.n ?? 0,
    lastUserContent:
      lastUser === null || lastUser === undefined
        ? null
        : String(decrypt(lastUser)),
  };
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
    sources: null,
  };
  await execute(
    `INSERT INTO messages (id, chat_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [msg.id, msg.chat_id, msg.role, encrypt(msg.content), msg.created_at]
  );
  await touchChat(chatId);
  return msg;
}

// Persist a new user turn and bump the chat's recency in a single batch. When
// `title` is given it also names the chat (first message). Previously this was a
// message INSERT + touch UPDATE (+ title UPDATE), i.e. up to three sequential
// remote round trips before the model was even called.
export async function saveUserTurn(
  chatId: string,
  messageId: string,
  content: string,
  title?: string
): Promise<void> {
  const now = Date.now();
  const statements: BatchStatement[] = [
    {
      sql: `INSERT INTO messages (id, chat_id, role, content, created_at)
            VALUES (?, ?, 'user', ?, ?)`,
      args: [messageId, chatId, encrypt(content), now],
    },
    { sql: `UPDATE chats SET updated_at = ? WHERE id = ?`, args: [now, chatId] },
  ];
  if (title) {
    statements.push({
      sql: `UPDATE chats SET title = ? WHERE id = ?`,
      args: [title, chatId],
    });
  }
  await batch(statements);
}

// Upsert a streamed assistant chunk into the in-flight response identified by
// `messageId` (the same id the client assigned its placeholder). Called
// periodically during generation so the partial answer is persisted and
// survives a client disconnect. A single UPSERT replaces the previous
// UPDATE-then-INSERT probe; the recency bump rides along in the same batch, so
// each flush is one round trip instead of up to three.
export async function addAssistantChunk(
  chatId: string,
  messageId: string,
  content: string
): Promise<void> {
  const now = Date.now();
  await batch([
    {
      sql: `INSERT INTO messages (id, chat_id, role, content, created_at)
            VALUES (?, ?, 'assistant', ?, ?)
            ON CONFLICT(id) DO UPDATE SET content = excluded.content`,
      args: [messageId, chatId, encrypt(content), now],
    },
    { sql: `UPDATE chats SET updated_at = ? WHERE id = ?`, args: [now, chatId] },
  ]);
}

export async function getLastAssistantMessage(
  chatId: string
): Promise<MessageRow | undefined> {
  const rows = await select<RawMessageRow>(
    `SELECT * FROM messages WHERE chat_id = ? AND role = 'assistant'
     ORDER BY created_at ASC, rowid ASC`,
    [chatId]
  );
  const row = rows[rows.length - 1];
  return row ? toMessageRow(row) : undefined;
}

// Persist the reference links behind a web-search-grounded answer the moment
// they are known (before the answer streams), so they survive a reload or a
// dropped connection. The message row is created empty if the first chunk has
// not landed yet; later content UPSERTs preserve this column.
export async function saveAssistantSources(
  chatId: string,
  messageId: string,
  sources: Source[]
): Promise<void> {
  const now = Date.now();
  await batch([
    {
      sql: `INSERT INTO messages (id, chat_id, role, content, sources, created_at)
            VALUES (?, ?, 'assistant', '', ?, ?)
            ON CONFLICT(id) DO UPDATE SET sources = excluded.sources`,
      args: [messageId, chatId, encrypt(JSON.stringify(sources)), now],
    },
    { sql: `UPDATE chats SET updated_at = ? WHERE id = ?`, args: [now, chatId] },
  ]);
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
    [tokenHash, userId, encrypt(label), Date.now()]
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
  const rows = await select<IngestTokenRow>(
    `SELECT * FROM ingest_tokens WHERE user_id = ? ORDER BY created_at DESC`,
    [userId]
  );
  return rows.map((r) => ({ ...r, label: String(decrypt(r.label) ?? '') }));
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
        // Deterministic so re-POSTs of the same item still collide on the
        // unique (user_id, source, external_id) index and dedupe.
        item.externalId == null
          ? null
          : (encryptDeterministic(String(item.externalId)) as string),
        encrypt(JSON.stringify(item.payload ?? null)),
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
  const rows = await select<DigestItemRow>(
    `SELECT * FROM digest_items WHERE user_id = ? AND day = ?
     ORDER BY source ASC, created_at ASC`,
    [userId, day]
  );
  return rows.map((r) => ({
    ...r,
    external_id:
      r.external_id === null ? null : String(decrypt(r.external_id) ?? ''),
    payload: String(decrypt(r.payload) ?? ''),
  }));
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
    [encrypt(content), Date.now(), userId, day]
  );
  if (info.rowsAffected > 0) return;
  await execute(
    `INSERT INTO digest_summaries (user_id, day, content, created_at)
     VALUES (?, ?, ?, ?)`,
    [userId, day, encrypt(content), Date.now()]
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
  const row = rows[0];
  return row ? { ...row, content: String(decrypt(row.content) ?? '') } : undefined;
}

export async function listRecentDigestSummaries(
  userId: string,
  limit = 14
): Promise<DigestSummaryRow[]> {
  const rows = await select<DigestSummaryRow>(
    `SELECT * FROM digest_summaries WHERE user_id = ?
     ORDER BY day DESC LIMIT ?`,
    [userId, limit]
  );
  return rows.map((r) => ({ ...r, content: String(decrypt(r.content) ?? '') }));
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
  const plaintext = rows.map((r) => ({
    ...r,
    content: String(decrypt(r.content) ?? ''),
  }));
  const days = hasMore ? plaintext.slice(0, limit) : plaintext;
  const nextCursor = hasMore ? days[days.length - 1].day : null;
  return { days, nextCursor };
}

// ---------- Digest run queue ----------
// Generation happens on the box (scripts/digest-worker.mjs), not inside a
// Vercel function — see that script for why. These helpers are the handoff:
// the Next app only ever enqueues/reads; only the worker claims and writes.

export type DigestRunStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface DigestRunRow {
  id: string;
  user_id: string;
  day: string;
  status: DigestRunStatus;
  error: string | null;
  requested_at: number;
  started_at: number | null;
  finished_at: number | null;
}

// Idempotent: re-requesting a day that's pending/processing is a no-op (the
// existing row is left alone so it isn't reset mid-flight); re-requesting a
// done/failed day resets it back to pending so the worker regenerates it.
export async function enqueueDigestRun(
  userId: string,
  day: string
): Promise<string> {
  const existing = await select<{ id: string }>(
    `SELECT id FROM digest_runs WHERE user_id = ? AND day = ?`,
    [userId, day]
  );
  const now = Date.now();
  if (existing[0]) {
    await execute(
      `UPDATE digest_runs
       SET status = 'pending', error = NULL, requested_at = ?,
           started_at = NULL, finished_at = NULL
       WHERE id = ? AND status IN ('done', 'failed')`,
      [now, existing[0].id]
    );
    return existing[0].id;
  }
  const id = randomUUID();
  await execute(
    `INSERT INTO digest_runs (id, user_id, day, status, requested_at)
     VALUES (?, ?, ?, 'pending', ?)`,
    [id, userId, day, now]
  );
  return id;
}

export async function getDigestRun(
  id: string
): Promise<DigestRunRow | undefined> {
  const rows = await select<DigestRunRow>(
    `SELECT * FROM digest_runs WHERE id = ?`,
    [id]
  );
  const row = rows[0];
  return row
    ? { ...row, error: row.error === null ? null : String(decrypt(row.error)) }
    : undefined;
}

export async function listPendingDigestRuns(
  limit = 10
): Promise<DigestRunRow[]> {
  const rows = await select<DigestRunRow>(
    `SELECT * FROM digest_runs WHERE status = 'pending'
     ORDER BY requested_at ASC LIMIT ?`,
    [limit]
  );
  return rows.map((r) => ({
    ...r,
    error: r.error === null ? null : String(decrypt(r.error)),
  }));
}

// Atomic claim: only succeeds if the row is still 'pending' (guards against
// two worker instances racing on the same row). Returns true on success.
export async function claimDigestRun(id: string): Promise<boolean> {
  const info = await execute(
    `UPDATE digest_runs SET status = 'processing', started_at = ?
     WHERE id = ? AND status = 'pending'`,
    [Date.now(), id]
  );
  return info.rowsAffected > 0;
}

export async function markDigestRunDone(id: string): Promise<void> {
  await execute(
    `UPDATE digest_runs SET status = 'done', finished_at = ?, error = NULL
     WHERE id = ?`,
    [Date.now(), id]
  );
}

export async function markDigestRunFailed(
  id: string,
  error: string
): Promise<void> {
  await execute(
    `UPDATE digest_runs SET status = 'failed', finished_at = ?, error = ?
     WHERE id = ?`,
    [Date.now(), encrypt(error.slice(0, 2000)), id]
  );
}

// Crash recovery: a worker that dies mid-generation leaves its row stuck in
// 'processing' forever. Called at the start of each poll cycle to reclaim
// rows that have been "processing" for longer than any real generation
// should take.
export async function requeueStaleDigestRuns(maxAgeMs: number): Promise<number> {
  const info = await execute(
    `UPDATE digest_runs SET status = 'pending', started_at = NULL
     WHERE status = 'processing' AND started_at < ?`,
    [Date.now() - maxAgeMs]
  );
  return info.rowsAffected;
}
