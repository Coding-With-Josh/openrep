import Link from "next/link";

export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white text-black min-h-screen flex items-start justify-center px-6 py-14 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="w-full max-w-2xl flex flex-col gap-2">
        <Link
          href="/"
          className="w-fit text-sm text-neutral-500 hover:text-neutral-700 transition-colors dark:text-neutral-400 dark:hover:text-neutral-200"
        >
          openrep
        </Link>
        <h1 className="text-3xl font-medium tracking-tight text-neutral-900 dark:text-neutral-50">
          {title}
        </h1>
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          last updated {updated}
        </p>
        <div className="mt-4 flex flex-col gap-8">{children}</div>
      </div>
    </div>
  );
}