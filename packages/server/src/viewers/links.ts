import type { ThemePref } from "../ui/theme";

/**
 * Links between the pages Kofra draws on a site origin (listings, file viewers, system pages).
 *
 * A page drawn in an explicit colour mode (`?theme=`, from the app's file viewer) or inside the app's file
 * viewer frame (`&embed=1`, no bar, header or footer of its own) must not lose that when someone follows
 * one of its links: the next page would paint in the other mode, or draw a second wordmark, bar and footer
 * inside the app's frame. The link cannot simply add the parameters, because the target may be the site's
 * own HTML, which must never see them. So it goes through `<base>__dropway/open?next=<path>`, which passes
 * the mode and the embed on only when the target is also a page Kofra draws (serve.ts openInFrame).
 */
export const OPEN_PATH = "__dropway/open";

export interface LinkCarry {
  theme: ThemePref;
  embed: boolean;
}

/** Whether a link from this page needs to carry anything (an explicit mode or the embed). */
export const carries = (c: LinkCarry) => c.theme !== "auto" || c.embed;

/** `path` (a path on this site, query allowed) as a link from a Kofra page that carries `c`. */
export function carryLink(siteBase: string, path: string, c: LinkCarry): string {
  if (!carries(c)) return path;
  return `${siteBase}${OPEN_PATH}?next=${encodeURIComponent(path)}${c.embed ? "&embed=1" : ""}${c.theme === "auto" ? "" : `&theme=${c.theme}`}`;
}

/**
 * Relative links inside a rendered document (Markdown, notebook) that point at other files of the same site
 * go through carryLink, keeping their #fragment. Links with a scheme, protocol-relative links, same-page
 * fragments and links that leave the site are left alone. `pagePath` is the path of the page the document is shown on.
 */
export async function carryDocLinks(html: string, pagePath: string, siteBase: string, c: LinkCarry): Promise<string> {
  if (!carries(c)) return html;
  const base = new URL(pagePath, "https://site.invalid");
  return new HTMLRewriter()
    .on("a[href]", {
      element(el) {
        const href = (el.getAttribute("href") ?? "").trim();
        if (!href || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
        let u: URL;
        try {
          u = new URL(href, base);
        } catch {
          return;
        }
        if (u.origin !== base.origin || !u.pathname.startsWith(siteBase)) return;
        // The fragment goes on the hop's own URL: browsers keep it across the fragment-less 303 to the target, so
        // b.md#setup still lands on #setup. setAttribute writes the value as given: escape the ampersands.
        el.setAttribute("href", (carryLink(siteBase, u.pathname + u.search, c) + u.hash).replaceAll("&", "&amp;"));
      },
    })
    .transform(new Response(html))
    .text();
}
