import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { userOwnsChat } from '@/lib/queries';
import { requestStop } from '@/lib/generation';

// POST /api/chat/stop  { chatId }
// Explicitly stops an in-flight generation for a chat. The keep-alive design
// doesn't stop the model when the browser disconnects, so a deliberate user
// stop must be signalled through this endpoint.
export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  try {
    const { chatId } = await request.json();
    if (!chatId || typeof chatId !== 'string') {
      return NextResponse.json({ error: 'chatId is required' }, { status: 400 });
    }
    if (!(await userOwnsChat(auth.userId, chatId))) {
      return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
    }

    const stopped = requestStop(chatId);
    return NextResponse.json({ ok: stopped });
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
}