import 'server-only';
import type JSZipType from 'jszip';
import { ACCEPTED_EXTENSIONS, kindOf } from './attachments';
import type { AttachmentKind } from './types';

// Server-side text extraction for the document types the chat accepts.
//
// PDFs go through `unpdf`; Word and PowerPoint files are ZIP containers of
// OOXML parts, so those are unzipped and the text runs are read straight out
// of the XML. Both parsers are imported lazily — they are only paid for when a
// user actually attaches a file, and they keep the default chat path free of
// the PDF.js worker machinery.

// Hard cap on the body we persist for one file. A 200-page report is far more
// than a 4k-context local model can use, so storing the whole thing would just
// bloat the database and every subsequent prompt that reads it back.
export const MAX_CHARS_PER_FILE = Math.max(
  1_000,
  Number(process.env.ATTACHMENT_MAX_CHARS) || 40_000
);

// Raised when a file is structurally readable but carries no extractable text
// (a scanned PDF, or a deck of images). Surfaced to the user instead of being
// silently treated as an empty document.
export class EmptyDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyDocumentError';
  }
}

export class UnsupportedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedFileError';
  }
}

// Extensions we accept, mapped to how we parse them. Legacy binary Word and
// PowerPoint files (`.doc` / `.ppt`) are deliberately absent: they predate
// OOXML and are not ZIP containers, so we cannot read them. They are still
// recognised below, purely to give a useful message instead of a generic
// "unsupported file".
const EXTENSION_KINDS: Record<string, AttachmentKind> = {
  pdf: 'pdf',
  docx: 'docx',
  docm: 'docx',
  dotx: 'docx',
  dotm: 'docx',
  pptx: 'pptx',
  pptm: 'pptx',
  potx: 'pptx',
  potm: 'pptx',
  ppsx: 'pptx',
  ppsm: 'pptx',
};

const LEGACY_EXTENSIONS: Record<string, string> = {
  doc: 'the old binary .doc format',
  ppt: 'the old binary .ppt format',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Decide how to parse an upload. The extension is the primary signal because
 * browsers report wildly inconsistent MIME types for Office files (and empty
 * for some downloads). Returns null when the file is not an accepted family.
 */
export function detectKind(
  name: string,
  mime: string | undefined
): AttachmentKind | null {
  const ext = extensionOf(name);
  if (EXTENSION_KINDS[ext]) return EXTENSION_KINDS[ext];
  if (LEGACY_EXTENSIONS[ext]) {
    throw new UnsupportedFileError(
      `“${name}” uses ${LEGACY_EXTENSIONS[ext]}, which this app can't read. ` +
        `Re-save it as ${ext === 'doc' ? '.docx' : '.pptx'} and try again.`
    );
  }
  // Keep the shared list honest: every extension the picker offers must map to
  // a parser, otherwise users get a file they can select but never upload.
  if ((ACCEPTED_EXTENSIONS as readonly string[]).includes(ext)) return null;
  return kindOf(name, mime);
}

// ---------- Text cleanup ----------

// Decode the five XML entities that appear in OOXML text runs. Anything else
// (`&#x2014;` numeric refs and friends) is left alone — the tags are stripped
// but the inner text is kept, so a stray `&` degrades gracefully.
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Strip tags, keeping the text nodes. Used after the structural markers below
// have already been turned into newlines.
function stripTags(xml: string): string {
  return decodeXmlEntities(xml.replace(/<[^>]*>/g, ''));
}

// OOXML is often pretty-printed, which would otherwise leave a line of leading
// spaces in front of every paragraph. Only whitespace spans that cross a line
// break are removed, so deliberate single spaces inside a text run
// (`<w:t xml:space="preserve"> </w:t>`) and real tab indentation survive.
function deindentXml(xml: string): string {
  return xml.replace(/>[^\S\n]*\n\s*</g, '><');
}

// Collapse the layout whitespace that OOXML carries without destroying the
// structure a reader cares about. Tabs at the start of a line are indentation
// (code samples, nested list levels) and are preserved; runs of spaces are XML
// formatting noise and are squeezed down. Blank lines survive as paragraph
// breaks, capped at one so runs of empty elements do not pad the prompt.
function normalizeText(value: string): string {
  const lines = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const leading = /^[ \t\u00a0]*/.exec(line)![0];
      const indent = leading.replace(/\t/g, '    ');
      const body = line.slice(leading.length).replace(/[ \t\u00a0]+/g, ' ').trimEnd();
      const out = indent + body;
      // A line of pure whitespace is formatting, not content.
      return out.trim() ? out : '';
    });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function capText(value: string, maxChars: number): { text: string; truncated: boolean } {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  // Cut on a line boundary where possible so we never end mid-word looking
  // like a parsing bug rather than an intentional cut.
  const window = trimmed.slice(0, maxChars);
  const lastBreak = window.lastIndexOf('\n');
  const cut = lastBreak > maxChars * 0.6 ? window.slice(0, lastBreak) : window;
  return { text: `${cut}\n\n[… truncated — the rest of this file was not included]`, truncated: true };
}

