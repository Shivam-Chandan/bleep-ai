'use client';

import { useCallback, useRef, useState } from 'react';
import { useChatStore } from '@/lib/store';
import {
  ACCEPT_ATTR,
  fileToBase64,
  MAX_FILES_PER_CHAT,
  validateFile,
} from '@/lib/attachments';
import type { Attachment } from '@/lib/types';
import { AttachmentChip, AttachmentPreview } from './AttachmentChip';

type WireAttachment = Omit<Attachment, 'createdAt'> & { createdAt: string };

// A file still in flight. Rendered as a chip so the user sees the upload start
// immediately, before the multi-megabyte round trip finishes.
interface PendingUpload {
  key: string;
  name: string;
  size: number;
}

/**
 * Upload state for one chat's composer: the files waiting to be sent, the ones
 * still uploading, and any per-file failures. Files already referenced by a
 * sent message are excluded — those live on their bubble in the thread.
 */
export function useAttachmentUploads(chatId: string) {
  const attachments = useChatStore((s) => s.chatAttachments[chatId]);
  const addAttachment = useChatStore((s) => s.addAttachment);
  const removeAttachment = useChatStore((s) => s.removeAttachment);

  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const staged = (attachments ?? []).filter((a) => !a.messageId);
  const expanded = staged.find((a) => a.id === expandedId) ?? null;
  const occupied = staged.length + pending.length;
  const atLimit = occupied >= MAX_FILES_PER_CHAT;

  const upload = useCallback(
    async (file: File) => {
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      setPending((p) => [...p, { key, name: file.name, size: file.size }]);
      try {
        const data = await fileToBase64(file);
        const res = await fetch('/api/attachments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chatId,
            files: [{ name: file.name, type: file.type, data }],
          }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => null);
          throw new Error(payload?.error || `Upload failed (${res.status}).`);
        }
        const payload: { attachments: WireAttachment[] } = await res.json();
        for (const raw of payload.attachments ?? []) {
          addAttachment(chatId, { ...raw, createdAt: new Date(raw.createdAt) });
        }
      } catch (e) {
        setErrors((prev) => [
          ...prev,
          e instanceof Error ? e.message : `Could not attach ${file.name}.`,
        ]);
      } finally {
        setPending((p) => p.filter((item) => item.key !== key));
      }
    },
    [addAttachment, chatId]
  );

  const addFiles = useCallback(
    async (files: FileList | File[] | null) => {
      if (!files || files.length === 0) return;
      const problems: string[] = [];
      const accepted: File[] = [];

      for (const file of Array.from(files)) {
        // Count what is already staged plus what this same selection adds, so a
        // multi-select cannot slip past the cap one file at a time.
        const problem = validateFile(file, occupied + accepted.length);
        if (problem) problems.push(problem);
        else accepted.push(file);
      }

      if (problems.length > 0) setErrors(problems);
      // Sequential rather than parallel: each file is parsed on the server and
      // five concurrent multi-megabyte uploads just queue behind each other.
      for (const file of accepted) await upload(file);
    },
    [occupied, upload]
  );

  const remove = useCallback(
    async (attachment: Attachment) => {
      removeAttachment(chatId, attachment.id);
      if (expandedId === attachment.id) setExpandedId(null);
      // Drop the local chip first so the UI feels instant, then reconcile: if
      // the server refuses, re-reading the list puts the file back rather than
      // silently losing it.
      try {
        const res = await fetch('/api/attachments', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: attachment.id }),
        });
        if (!res.ok) throw new Error('delete failed');
      } catch {
        setErrors(['That file could not be removed. Try again.']);
        useChatStore.getState().loadAttachments(chatId);
      }
    },
    [chatId, expandedId, removeAttachment]
  );

  const toggleExpanded = useCallback(
    (id: string) => setExpandedId((cur) => (cur === id ? null : id)),
    []
  );

  return {
    staged,
    pending,
    errors,
    expanded,
    expandedId,
    atLimit,
    occupied,
    dragging,
    setDragging,
    setErrors,
    addFiles,
    remove,
    toggleExpanded,
  };
}

/** Chips for the files waiting to be sent, plus an expandable text preview. */
export function AttachmentChips({
  uploads,
}: {
  uploads: ReturnType<typeof useAttachmentUploads>;
}) {
  const { staged, pending, expanded, expandedId, errors, setErrors, remove, toggleExpanded } = uploads;
  const hasChips = staged.length > 0 || pending.length > 0;
  if (!hasChips && errors.length === 0) return null;

  return (
    <div className="mb-2 space-y-2 animate-message-in">
      {hasChips && (
        <div className="flex flex-wrap gap-1.5">
          {staged.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              attachment={attachment}
              expandable
              expanded={expandedId === attachment.id}
              onToggle={() => toggleExpanded(attachment.id)}
              onRemove={() => void remove(attachment)}
            />
          ))}
          {pending.map((item) => (
            <AttachmentChip
              key={item.key}
              pending
              attachment={{
                id: item.key,
                chatId: '',
                messageId: null,
                name: item.name,
                kind: 'text',
                mime: '',
                size: item.size,
                chars: 0,
                truncated: false,
                createdAt: new Date(),
              }}
            />
          ))}
        </div>
      )}

      {expanded && (
        <AttachmentPreview
          key={expanded.id}
          attachment={expanded}
          onClose={() => toggleExpanded(expanded.id)}
        />
      )}

      {errors.length > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2"
        >
          <div className="flex-1 min-w-0 space-y-0.5 text-xs text-foreground/90">
            {errors.map((message) => (
              <p key={message}>{message}</p>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setErrors([])}
            aria-label="Dismiss attachment errors"
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The paperclip. Renders its own hidden file input so the trigger stays a
 * plain button (no label/for, no ref threading from the composer) and also
 * acts as a drop target for files dragged onto it.
 */
export function AttachButton({
  uploads,
  disabled,
}: {
  uploads: ReturnType<typeof useAttachmentUploads>;
  disabled?: boolean;
}) {
  const { addFiles, atLimit, dragging, setDragging } = uploads;
  const inputRef = useRef<HTMLInputElement>(null);
  const inert = disabled || atLimit;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        className="sr-only"
        onChange={(e) => {
          void addFiles(e.target.files);
          // Reset so picking the same file twice still fires a change event.
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={inert}
        onDragOver={(e) => {
          e.preventDefault();
          if (!inert) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!inert) void addFiles(e.dataTransfer.files);
        }}
        title={
          atLimit
            ? `${MAX_FILES_PER_CHAT} files is the limit for one chat — remove one to add another`
            : disabled
              ? 'Wait for the current answer to finish'
              : 'Attach a PDF, Word document or PowerPoint deck'
        }
        aria-label="Attach a document"
        className={`flex-shrink-0 h-12 w-12 items-center justify-center rounded-2xl border transition-colors ${
          dragging
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
        } disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.8}
            d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"
          />
        </svg>
      </button>
    </>
  );
}
