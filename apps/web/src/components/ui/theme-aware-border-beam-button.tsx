"use client";

/**
 * `BorderBeamButton` with the beam theme resolved from the active site theme.
 *
 * The leaderboard is a server component, so it cannot call `useTheme`
 * directly; this client wrapper keeps the beam dynamic (light/dark) exactly
 * like the client pages (`agents`, `agents/[id]`), instead of pinning
 * `theme="auto"` on a static server render.
 *
 * `theme` is intentionally forced by this component (callers cannot pin it),
 * and `ref` is dropped: the score chip this powers is presentational.
 */
import { useTheme } from "next-themes";
import {
  BorderBeamButton,
  type BorderBeamButtonProps,
} from "@/components/effects/border-beam";

type Props = Omit<BorderBeamButtonProps, "theme" | "ref">;

export function ThemeAwareBorderBeamButton(props: Props) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  return <BorderBeamButton theme={theme} {...props} />;
}