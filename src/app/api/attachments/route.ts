import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import {
  createAttachments,
  deleteAttachment,
  getAttachment,
  getChat,
  listAttachments,
  type AttachmentRow,
  type NewAttachment,
} from '@/lib/queries';
import {
  detectKind,
  EmptyDocumentError,
  extractDocumentText,
  UnsupportedFileError,
} from '@/lib/extract';
import {
  base64ToBytes,
  MAX_FILES_PER_CHAT,
  MAX_FILE_BYTES,
  MAX_REQUEST_BYTES,
} from '@/lib/attachments';
import type { Attachment, AttachmentKind } from '@/lib/types';

// Parsing and writing run well past a normal request's default budget on a
// slow box, and the platform's ceiling is what keeps long generations alive
// elsewhere — match the chat route so both behave the same.
export const maxDuration = 300;

interface UploadedFile {
  name: string;
  type?: string;
  data: string;
}

function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    name: row.name,
    kind: row.kind,
    mime: row.mime,
    size: row.size,
    chars: row.chars,
    truncated: row.truncated,
    createdAt: new Date(row.created_at),
  };
}

function fail(message: string, status: number, code = 'invalid_attachment') {
  return NextResponse.json({ error: message, code }, { status });
}

// POST /api/attachments
//
// Uploads are JSON rather than multipart: the browser base64-encodes one file
// per request, which keeps the endpoint a plain JSON handler (no body-parser
// setup, no temp files) and lets the server size-check before touching disk.
export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  let body: { chatId?: string; files?: UploadedFile[] };
  try {
    body = await request.json();
  } catch {
    return fail('Malformed upload payload.', 400);
  }

  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
  if (!chatId) return fail('A chatId is required.', 400);

  // Ownership check before any parsing work: a user must not be able to burn
  // CPU on a document upload against somebody else's chat.
  if (!(await getChat(auth.userId, chatId))) {
    return NextResponse.json({ error: 'Chat not found' }, { status: 404 });
  }
  const existing = await listAttachments(auth.userId, chatId);

  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0) return fail('No files were supplied.', 400);
  if (files.length > MAX_FILES_PER_CHAT) {
    return fail(
      `At most ${MAX_FILES_PER_CHAT} files can be attached at once.`,
      400
    );
  }
  if (existing.length + files.length > MAX_FILES_PER_CHAT) {
    return fail(
      `This chat already has ${existing.length} of ${MAX_FILES_PER_CHAT} allowed files attached.`,
      400
    );
  }

  // Size checks run before decoding so an oversized request is rejected
  // without paying for a base64 expansion.
  const decoded: { file: UploadedFile; bytes: Uint8Array }[] = [];
  let total = 0;
  for (const file of files) {
    const name = String(file?.name ?? '').trim();
    if (!name) return fail('A file is missing its name.', 400);
    if (typeof file.data !== 'string' || !file.data) {
      return fail(`“${name}” was uploaded empty.`, 400);
    }
    const bytes = base64ToBytes(file.data);
    if (bytes.byteLength === 0) {
      return fail(`“${name}” could not be decoded — the upload was corrupted.`, 400);
    }
    if (bytes.byteLength > MAX_FILE_BYTES) {
      return fail(
        `“${name}” is larger than the ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB limit.`,
        413
      );
    }
    total += bytes.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      return fail(
        `That upload is too large. Keep each file under ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`,
        413
      );
    }
    decoded.push({ file, bytes });
  }

  const prepared: NewAttachment[] = [];
  for (const { file, bytes } of decoded) {
    const name = String(file.name).trim();
    // Read the length before parsing: unpdf drives PDF.js in a Web Worker and
    // the transfer detaches the underlying ArrayBuffer, which would make
    // bytes.byteLength read 0 after extraction.
    const size = bytes.byteLength;
    let kind: AttachmentKind | null;
    try {
      kind = detectKind(name, file.type);
    } catch (error) {
      // Legacy binary .doc/.ppt — recognised so we can say what to do about it.
      return fail(
        error instanceof Error ? error.message : `“${name}” is not supported.`,
        415
      );
    }
    if (!kind) {
      return fail(
        `“${name}” is not supported. Attach a PDF, Word document (.docx) or PowerPoint deck (.pptx).`,
        415
      );
    }

    let text: string;
    let truncated: boolean;
    try {
      ({ text, truncated } = await extractDocumentText(kind, bytes));
    } catch (error) {
      if (error instanceof EmptyDocumentError) {
        return fail(error.message, 422, 'empty_document');
      }
      if (error instanceof UnsupportedFileError) {
        return fail(error.message, 415);
      }
      // A corrupt file reaches the parser as a raw throw. Report it against
      // this file rather than failing the whole batch, and log the detail.
      console.error(`Failed to parse attachment ${name}:`, error);
      return fail(
        `“${name}” could not be read. It may be damaged or password-protected.`,
        422,
        'unreadable_document'
      );
    }

    prepared.push({
      name,
      kind,
      mime: String(file.type ?? '').slice(0, 200),
      size,
      text,
      truncated,
    });
  }

  // Only now is any state written: a batch where the fourth file fails leaves
  // nothing behind.
  const created = await createAttachments(auth.userId, chatId, prepared);
  return NextResponse.json({ attachments: created.map(toAttachment) });
}

// GET /api/attachments?chatId=…  -> metadata for every file in the chat
// GET /api/attachments?id=…      -> one file, including its extracted text
export async function GET(request: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  const params = request.nextUrl.searchParams;
  const id = params.get('id');

  if (id) {
    const row = await getAttachment(auth.userId, id);
    if (!row) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
    return NextResponse.json({ attachment: { ...toAttachment(row), text: row.text } });
  }

  const chatId = params.get('chatId');
  if (!chatId) return fail('A chatId or id is required.', 400);

  const rows = await listAttachments(auth.userId, chatId);
  return NextResponse.json({ attachments: rows.map(toAttachment) });
}

// DELETE /api/attachments  { id }  — remove one file from a chat.
export async function DELETE(request: NextRequest) {
  const auth = await requireSession();
  if (auth instanceof NextResponse) return auth;

  let id = '';
  try {
    const body = await request.json();
    id = String(body?.id ?? '').trim();
  } catch {
    // fall through to the shared validation below
  }
  if (!id) return fail('An attachment id is required.', 400);

  const deleted = await deleteAttachment(auth.userId, id);
  if (!deleted) return NextResponse.json({ error: 'Attachment not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
