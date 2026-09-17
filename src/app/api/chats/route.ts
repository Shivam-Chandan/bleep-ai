import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { listChats, listMessages, createChat } from '@/lib/queries';
import { randomUUID } from 'node:crypto';

// GET /api/chats -> all chats (with messages) for the logged-in user
export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const chats = listChats(auth.userId).map((c) => ({
    id: c.id,
    title: c.title,
    createdAt: new Date(c.created_at).toISOString(),
    updatedAt: new Date(c.updated_at).toISOString(),
    messages: listMessages(c.id).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: new Date(m.created_at).toISOString(),
    })),
  }));

  return NextResponse.json({ chats });
}

// POST /api/chats -> create a new empty chat, returns its id
export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  let title = 'New Chat';
  try {
    const body = await request.json();
    if (typeof body?.title === 'string' && body.title.trim()) title = body.title.trim();
  } catch {
    // no body is fine
  }

  const id = randomUUID();
  const chat = createChat(auth.userId, id, title);
  return NextResponse.json({
    id: chat.id,
    title: chat.title,
    createdAt: new Date(chat.created_at).toISOString(),
    updatedAt: new Date(chat.updated_at).toISOString(),
    messages: [],
  });
}