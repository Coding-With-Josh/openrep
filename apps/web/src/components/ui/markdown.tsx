"use client";

import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { CodeBlock } from "./code-block";

// renders model output (untrusted content) as markdown. security posture:
// no rehype-raw, so raw html the model emits stays escaped text; the default
// urlTransform only keeps http(s)/irc/mailto/xmpp links and blanks dangerous
// schemes like javascript:; code blocks cannot execute anything client-side.
// remark-breaks keeps llm-style single newlines readable like a chat app.

const components: Components = {
  p: ({ children }) => (
    <p className="my-1.5 first:mt-0 last:mb-0 leading-relaxed">{children}</p>
  ),
  h1: ({ children }) => (
    <h1 className="text-lg font-semibold tracking-tight text-neutral-900 mt-3 first:mt-0 mb-1">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-base font-semibold tracking-tight text-neutral-900 mt-3 first:mt-0 mb-1">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold tracking-tight text-neutral-900 mt-2 first:mt-0 mb-1">
      {children}
    </h3>
  ),
  ul: ({ children }) => (
    <ul className="list-disc pl-5 my-1.5 first:mt-0 last:mb-0 space-y-0.5">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 my-1.5 first:mt-0 last:mb-0 space-y-0.5">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-neutral-900 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-900 transition-colors break-words"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-neutral-900">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-3 border-neutral-200" />,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-neutral-300 pl-3 my-2 first:mt-0 last:mb-0 text-neutral-600 italic">
      {children}
    </blockquote>
  ),
  // block code: the pre wrapper is dropped so fenced blocks render through
  // CodeBlock (tab label, copy button, horizontal scroll on long lines).
  // inline `code` keeps the small monospace chip styling.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const match = /language-(\w+)/.exec(className ?? "");
    // children can be a single text node or an array of them; join without
    // separators so commas never leak into code content.
    const text = (Array.isArray(children) ? children.join("") : String(children)).replace(/\n$/, "");
    const isBlockCode = match !== null || text.includes("\n");
    if (isBlockCode) {
      return <CodeBlock code={text} language={match?.[1] ?? "text"} />;
    }
    return (
      <code className="bg-neutral-200/70 rounded-md px-1.5 py-0.5 font-mono text-[0.82em] break-all">
        {children}
      </code>
    );
  },
  table: ({ children }) => (
    <div className="my-2 first:mt-0 last:mb-0 overflow-x-auto">
      <table className="border-collapse text-[13px] w-full min-w-0">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-neutral-200/50">{children}</thead>,
  th: ({ children }) => (
    <th className="text-left font-semibold text-neutral-900 px-2 py-1.5 border border-neutral-200 whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-2 py-1.5 border border-neutral-200 align-top">{children}</td>
  ),
};

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
      {content}
    </ReactMarkdown>
  );
});