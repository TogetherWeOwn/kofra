import { createDropway } from "@dropway/server";

// Disposable local-only fixture for the `kofra claim` CLI acceptance tests
// (packages/cli/test/claim-*.acceptance.test.ts). It is the real app plus one
// test-only route that backdates an anonymous site's expiry so the "expired
// site" case needs no 24 h wait. The route only answers on the local fixture
// Worker (bound to 127.0.0.1, torn down after the suite) and requires the
// fixture bootstrap key. Never deployed; never imported by source code.
export default createDropway({
  routes: [
    ({ api }) => {
      api.post("/__fixture/expire-site", async (c) => {
        const bootstrap = c.env.ADMIN_BOOTSTRAP_KEY;
        if (!bootstrap || c.req.header("authorization") !== `Bearer ${bootstrap}`) {
          return c.json({ ok: false, error: "fixture route needs the bootstrap key" }, 401);
        }
        const body = (await c.req.json().catch(() => null)) as { slug?: unknown } | null;
        const slug = typeof body?.slug === "string" ? body.slug.toLowerCase() : "";
        if (!slug) return c.json({ ok: false, error: "pass { slug }" }, 400);
        await c.env.DB.prepare("UPDATE sites SET expires_at = ? WHERE slug = ?").bind(Date.now() - 1000, slug).run();
        return c.json({ ok: true, slug });
      });
    },
  ],
});
