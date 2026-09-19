import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { deleteChat, getChat, listMessages, updateChatTitle } from '@/lib/queries';

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
  const messages = await listMessages(id);
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