import { ApiError, readVersionPreview, requestIp, type DropwayContext, type Principal } from "@dropway/core";
import { isNavigation, serveSiteContent, systemResponse, type ServeMode } from "./serve";
import type { Viewer } from "./viewers";

/** Preview responses must not outlive their authorization or leak the bearer URL through a Referer. */
export function previewResponse(response: Response): Response {
  response.headers.set("X-Robots-Tag", "noindex");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.delete("Access-Control-Allow-Origin");
  return response;
}

export async function serveVersionPreview(
  request: Request,
  dw: DropwayContext,
  slug: string,
  number: number,
  pathname: string,
  mode: ServeMode,
  viewers: readonly Viewer[],
): Promise<Response> {
  const deny = () => previewResponse(systemResponse(dw, request, mode, null, 404, "404", "Nothing is published here", "There is no site at this address. See {app}."));
  const passwordPost = request.method === "POST" && pathname === "/__dropway/password";
  if (request.method !== "GET" && request.method !== "HEAD" && !passwordPost) return deny();
  const url = new URL(request.url);
  const cookieName = `${mode.kind === "subdomain" ? "__Host-" : ""}dw_preview`;
  const queryToken = url.searchParams.get("dw_preview");
  const cookieToken = request.headers.get("cookie")?.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) ?? null;
  let principal: Principal = { kind: "anonymous", ip: requestIp(request) };
  if (request.headers.has("authorization")) {
    try {
      principal = await dw.adapters.identity.resolve(request, dw);
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 401 && error.status !== 403)) throw error;
      return deny();
    }
  }
  // An ambient expired cookie must not veto an explicit owner credential.
  // An explicitly supplied query capability still has to validate on redemption.
  const token = queryToken ?? (request.headers.has("authorization") ? null : cookieToken);
  const preview = await readVersionPreview(dw, principal, slug, number, token);
  if (!preview) return deny();
  if (!mode.sandbox && preview.live.tenantId === null && dw.config.sitesSandboxAnonymous) mode = { ...mode, sandbox: true };
  // Sibling subdomains are same-site: a Lax cookie alone must not grant them readable scripts.
  if (!mode.sandbox && !isNavigation(request) && ["same-site", "cross-site"].includes(request.headers.get("sec-fetch-site") ?? "")) return deny();
  if (queryToken !== null) {
    url.searchParams.delete("dw_preview");
    if (url.pathname === mode.base.slice(0, -1)) url.pathname = mode.base;
    const maxAge = Math.max(0, Math.floor((preview.expiresAt! - Date.now()) / 1000));
    const frame = ["iframe", "frame"].includes(request.headers.get("sec-fetch-dest") ?? "");
    const sameSite = mode.sandbox ? "None" : frame ? "None; Partitioned" : "Lax";
    return previewResponse(new Response(null, {
      status: 303,
      headers: {
        Location: url.toString(),
        "Set-Cookie": `${cookieName}=${queryToken}; Path=${mode.base}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=${sameSite}`,
      },
    }));
  }
  if (url.pathname === mode.base.slice(0, -1)) {
    url.pathname = mode.base;
    return previewResponse(new Response(null, { status: 301, headers: { Location: url.toString() } }));
  }
  return previewResponse(await serveSiteContent(request, dw, preview.live, pathname, { ...mode, preview: true, pathShim: mode.kind === "path" }, viewers));
}
