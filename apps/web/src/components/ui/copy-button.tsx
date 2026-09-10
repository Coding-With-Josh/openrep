"use client";

import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

function CopyButton({
  value,
  label,
  children,
  className,
}: {
  value: string;
  label?: string;
  children?: ReactNode;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      onClick={handleCopy}
      aria-label={label ?? `Copy ${value}`}
      className={cn(
        "group flex items-center gap-1 rounded-full py-0.5 text-neutral-400 hover:text-neutral-600 transition-all duration-200 hover:scale-102 active:scale-98 dark:hover:text-neutral-200",
        className,
      )}
    >
      {children}
      {copied ? (
        <Check className="size-2.5 text-emerald-600" strokeWidth={2.5} />
      ) : (
        <Copy
          className="size-2.5 opacity-70 group-hover:opacity-100"
          strokeWidth={2.5}
        />
      )}
    </button>
  );
}

export { CopyButton };
