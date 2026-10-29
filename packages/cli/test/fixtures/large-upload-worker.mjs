// Disposable local-runtime fixture, never a deployment entry point.
import { createDropway } from "@dropway/server";

export default createDropway({
  config: {
    limits: { maxFileBytes: 200 * 1024 * 1024, maxSiteBytes: 300 * 1024 * 1024 },
  },
});
