import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { getLastAssistantMessage, userOwnsChat } from '@/lib/queries';
import { isActive, subscribe, type GenerationEvent } from '@/lib/generation';
import { sseEncode, SSE_CONTENT_TYPE, SSE_HEARTBEAT } from '@/lib/sse';

// Allow the resume stream to stay open for long-running generations.
export const maxDuration = 300;

// GET /api/chats/:id/events
// Resume stream for a chat whose generation may still be running server-side
// (internet blip, reload, or a stall). Protocol is identical to /api/chat:
// Server-Sent Events. On connect it first replays the persisted snapshot of the
// in-progress answer, then forwards live chunks until the generation finishes.
// If the generation is not running, it replays whatever was saved and ends.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  if (!(await userOwnsChat(auth.userId, id))) {
    return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      try {
        controller.enqueue(encoder.encode(SSE_HEARTBEAT));
      } catch {
        closed = true;
      }
      const send = (event: GenerationEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(sseEncode(event)));
        } catch {
          closed = true;
        }
      };

      // Subscribe before snapshotting so a chunk published between the two is
      // never missed: if it landed before the DB read it is in the snapshot,
      // if after, it arrives through the bus.
      unsubscribe = subscribe(id, send);

      try {
        const last = await getLastAssistantMessage(id);
        const active = isActive(id);
        // First event is always the state snapshot: active tells the client
        // whether to keep listening, messageId + content is the persisted copy.
        send({ type: 'resume', active, messageId: last?.id, content: last?.content });
        if (!active) {
          send({ type: 'done', messageId: last?.id });
          controller.close();
          unsubscribe?.();
          return;
        }
        // Generation still running; stay subscribed. The connection stays open
        // until the generation publishes a terminal event or the client leaves.
      } catch (error) {
        send({
          type: 'error',
          message: error instanceof Error ? error.message : 'Failed to load state',
        });
        controller.close();
        unsubscribe?.();
      }
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new NextResponse(stream, {
    headers: {
      // text/event-stream is excluded from platform/CDN compression, which
      // would otherwise buffer the stream and deliver tokens in one burst.
      'Content-Type': SSE_CONTENT_TYPE,
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}