import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOpenBoxLangChainMiddleware,
  type OpenBoxLangChainMiddlewareBundle
} from "../src/middleware/index.js";
import { makeFakeCoreRuntime } from "./fakes.js";

const cleanups: OpenBoxLangChainMiddlewareBundle[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.close();
});

describe("createOpenBoxLangChainMiddleware factory", () => {
  it("preserves an injected runtime and skips rebuilding one", async () => {
    const { runtime } = makeFakeCoreRuntime();
    const openbox = await createOpenBoxLangChainMiddleware({
      runtime,
      validate: false,
      installInstrumentation: false
    });
    cleanups.push(openbox);
    expect(openbox.runtime).toBe(runtime);
  });

  it("has an idempotent close()", async () => {
    const { runtime } = makeFakeCoreRuntime();
    const openbox = await createOpenBoxLangChainMiddleware({
      runtime,
      validate: false,
      installInstrumentation: false
    });
    await expect(openbox.close()).resolves.toBeUndefined();
    await expect(openbox.close()).resolves.toBeUndefined();
  });

  it("is collision-safe: a second factory on a different runtime gets instrumentation:null with a diagnostic", async () => {
    const first = await createOpenBoxLangChainMiddleware({
      runtime: makeFakeCoreRuntime().runtime,
      validate: false
      // installInstrumentation defaults ON
    });
    cleanups.push(first);
    expect(first.instrumentation).not.toBeNull();

    const warn = vi.fn();
    const second = await createOpenBoxLangChainMiddleware({
      runtime: makeFakeCoreRuntime().runtime,
      validate: false,
      logger: { warn }
    });
    cleanups.push(second);

    // Governance still enforced, but no instrumentation for the second agent.
    expect(second.instrumentation).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    // And it still returns a working, valid close().
    await expect(second.close()).resolves.toBeUndefined();
  });

  it("validates the API key when validate is not false", async () => {
    const { runtime } = makeFakeCoreRuntime();
    const spy = vi.spyOn(runtime.client, "validateApiKey");
    const openbox = await createOpenBoxLangChainMiddleware({
      runtime,
      installInstrumentation: false
      // validate defaults true
    });
    cleanups.push(openbox);
    expect(spy).toHaveBeenCalledOnce();
  });
});
