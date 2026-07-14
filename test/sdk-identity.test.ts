import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  SDK_ENGINE,
  SDK_LANGUAGE,
  SDK_PACKAGE_VERSION,
  SDK_VERSION
} from "../src/index.js";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

describe("SDK identity", () => {
  it("brands the engine as langchain", () => {
    expect(SDK_ENGINE).toBe("langchain");
  });

  it("brands the language as typescript", () => {
    expect(SDK_LANGUAGE).toBe("typescript");
  });

  it("uses this package's own version as the identity version", () => {
    expect(SDK_PACKAGE_VERSION).toBe(pkg.version);
    expect(SDK_VERSION).toBe(pkg.version);
  });

  it("composes to the expected X-OpenBox-SDK-Version header shape", () => {
    // Mirror base SDK `buildSdkIdentifier`: openbox-{engine}-{language}-v{version}.
    const identifier = `openbox-${SDK_ENGINE}-${SDK_LANGUAGE}-v${SDK_PACKAGE_VERSION}`;
    expect(identifier).toBe(`openbox-langchain-typescript-v${pkg.version}`);
  });
});
