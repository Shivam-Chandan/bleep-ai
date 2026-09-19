import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { listChats, createChat } from '@/lib/queries';
import { randomUUID } from 'node:crypto';

// GET /api/chats -> chat headers only (id/title/timestamps) for the logged-in
// user. Messages are intentionally omitted: fetching them here was an N+1 query
// (one per chat) that returned every message ever sent and made loading the app
// slower as history grew. The client lazy-loads a thread via GET /api/chats/:id.
export async function GET() {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const chatRows = await listChats(auth.userId);
  const chats = chatRows.map((c) => ({
    id: c.id,
    title: c.title,
    createdAt: new Date(c.created_at).toISOString(),
    updatedAt: new Date(c.updated_at).toISOString(),
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
  const chat = await createChat(auth.userId, id, title);
  return NextResponse.json({
    id: chat.id,
    title: chat.title,
    createdAt: new Date(chat.created_at).toISOString(),
    updatedAt: new Date(chat.updated_at).toISOString(),
    messages: [],
  });
}