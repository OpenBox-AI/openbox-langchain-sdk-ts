import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Static import-graph guard for the root entry point.
//
// The runtime `scripts/check-root-import-light.mjs` inspects the BUILT dist in a
// clean process (and catches CJS heavy drivers + global patches). This test is
// the source-level companion: it walks the module graph reachable from
// `src/index.ts` via runtime imports and asserts no forbidden package is pulled
// in. It runs against source (no `dist` needed) so it fires during `vitest run`,
// which precedes `build` in `ci:check`.
//
// Only RUNTIME imports count. `import type` / `export type` statements are fully
// elided under `verbatimModuleSyntax`, so a type-only reference to a heavy base
// SDK subpath (e.g. `import type { OpenBoxRuntime }`) is allowed and skipped here.

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

// Runtime imports that must NEVER be reachable from the light root graph.
const FORBIDDEN =
  /^(langchain(\/|$)|@langchain\/langgraph|@openbox-ai\/openbox-sdk\/instrumentation|node:crypto|node:net|node:http|node:https|node:dns|node:tls|pg|mysql2?|mongodb|ioredis|redis|@opentelemetry\/(sdk-node|sdk-trace-node|instrumentation))/;

/** Extract runtime (value) import/export specifiers from a source file. */
function runtimeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  // Match `import ... from "x"`, `export ... from "x"`, and bare `import "x"`.
  const re = /(?:^|\n)\s*(import|export)\b([^"';]*?)\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const bareImport = m[4];
    if (bareImport !== undefined) {
      specifiers.push(bareImport);
      continue;
    }
    const keyword = m[1];
    const clause = m[2] ?? "";
    const spec = m[3];
    if (spec === undefined) continue;
    // Skip whole-statement type-only imports/exports (elided at runtime).
    if (/^\s*type\b/.test(clause)) continue;
    void keyword;
    specifiers.push(spec);
  }
  return specifiers;
}

/** Resolve a relative specifier (which uses a `.js` extension) to its `.ts` source path. */
function resolveLocal(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  return base.replace(/\.js$/, ".ts");
}

/** Walk the runtime import graph from an entry source file. Returns all bare specifiers seen. */
function collectBareSpecifiers(entry: string): {
  bare: Set<string>;
  visited: Set<string>;
} {
  const bare = new Set<string>();
  const visited = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of runtimeSpecifiers(source)) {
      if (spec.startsWith(".")) {
        stack.push(resolveLocal(file, spec));
      } else {
        bare.add(spec);
      }
    }
  }
  return { bare, visited };
}

describe("package boundaries (root import-light)", () => {
  const { bare } = collectBareSpecifiers(resolve(SRC_ROOT, "index.ts"));

  it("pulls in no forbidden runtime dependency from the root graph", () => {
    const offenders = [...bare].filter((s) => FORBIDDEN.test(s));
    expect(offenders).toEqual([]);
  });

  it("never reaches the full `langchain` agent framework at the root", () => {
    const langchainImports = [...bare].filter(
      (s) => s === "langchain" || s.startsWith("langchain/")
    );
    expect(langchainImports).toEqual([]);
  });
});
