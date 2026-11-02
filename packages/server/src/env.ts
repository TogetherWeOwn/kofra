import type { CoreBindings, KofraContext, KofraVars, Principal } from "@kofra/core";

/** Bindings + vars the Worker receives. Extensions may add their own bindings. */
export type ServerBindings = CoreBindings & KofraVars & Record<string, unknown>;

/** Hono environment shared by every Kofra route (core and extension routes). */
export type KofraEnv = {
  Bindings: ServerBindings;
  Variables: {
    /** Per-request service context: pass it to any @kofra/core service. */
    dw: KofraContext;
    /** The authenticated caller (resolved by the identity adapter for /api/* routes). */
    principal: Principal;
    requestId: string;
  };
};
