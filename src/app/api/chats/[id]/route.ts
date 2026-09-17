import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { deleteChat, getChat, updateChatTitle } from '@/lib/queries';

// DELETE /api/chats/:id
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!getChat(auth.userId, id)) {
    return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
  }
  deleteChat(auth.userId, id);
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
  if (!getChat(auth.userId, id)) {
    return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
  }

  const body = await request.json();
  const title = String(body?.title || '').trim();
  if (!title) {
    return NextResponse.json({ error: 'Title required' }, { status: 400 });
  }
  updateChatTitle(auth.userId, id, title);
  return NextResponse.json({ ok: true });
}