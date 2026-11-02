// Disposable local-runtime fixture, never a deployment entry point.
import { createKofra } from "@kofra/server";

export default createKofra({
  config: {
    limits: { maxFileBytes: 200 * 1024 * 1024, maxSiteBytes: 300 * 1024 * 1024 },
  },
});
