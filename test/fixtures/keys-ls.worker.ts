/** Disposable acceptance Worker. Ordinary keys use the real bearer identity adapter.
 * The two explicit fixture identities exercise a keyless member's empty inventory
 * and the serializer's omitted `current` marker without minting credentials.
 * No product endpoint, service, authorization check or serializer is replaced.
 */
import { defaultIdentity } from "@dropway/core";
import { createDropway } from "@dropway/server";

export default createDropway({
  adapters: {
    identity: {
      async resolve(request, dc) {
        const auth = request.headers.get("Authorization");
        const memberId = auth === "Bearer dw_fixtureEmpty_000000000000000000000000"
          ? "mem_empty"
          : auth === "Bearer dw_fixtureKeyless_0000000000000000000000"
            ? "mem_other"
            : null;
        if (!memberId) return defaultIdentity.resolve(request, dc);
        return {
          kind: "member", tenantId: "ten_keys", memberId, role: "member",
          scopes: ["keys:write"], keyId: null, siteId: null,
          via: "acceptance_fixture", ip: "127.0.0.1",
        };
      },
    },
  },
});
