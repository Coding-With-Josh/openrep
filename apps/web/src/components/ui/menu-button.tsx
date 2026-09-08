"use client";

import { useEffect, useState, type ComponentType } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Home, Bot, Moon, Shield, FileText, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { MenuToggle } from "@/components/effects/menu-toggle";

const XLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
  </svg>
);

type MenuItem = {
  label: string;
  href: string;
  Icon: ComponentType<{ className?: string }>;
  external?: boolean;
};

const ITEMS: MenuItem[] = [
  { label: "home", href: "/", Icon: Home },
  { label: "your agents", href: "/agents", Icon: Bot },
  { label: "privacy policy", href: "/privacy-policy", Icon: Shield },
  { label: "terms and conditions", href: "/terms-and-conditions", Icon: FileText },
  { label: "check me out", href: "https://x.com/josh_scriptz", Icon: XLogo, external: true },
];

export default function Menu({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const toggleTheme = () => setTheme(isDark ? "light" : "dark");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const itemClass =
    "flex items-center gap-3 px-2 py-1 rounded-xl text-sm font-medium tracking-tight text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900 transition-all duration-200 active:scale-98 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-50";

  return (
    <div className={`group fixed z-2000 bottom-4 right-4 ${className}`}>
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              className="fixed inset-0 z-2000"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              onClick={() => setOpen(false)}
            />
            <motion.nav
              role="menu"
              className="absolute bottom-20 right-0 z-2001 w-48 rounded-2xl bg-white border border-neutral-200 shadow-xl p-1.5 flex flex-col gap-0.5 dark:bg-neutral-900 dark:border-neutral-800"
              initial={{ opacity: 0, scale: 0.95, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 6 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            >
              {ITEMS.map(({ label, href, Icon, external }) => {
                const icon = <Icon className="w-4 h-4 shrink-0" />;
                if (external) {
                  return (
                    <a
                      key={label}
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      role="menuitem"
                      className={itemClass}
                      onClick={() => setOpen(false)}
                    >
                      {icon}
                      {label}
                    </a>
                  );
                }
                return (
                  <Link
                    key={label}
                    href={href}
                    role="menuitem"
                    className={itemClass}
                    onClick={() => setOpen(false)}
                  >
                    {icon}
                    {label}
                  </Link>
                );
              })}
              <div className="border-t border-neutral-100 mx-1 my-1 dark:border-neutral-800" />
              <button
                type="button"
                role="menuitem"
                onClick={toggleTheme}
                className={itemClass}
              >
                {isDark ? (
                  <Sun className="w-4 h-4 shrink-0" />
                ) : (
                  <Moon className="w-4 h-4 shrink-0" />
                )}
                {isDark ? "light mode" : "dark mode"}
              </button>
            </motion.nav>
          </>
        )}
      </AnimatePresence>
      <MenuToggle
        strokeWidth={3}
        open={open}
        onOpenChange={setOpen}
        className="size-10 lg:size-16 text-neutral-400 group-hover:text-black dark:text-neutral-600 dark:group-hover:text-white"
      />
    </div>
  );
}