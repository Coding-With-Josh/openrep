// markdown -> ansi rendering for assistant chat replies. marked parses,
// marked-terminal renders into ansi-styled terminal output: bold actually
// bold, headers distinct, code blocks visually set apart, lists indented.
//
// wiring: marked-terminal@7 exports a legacy default Renderer class whose
// methods take string args, and a modern `markedTerminal()` factory that
// returns a marked extension object (`useNewRenderer: true`) which bridges
// the token-object renderer API marked@13+ uses. wired via the factory:
//   - proves out at runtime on marked@^15 (the pin here; validated in
//     /tmp smoke tests — the legacy class path crashes on marked 13-15
//     inside Renderer.heading, the factory path renders correctly)
//   - the factory forwards per-call `r.options`/`r.parser` from marked's
//     own renderer instance, avoiding the class path's `this.options`
//     undefined crash on link/image rendering
// the marked-terminal peer range (`marked >=1 <16`) is therefore correct
// ONLY via the factory; the default-export class path is broken above
// marked@12. that is why the factory handshake is load-bearing here.

import { marked, type MarkedExtension } from "marked";
import { markedTerminal } from "marked-terminal";

let registered = false;

function ensureRendererRegistered(): void {
  if (registered) return;
  // showSectionPrefix: false drops the "# " heading markers marked-terminal
  // adds by default (chat replies read better as plain terminal headings);
  // the type cast bridges marked-terminal's older extension typedef to
  // marked 15's MarkedExtension.
  marked.use(markedTerminal({ showSectionPrefix: false }) as unknown as MarkedExtension);
  registered = true;
}

// parse + render one assistant reply into an ansi string suitable for a
// <Text> node. ink v7 tokenizes ansi escapes itself, so styled strings
// render correctly inside its layout (verified for multi-line content and
// code blocks in the render tests and a manual tty smoke).
export function renderMarkdownToAnsi(markdown: string): string {
  ensureRendererRegistered();
  const rendered = marked.parse(markdown, { async: false });
  return typeof rendered === "string" ? rendered : markdown;
}