"use client";

import { memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import { CodeBlock } from "./code-block";

// renders model output (untrusted content) as markdown. security posture:
// no rehype-raw, so raw html the model emits stays escaped text; the default
// urlTransform only keeps http(s)/irc/mailto/xmpp links and blanks dangerous
// schemes like javascript:; code blocks cannot execute anything client-side.
// remark-breaks keeps llm-style single newlines readable like a chat app.
// math (remark-math + rehype-katex) renders equations with katex, which is
// run with trust disabled and throwOnError off so malformed llm math renders
// visibly instead of crashing the message or executing anything.

// llm output frequently wraps math in laTeX bracket delimiters (\(...\)
// inline, \[...\] display) but remark-math v6 only parses dollar delimiters,
// so bracket math is normalized to dollars before parsing. fenced and
// inline code are left untouched: math delimiters inside code are literal.
const CODE_SPANS = /(?:^ {0,3}`{3,}[^\n]*\n[\s\S]*?^ {0,3}`{3,})|(?:`[^`\n]*`)/gm;

function convertMathDelimiters(segment: string): string {
  return segment
    .replace(/\\\[([\s\S]*?)\\\]/g, (_all, body: string) => `$$\n${body}\n$$`)
    .replace(/\\\(([^\n]*?)\\\)/g, (_all, body: string) => `$${body}$`);
}

function normalizeMathDelimiters(input: string): string {
  const out: string[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  CODE_SPANS.lastIndex = 0;
  while ((match = CODE_SPANS.exec(input)) !== null) {
    out.push(convertMathDelimiters(input.slice(last, match.index)));
    out.push(match[0]);
    last = CODE_SPANS.lastIndex;
  }
  out.push(convertMathDelimiters(input.slice(last)));
  return out.join("");
}

const KATEX_OPTIONS = {
  // llm math is frequently malformed: a broken equation must paint as an
  // error, not throw and blank the whole transcript; strict off tolerates
  // minor laTeX slipups; trust stays off so dangerous katex commands never
  // execute (untrusted model output).
  throwOnError: false,
  strict: false,
  trust: false,
};

const mathPlugins = [remarkMath, remarkGfm, remarkBreaks];
const katexPlugins = [[rehypeKatex, KATEX_OPTIONS]] as [
  [typeof rehypeKatex, typeof KATEX_OPTIONS],
];

const components: Components = {
  p: ({ children }) => (
    <p className="my-1.5 first:mt-0 last:mb-0 leading-relaxed">{children}</p>
  ),
  h1: ({ children }) => (
    <h1 className="text-lg font-semibold tracking-tight text-neutral-900 mt-6 first:mt-0 mb-2 dark:text-neutral-50">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-base font-semibold tracking-tight text-neutral-900 mt-6 first:mt-0 mb-2 dark:text-neutral-50">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold tracking-tight text-neutral-900 mt-5 first:mt-0 mb-1.5 dark:text-neutral-50">
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
      className="text-neutral-900 underline decoration-neutral-300 underline-offset-2 hover:decoration-neutral-900 transition-colors break-words dark:text-neutral-100 dark:decoration-neutral-600 dark:hover:decoration-neutral-100"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-neutral-900 dark:text-neutral-50">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  hr: () => <hr className="my-5 border-neutral-200 dark:border-neutral-800" />,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-neutral-300 pl-3 my-2 first:mt-0 last:mb-0 text-neutral-600 italic dark:border-neutral-600 dark:text-neutral-400">
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
      <code className="bg-neutral-200/70 rounded-md px-1.5 py-0.5 font-mono text-[0.82em] break-all dark:bg-white/10">
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
  thead: ({ children }) => <thead className="bg-neutral-200/50 dark:bg-white/10">{children}</thead>,
  th: ({ children }) => (
    <th className="text-left font-semibold text-neutral-900 px-2 py-1.5 border border-neutral-200 whitespace-nowrap dark:text-neutral-50 dark:border-neutral-700">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-2 py-1.5 border border-neutral-200 align-top dark:border-neutral-700">{children}</td>
  ),
};

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={mathPlugins}
      rehypePlugins={katexPlugins}
      components={components}
    >
      {normalizeMathDelimiters(content)}
    </ReactMarkdown>
  );
});

// flat text variant: renders the same untrusted model output as normal
// text with no styling, so a ledger view reads like prose instead of
// showing raw markdown syntax. every node collapses to plain text: no
// headings, no bullet markers, no code chips, no clickable links. html
// from the model stays escaped (no rehype-raw) and link schemes never
// apply because links are dropped entirely.
const Text = ({ children }: { children?: ReactNode }) => <>{children}</>;

const PLAIN_COMPONENTS: Components = {
  h1: Text,
  h2: Text,
  h3: Text,
  h4: Text,
  h5: Text,
  h6: Text,
  p: ({ children }) => <p className="first:mt-0 last:mb-0">{children}</p>,
  ul: Text,
  ol: Text,
  li: Text,
  a: Text,
  strong: Text,
  em: Text,
  del: Text,
  hr: () => null,
  blockquote: Text,
  pre: ({ children }) => <div className="whitespace-pre-wrap">{children}</div>,
  code: Text,
  table: Text,
  thead: Text,
  tbody: Text,
  tr: Text,
  th: Text,
  td: Text,
  img: () => null,
};

export const MarkdownPlain = ({ content }: { content: string }) => (
  <ReactMarkdown
    remarkPlugins={mathPlugins}
    rehypePlugins={katexPlugins}
    components={PLAIN_COMPONENTS}
  >
    {normalizeMathDelimiters(content)}
  </ReactMarkdown>
);