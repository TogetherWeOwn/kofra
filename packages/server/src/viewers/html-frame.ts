import { escapeHtml } from "../html";
import { standardTabs, viewerCsp, viewerPage } from "./chrome";
import type { Viewer } from "./index";

/**
 * HTML is the real page: a navigation to page.html serves the page itself.
 * page.html?view=1 serves this "viewer frame" instead: the bar plus the page
 * in an iframe, so a person can flip between the rendered page and its source.
 */
export const htmlFrameViewer: Viewer = {
  id: "html-frame",
  // 3 was issued separately for the shared-link head tags and for the Phone
  // disclosure, so the merged render moves to 4.
  version: 4,
  maxBytes: Number.MAX_SAFE_INTEGER,
  matches: (file, _live, mode) => file.kind === "html" && mode === "view",
  async render(vc) {
    const tabs = standardTabs(vc, { rendered: "Page", source: true });
    tabs[0] = { label: "Page", href: vc.viewUrl, current: true };
    return viewerPage(vc, {
      tabs,
      barExtra: `<a href="${escapeHtml(vc.fileUrl)}" rel="nofollow" title="Open the page without the bar">Open</a>`,
      css: `html,body{height:100%}body{display:flex;flex-direction:column}.dw-frame{flex:1;width:100%;border:0;background:#fff}`,
      body: `<iframe class="dw-frame" src="${escapeHtml(vc.fileUrl)}" title="${escapeHtml(vc.file.path)}"></iframe>`,
      csp: viewerCsp({ frameSrc: [vc.url.origin] }),
    });
  },
};
