'use client';

import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Links from model output should never navigate the app away; open them in a
// new tab. Raw HTML is intentionally not rendered (react-markdown escapes it).
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

// Tailwind can't reach elements generated inside the markdown tree, so the
// styles are applied with arbitrary descendant variants on the wrapper.
const WRAPPER_CLASS = [
  'break-words text-[15px] leading-relaxed sm:text-base',
  '[&_p]:my-2 [&_p]:whitespace-pre-wrap [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
  '[&_strong]:font-semibold [&_em]:italic [&_del]:line-through',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold',
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold',
  '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold',
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-slate-900 [&_pre]:p-3 [&_pre]:text-[13px] [&_pre]:text-slate-50',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit',
  '[&_code]:rounded [&_code]:bg-black/10 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em]',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:opacity-80',
  '[&_hr]:my-4 [&_hr]:border-border',
  '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm',
  '[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold',
  '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
].join(' ');

// Streaming content renders as plain text: re-parsing the full markdown tree on
// every token was both expensive and janky as the answer grew. Once streaming
// finishes the component switches to the real markdown renderer.
const PLAIN_CLASS =
  'whitespace-pre-wrap break-words text-[15px] sm:text-base leading-relaxed';

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  reveal = false,
}: {
  content: string;
  reveal?: boolean;
}) {
  if (reveal) {
    // Cheap plain-text pass while tokens are landing; a blinking caret marks
    // the live generation. No markdown work is done here at all.
    return (
      <div className={PLAIN_CLASS}>
        {content}
        <span className="inline-block w-[2px] h-[1.1em] align-text-bottom ml-0.5 bg-current opacity-60 animate-pulse" />
      </div>
    );
  }
  return (
    <div className={WRAPPER_CLASS}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
});