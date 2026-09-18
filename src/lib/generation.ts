import 'server-only';
import { EventEmitter } from 'node:events';

/**
 * In-memory registry of in-flight model generations plus a per-chat pub/sub
 * bus. This is what lets a generation survive the browser dropping away: the
 * generation keeps running and publishing here, and a reconnected client
 * subscribes via GET /api/chats/:id/events to keep receiving the response.
 *
 * Slots are reference-counted by generation token so a late-finished old
 * generation can never clobber the active slot of a newer one.
 *
 * It is single-instance (works on the self-hosted Node server). On multi-instance
 * serverless deploys a reconnected client may hit a different instance; the
 * events endpoint still replays the persisted snapshot and reports done, so the
 * answer is never lost even then.
 */

export interface GenerationEvent {
  type: 'resume' | 'content' | 'done' | 'interrupted' | 'error';
  active?: boolean;
  messageId?: string;
  content?: string;
  message?: string;
  code?: string;
}

const emitter = new EventEmitter();
const slots = new Map<string, { token: number; abort?: () => void }>();
const stoppedChats = new Set<string>();
let tokenCounter = 0;

// Claim the slot for a new generation. Returns a token-guarded end() that only
// frees the slot if it still belongs to this generation.
export function beginGeneration(chatId: string): () => void {
  const token = ++tokenCounter;
  slots.set(chatId, { token });
  return () => {
    const slot = slots.get(chatId);
    if (slot && slot.token === token) slots.delete(chatId);
  };
}

export function isActive(chatId: string): boolean {
  return slots.has(chatId);
}

export function registerStop(chatId: string, fn: () => void): void {
  const slot = slots.get(chatId);
  if (slot) slot.abort = fn;
}

// Returns true if there was a generation to stop.
export function requestStop(chatId: string): boolean {
  stoppedChats.add(chatId);
  const slot = slots.get(chatId);
  if (slot?.abort) {
    slot.abort();
    return true;
  }
  return false;
}

export function consumeStopped(chatId: string): boolean {
  const stopped = stoppedChats.has(chatId);
  stoppedChats.delete(chatId);
  return stopped;
}

export function subscribe(
  chatId: string,
  handler: (event: GenerationEvent) => void
): () => void {
  emitter.on(chatId, handler);
  return () => {
    emitter.off(chatId, handler);
  };
}

export function publish(chatId: string, event: GenerationEvent): void {
  emitter.emit(chatId, event);
}