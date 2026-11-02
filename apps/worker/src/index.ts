/**
 * The open-source, single-tenant Kofra Worker.
 *
 * One tenant (an owner plus optional members and scoped API keys), no signup,
 * no plans or billing. Configuration comes from wrangler.jsonc vars and secrets.
 * To build on top of Kofra, call createKofra() with your own adapters,
 * hooks, routes, MCP tools and UI slots instead of editing the packages.
 */
import { createKofra, type ServerBindings } from "@kofra/server";

const kofra = createKofra();

export default {
  fetch: kofra.fetch,
  scheduled: kofra.scheduled,
} satisfies ExportedHandler<ServerBindings>;