// ---------- PDF ----------

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { extractText } = await import('unpdf');
  // unpdf drives PDF.js in a Web Worker and transfers the buffer to it, which
  // detaches the caller's ArrayBuffer — `bytes.byteLength` reads 0 afterwards.
  // Hand it a copy so this function does not quietly destroy its argument; the
  // cost is one buffer for a file that is already capped at a few MB.
  // `mergePages: true` returns one string instead of a per-page array, which is
  // what we want for a linear prompt.
  const result = await extractText(new Uint8Array(bytes), { mergePages: true });
  // The overload types this as a plain string; the array branch is kept as a
  // runtime guard because the response shape is owned by PDF.js.
  const text = result.text as string | string[];
  return typeof text === 'string' ? text : text.join('\n\n');
}

// ---------- OOXML (docx / pptx) ----------

async function unzip(bytes: Uint8Array): Promise<JSZipType> {
  const { default: JSZip } = await import('jszip');
  try {
    return await JSZip.loadAsync(bytes);
  } catch {
    throw new UnsupportedFileError(
      'That file could not be opened — it looks damaged, or it is not a real ' +
        'Word/PowerPoint document.'
    );
  }
}

// Word stores the body in word/document.xml. Paragraph and line-break elements
// become newlines *before* the tags are stripped, otherwise every paragraph
// would run together into one wall of text.
async function extractDocx(zip: JSZipType): Promise<string> {
  const part = zip.file('word/document.xml');
  if (!part) {
    throw new UnsupportedFileError(
      'That document has no readable text body (it may be a template or a macro-enabled file).'
    );
  }
  const xml = deindentXml(await part.async('string'));
  const marked = xml
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:tab\b[^>]*\/?>/g, '\t');
  return stripTags(marked);
}

// PowerPoint is one XML part per slide. They are read in numeric slide order
// (slide2 comes before slide10) and each slide is labelled so the model can
// cite "slide 4" and the user can follow along in the deck.
async function extractPptx(zip: JSZipType): Promise<string> {
  const slides = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/.test(path))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  if (slides.length === 0) {
    throw new UnsupportedFileError(
      'That presentation has no slides, or it is a macro-enabled file this app cannot read.'
    );
  }

  const parts: string[] = [];
  for (const path of slides) {
    const xml = deindentXml(await zip.file(path)!.async('string'));
    // Slide text lives in <a:p> paragraphs containing <a:t> runs. Mark the
    // paragraph ends, then also emit bullets for paragraphs that declare a
    // bullet layout so lists stay lists in the prompt.
    const marked = xml.replace(/<\/a:p>/g, '\n');
    const text = normalizeText(stripTags(marked));
    if (text) parts.push(`## Slide ${slideNumber(path)}\n\n${text}`);
  }
  return parts.join('\n\n');
}

function slideNumber(path: string): number {
  const match = /slide(\d+)\.xml$/.exec(path);
  return match ? Number(match[1]) : 0;
}

// ---------- Entry point ----------

export interface ExtractionResult {
  text: string;
  truncated: boolean;
}

/**
 * Extract the readable text of an uploaded document.
 *
 * `kind` must come from `detectKind`. Throws `UnsupportedFileError` when the
 * format is not readable and `EmptyDocumentError` when it is readable but
 * yields no text (scanned PDFs, image-only slides) — the caller turns both
 * into a user-facing message.
 */
export async function extractDocumentText(
  kind: AttachmentKind,
  bytes: Uint8Array
): Promise<ExtractionResult> {
  let raw: string;
  if (kind === 'pdf') {
    raw = await extractPdf(bytes);
  } else {
    const zip = await unzip(bytes);
    raw = kind === 'docx' ? await extractDocx(zip) : await extractPptx(zip);
  }

  const normalized = normalizeText(raw);
  if (!normalized) {
    throw new EmptyDocumentError(
      kind === 'pdf'
        ? 'No text could be read from that PDF — it is probably a scan or an image. ' +
            'Run it through OCR first, then attach it again.'
        : 'No text could be read from that file — it may be made entirely of images.'
    );
  }

  return capText(normalized, MAX_CHARS_PER_FILE);
}
