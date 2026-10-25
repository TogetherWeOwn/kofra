import { describe, expect, it } from "vitest";
import {
  DropwayClient as SdkClient,
  DropwayError as SdkError,
  movedTo as sdkMovedTo,
  normaliseApi as sdkNormaliseApi,
} from "@dropway/client";
import { CliError, DropwayClient, EXIT, errorFromResponse, movedTo, normaliseApi } from "../src/client.ts";

/** R-45: the CLI's transport is @dropway/client, with CLI exit codes layered on top. */
describe("CLI client uses @dropway/client", () => {
  it("shares the transport implementation", () => {
    const client = new DropwayClient({ api: "https://kofra.test", token: null });
    expect(client).toBeInstanceOf(SdkClient);
    expect(new CliError({ code: "x", message: "y", exitCode: EXIT.error })).toBeInstanceOf(SdkError);
  });

  it("re-exports the shared redirect helper and normalises URLs like the SDK", async () => {
    expect(movedTo).toBe(sdkMovedTo);
    expect(normaliseApi("kofra.test/api/v1")).toBe(sdkNormaliseApi("kofra.test/api/v1"));
    const bad = (() => {
      try {
        normaliseApi("  ");
        expect.unreachable();
      } catch (e) {
        return e as CliError;
      }
    })();
    expect(bad).toBeInstanceOf(CliError);
    expect(bad.exitCode).toBe(EXIT.usage);
    const err = await errorFromResponse(
      new Response(JSON.stringify({ error: { code: "gone", message: "no" } }), { status: 404 }),
    );
    expect(err).toBeInstanceOf(SdkError);
    expect(err.code).toBe("gone");
  });

  it("throws CliError from typed methods too", async () => {
    const client = new DropwayClient({ api: "https://kofra.test", token: null });
    const err = await client.getSite({} as unknown as { slug: string }).then(
      () => expect.unreachable("expected the call to throw"),
      (e: unknown) => e as CliError,
    );
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe("invalid_input");
    expect(err.exitCode).toBe(EXIT.error);
  });
});
