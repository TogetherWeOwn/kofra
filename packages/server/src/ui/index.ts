import type { Hono } from "hono";
import type { DropwayEnv } from "../env";
import type { UiSlots } from "../extensions";
import { clientScriptResponse } from "./assets";
import { artResponse, designCssResponse, fontResponse } from "./design-routes";
import { THEME_PATH, themeRoute } from "./theme";
import { keysPage, loginPage, publishPage, settingsPage, sitePage, sitesPage, viewerPage } from "./pages";

/**
 * App-origin UI routes: sign-in, dashboard, file viewer and the dashboard
 * script. Registered after uiSlots.pages, so an embedding app can replace any
 * of these paths with its own page. The home page (GET /) is wired in app.ts
 * (uiSlots.landing replaces it).
 */
export function installUi(app: Hono<DropwayEnv>, slots: UiSlots) {
  app.get("/__dropway/ui/:file", (c) => clientScriptResponse(c.req.param("file")) ?? designCssResponse(c.req.param("file")) ?? c.notFound());
  app.get("/__dropway/ui/art/:file", (c) => artResponse(c.req.param("file")) ?? c.notFound());
  app.get("/__dropway/fonts/:file", (c) => fontResponse(c.req.param("file")) ?? c.notFound());
  app.post(THEME_PATH, (c) => themeRoute(c));
  app.get("/login", (c) => loginPage(c));
  // The sign-in forms post here only if the dashboard script has not loaded yet: never echo or
  // store what was sent (it may be a key), just send the person back. Secrets never land in a URL.
  app.post("/login", (c) => c.redirect("/login?retry=1", 303));
  app.get("/dashboard", (c) => sitesPage(c));
  app.get("/dashboard/", (c) => c.redirect("/dashboard", 301));
  app.get("/dashboard/sites/:slug", (c) => sitePage(c));
  app.get("/dashboard/publish", (c) => publishPage(c));
  app.get("/dashboard/keys", (c) => keysPage(c));
  app.get("/dashboard/settings", (c) => settingsPage(c, slots));
  app.get("/v/:slug", (c) => c.redirect(`/v/${encodeURIComponent(c.req.param("slug"))}/`, 301));
  app.get("/v/:slug/*", (c) => viewerPage(c));
  // SPEC 8.3 names the viewer /view/{site}/{path}; keep that address working.
  app.get("/view/:slug/*", (c) => {
    const u = new URL(c.req.url);
    return c.redirect(u.pathname.replace(/^\/view\//, "/v/") + u.search, 301);
  });
}

export { homePage } from "./pages";
export { renderAppPage, bindUiSlots, appScriptCsp, CORE_NAV, CORE_FOOTER_LINKS, SOURCE_REPO, APP_CSS, type AppPageOptions } from "./shell";
export { renderDocument, appStylesheetUrl, fontFaceCss, type DocumentOptions } from "./document";
export { accountArea, appChrome, appHeader, appFooter, identityTag, modeSwitch, siteHeader, siteFooter, GUILLOCHE_BAND, SKIP_LINK, TRUST_LINE, type AccountAreaOptions, type AppChromeOptions, type AppHeaderOptions, type AppFooterOptions, type ChromeNavItem } from "./chrome";
export { THEME_COOKIE, THEME_PATH, bindRequestTheme, themeOf, requestTheme, themeFromCookie, themeFromQuery, themeSetCookie, themeMetas, themeAttr, safeNext, type ThemePref, type ThemeMode } from "./theme";
export { fileSeal, seal, plate, kofraMotifs } from "./motifs";
export { clientScriptUrl, CLIENT_SCRIPT } from "./assets";
