import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import {
  deleteChat,
  getChat,
  listAttachments,
  listMessages,
  updateChatTitle,
} from '@/lib/queries';
import type { Attachment } from '@/lib/types';

// GET /api/chats/:id -> one chat with its messages. The client calls this when a
// chat is opened so the sidebar/list request stays small and fast.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const chat = await getChat(auth.userId, id);
  if (!chat) {
    return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
  }
  const [messages, attachments] = await Promise.all([
    listMessages(id),
    listAttachments(auth.userId, id),
  ]);

  // Group the files by the turn that referenced them so each bubble can show
  // what it was grounded on. Metadata only — the extracted text is fetched
  // separately, on demand, when the user opens the preview.
  type WireAttachment = Omit<Attachment, 'createdAt'> & { createdAt: string };
  const byMessage = new Map<string, WireAttachment[]>();
  for (const row of attachments) {
    if (!row.message_id) continue;
    const list = byMessage.get(row.message_id) ?? [];
    list.push({
      id: row.id,
      chatId: row.chat_id,
      messageId: row.message_id,
      name: row.name,
      kind: row.kind,
      mime: row.mime,
      size: row.size,
      chars: row.chars,
      truncated: row.truncated,
      createdAt: new Date(row.created_at).toISOString(),
    });
    byMessage.set(row.message_id, list);
  }

  return NextResponse.json({
    id: chat.id,
    title: chat.title,
    createdAt: new Date(chat.created_at).toISOString(),
    updatedAt: new Date(chat.updated_at).toISOString(),
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: new Date(m.created_at).toISOString(),
      ...(m.sources && m.sources.length > 0 ? { sources: m.sources } : {}),
      ...(byMessage.has(m.id) ? { attachments: byMessage.get(m.id) } : {}),
    })),
  });
}

// DELETE /api/chats/:id
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const deleted = await deleteChat(auth.userId, id);
  if (!deleted) {
    return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

// PATCH /api/chats/:id  { title }
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!(await getChat(auth.userId, id))) {
    return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
  }

  const body = await request.json();
  const title = String(body?.title || '').trim();
  if (!title) {
    return NextResponse.json({ error: 'Title required' }, { status: 400 });
  }
  await updateChatTitle(auth.userId, id, title);
  return NextResponse.json({ ok: true });
}