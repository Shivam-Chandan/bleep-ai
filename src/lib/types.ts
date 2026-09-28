export interface Source {
  title: string;
  url: string;
}

// ---------- Attachments ----------

// The only document families the chat accepts. `text` covers Word/PowerPoint
// files that carry no embedded text (a pure image "slide deck"), so the UI can
// explain what happened instead of silently sending an empty document.
export type AttachmentKind = 'pdf' | 'docx' | 'pptx' | 'text';

export const ATTACHMENT_KIND_LABELS: Record<AttachmentKind, string> = {
  pdf: 'PDF',
  docx: 'Document',
  pptx: 'Slides',
  text: 'File',
};

// Metadata is safe to send to the browser: it never carries the extracted body.
// `chars` is the size of that body, which the composer needs to estimate how
// much of the model's context window the files will eat. `messageId` is null
// while a file is still waiting to be sent, which is how the composer tells
// staged files apart from ones already referenced by a turn.
export interface Attachment {
  id: string;
  chatId: string;
  messageId: string | null;
  name: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  chars: number;
  truncated: boolean;
  createdAt: Date;
}

// An attachment plus its extracted body. Only the single-file preview endpoint
// returns this shape — chat history deliberately carries metadata alone.
export interface AttachmentWithText extends Attachment {
  text: string;
}

// Appended to a partial answer when the user stops generation. Shared by the
// server (persistence) and the client (live display) so both stay consistent.
export const INTERRUPT_SUFFIX = '\n\n[Response stopped by user]';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  sources?: Source[];
  // Files the user attached to this turn. The model is grounded on the same
  // extracted text, so the chips here show exactly what the answer came from.
  attachments?: Attachment[];
}

export interface Chat {
  id: string;
  title: string;
  messages: Message[];
  createdAt: Date;
  updatedAt: Date;
}

export interface OllamaRequest {
  model: string;
  messages: { role: string; content: string }[];
  stream: boolean;
  keep_alive?: number | string;
  options?: {
    temperature?: number;
    top_p?: number;
    num_predict?: number;
  };
}

export interface OllamaResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
}