'use client';

import { useEffect, useState } from 'react';
import { ATTACHMENT_KIND_LABELS, type Attachment } from '@/lib/types';
import { formatBytes } from '@/lib/attachments';

// A one-glyph mark per format, so a row of chips is scannable without
// relying on colour. Inline SVGs keep the bundle free of an icon library.
function KindIcon({ kind }: { kind: Attachment['kind'] }) {
  if (kind === 'pdf') {
    return (
      <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M14 3v5h5M9 14h6M9 17h4" />
      </svg>
    );
  }
  if (kind === 'pptx') {
    return (
      <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M3 4h18v11H3zM12 15v3m-4 0h8" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 11l3-3 2 2 2-3 3 4" />
      </svg>
    );
  }
  if (kind === 'docx') {
    return (
      <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 3h7l5 5v13a1 1 0 01-1 1H7a1 1 0 01-1-1V4a1 1 0 011-1z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M14 3v5h5M9 13h6M9 16h6M9 10h2" />
      </svg>
    );
  }
  return (
    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M14 3v5h5M14 3H7a1 1 0 00-1 1v16a1 1 0 001 1h10a1 1 0 001-1V8l-4-5z" />
    </svg>
  );
}

export { KindIcon };

interface AttachmentChipProps {
  attachment: Attachment;
  onRemove?: () => void;
  /** Marks a file that is still uploading — the chip is dimmed and not removable. */
  pending?: boolean;
  /** Shown in the composer, where clicking expands the extracted text inline. */
  expandable?: boolean;
  onToggle?: () => void;
  expanded?: boolean;
}

/**
 * One attached file. Rendered in the composer (removable, expandable) and in a
 * sent user message (read-only) so a chip always means the same thing.
 */
export function AttachmentChip({
  attachment,
  onRemove,
  pending,
  expandable,
  onToggle,
  expanded,
}: AttachmentChipProps) {
  const label = `${attachment.name}, ${ATTACHMENT_KIND_LABELS[attachment.kind]}, ${formatBytes(attachment.size)}`;

  return (
    <div
      className={`group flex items-center gap-2 rounded-xl border px-2.5 py-1.5 text-xs transition-colors ${
        pending
          ? 'border-dashed border-border text-muted-foreground/70'
          : 'border-border bg-muted/60 text-foreground/90 hover:bg-muted'
      }`}
    >
      <KindIcon kind={attachment.kind} />
      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          disabled={pending}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Hide' : 'Show'} the text read from ${label}`}
          className="min-w-0 text-left disabled:cursor-default"
        >
          <span className="block truncate max-w-[9rem] sm:max-w-[13rem] font-medium">
            {attachment.name}
          </span>
          <span className="block text-[10px] text-muted-foreground">
            {pending ? 'Reading…' : `${formatBytes(attachment.size)} · ${attachment.chars.toLocaleString()} chars`}
          </span>
        </button>
      ) : (
        <div className="min-w-0">
          <span className="block truncate max-w-[9rem] sm:max-w-[13rem] font-medium" title={label}>
            {attachment.name}
          </span>
          <span className="block text-[10px] text-muted-foreground">
            {formatBytes(attachment.size)} · {ATTACHMENT_KIND_LABELS[attachment.kind]}
          </span>
        </div>
      )}

      {attachment.truncated && (
        <span
          className="shrink-0 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-600"
          title="Only the beginning of this file fit within the model's context window."
        >
          Partial
        </span>
      )}

      {onRemove && !pending && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="ml-0.5 shrink-0 rounded-md p-0.5 text-muted-foreground opacity-60 transition-opacity hover:bg-background hover:text-foreground hover:opacity-100"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
      {pending && (
        <svg
          className="w-3.5 h-3.5 shrink-0 animate-spin text-muted-foreground/60"
          fill="none"
          viewBox="0 0 24 24"
          aria-hidden
        >
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-80" d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
      )}
    </div>
  );
}

interface AttachmentPreviewProps {
  attachment: Attachment;
  onClose: () => void;
}

/**
 * The text the model actually reads. Shown because extraction is lossy — a
 * scanned PDF or a text-box-heavy slide can come back garbled, and the user is
 * the only one who can tell the model is working from the wrong bytes.
 */
export function AttachmentPreview({ attachment, onClose }: AttachmentPreviewProps) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Keyed by id at the call site, so this only ever loads one attachment and a
  // remount (rather than a setState-in-effect) handles switching between them.
  // Lazy because transcripts are tens of kilobytes each and most are never
  // opened.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/attachments?id=${encodeURIComponent(attachment.id)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error('Could not load the extracted text.');
        return res.json();
      })
      .then((data: { attachment?: { text?: string } }) => {
        if (!cancelled) setText(String(data.attachment?.text ?? ''));
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Could not load the extracted text.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id]);

  return (
    <div className="rounded-xl border border-border bg-muted/40 p-3 animate-message-in">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="truncate text-xs font-semibold" title={attachment.name}>
          <KindIcon kind={attachment.kind} />
          <span className="ml-1.5">{attachment.name}</span>
        </p>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="shrink-0 rounded-md p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : text === null ? (
        <p className="text-xs text-muted-foreground" role="status">
          Loading the extracted text…
        </p>
      ) : (
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/60 p-2.5 font-mono text-[11px] leading-relaxed text-foreground/85">
          {text}
        </pre>
      )}
    </div>
  );
}
