import type { AttachmentKind } from './types';

// Client-safe attachment configuration. Imported by both the browser (to build
// the file picker's `accept` filter and to pre-flight uploads) and the API
// route (to enforce the same numbers server-side). It must stay free of
// `server-only` imports and of anything that pulls in a parser.

// MIME types the browser may report for the accepted formats. Browsers are
// unreliable here (some report `application/octet-stream` for .doc, some send
// nothing at all), so the extension is the primary signal and this list is
// only a secondary fallback in `kindOf`.
export const ACCEPTED_MIME_TYPES = [
  'application/pdf',
  'application/x-pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-word.document.macroEnabled.12',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.openxmlformats-officedocument.presentationml.template',
  'application/ms-powerpoint',
];

// Extensions accepted by the server. Kept here so the picker's filter and the
// server's validation cannot drift apart; `extract.ts` keys off the same list.
export const ACCEPTED_EXTENSIONS = [
  'pdf',
  'doc',
  'docx',
  'docm',
  'dotx',
  'dotm',
  'ppt',
  'pptx',
  'pptm',
  'potx',
  'potm',
  'ppsx',
  'ppsm',
] as const;

export const ACCEPT_ATTR = [
  ...ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`),
  ...ACCEPTED_MIME_TYPES,
].join(',');

// Per-file ceiling on the decoded bytes.
//
// Base64 inflates payloads by ~33%, and serverless request bodies are capped at
// 4.5 MB, so 3 MB is the largest a single upload can be while still working on
// Vercel. A self-hosted deployment can raise this via ATTACHMENT_MAX_FILE_BYTES
// — nothing else changes.
export const MAX_FILE_BYTES = Math.max(
  1,
  Number(process.env.NEXT_PUBLIC_ATTACHMENT_MAX_FILE_BYTES) ||
    Number(process.env.ATTACHMENT_MAX_FILE_BYTES) ||
    3 * 1024 * 1024
);

// Total decoded bytes accepted in one upload request. The client sends one
// file per request, so this normally mirrors MAX_FILE_BYTES; it exists to stop
// a hand-crafted multi-file request from blowing past the body limit.
export const MAX_REQUEST_BYTES = Math.max(
  1,
  Number(process.env.ATTACHMENT_MAX_REQUEST_BYTES) || MAX_FILE_BYTES
);

// How many files one chat may accumulate. Small models have short context
// windows, so a handful of files is the useful ceiling anyway.
export const MAX_FILES_PER_CHAT = Math.max(
  1,
  Number(process.env.ATTACHMENT_MAX_FILES) || 5
);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Extensions we can actually parse — used for the picker's primary filter. */
export const PARSEABLE_EXTENSIONS: ReadonlySet<string> = new Set(
  ACCEPTED_EXTENSIONS.filter((ext) => ext !== 'doc' && ext !== 'ppt')
);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Reject an unsupported file before any bytes are read or uploaded, so the user
 * gets the answer instantly instead of after a multi-megabyte round trip.
 */
export function validateFile(
  file: { name: string; size: number },
  existingCount: number
): string | null {
  const ext = extensionOf(file.name);
  if (!ext) return `${file.name} has no file extension, so its type cannot be identified.`;
  if (!ACCEPTED_EXTENSIONS.includes(ext as (typeof ACCEPTED_EXTENSIONS)[number])) {
    return `${file.name} is not supported. Attach a PDF, Word document or PowerPoint deck.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_FILE_BYTES) {
    return `${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_FILE_BYTES)}.`;
  }
  if (existingCount >= MAX_FILES_PER_CHAT) {
    return `This chat already has ${MAX_FILES_PER_CHAT} files attached (the limit). Remove one first.`;
  }
  return null;
}

/**
 * Convert a File to base64. Strips any `data:` URL prefix the browser added so
 * the server receives bare base64.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

/** Decode a base64 upload into bytes, rejecting malformed input. */
export function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!clean) return new Uint8Array(0);
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

/**
 * Map an attachment to the kind the model prompt labels it with. Exported so
 * the UI can group chips without duplicating the mapping.
 */
export function kindOf(name: string, mime: string | undefined): AttachmentKind | null {
  const ext = extensionOf(name);
  if (ext === 'pdf') return 'pdf';
  if (ext.startsWith('doc') || ext.startsWith('dot')) return 'docx';
  if (ext.startsWith('ppt') || ext.startsWith('pot') || ext.startsWith('pps')) return 'pptx';
  const normalized = String(mime || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'application/pdf') return 'pdf';
  if (normalized.includes('wordprocessingml')) return 'docx';
  if (normalized.includes('presentationml')) return 'pptx';
  return null;
}
