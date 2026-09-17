export interface Source {
  title: string;
  url: string;
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