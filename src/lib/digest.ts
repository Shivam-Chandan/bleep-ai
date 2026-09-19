import 'server-only';

// The actual prompt-building logic lives in digestCore.mjs (plain JS, no
// `server-only`, no Next imports) so it can be shared byte-for-byte with the
// box-side worker (scripts/digest-worker.mjs) that generates summaries — see
// that file for why generation no longer happens inside this Next app.
export { localDay, buildDigestPrompt } from './digestCore.mjs';
