/**
 * Harness Tests — linkedin
 *
 * Guards against regressions found during install simulation.
 * No browser, no network — runs in milliseconds.
 *
 * Lessons encoded here:
 *   - isLoggedIn must return FALSE on an unauthenticated page (never use body-content heuristics)
 *   - accountMenu/auth selectors must NOT match public page elements
 *   - package.json must include "files" → dist or new users get source-only packages
 *   - repository.url required for npm provenance publishing
 *   - prepublishOnly ensures build runs before every publish
 */
import { describe, it, expect } from "vitest";
import linkedinAdapter from "../src/index.js";
const adapter = linkedinAdapter;
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf8"));

// ── package.json structural guards ────────────────────────────────────────────

describe("package.json harness guards", () => {
  it('has "files" field containing "dist"', () => {
    expect(pkg.files, 'Missing "files" in package.json — dist/ will be excluded from npm publish').toBeDefined();
    expect(pkg.files).toContain("dist");
  });

  it("has repository.url — required for npm provenance publishing", () => {
    expect(pkg.repository?.url, 'Missing repository.url — npm provenance will reject the publish').toBeTruthy();
    expect(pkg.repository.url).toContain("github.com");
  });

  it("has prepublishOnly script — ensures build runs before every publish", () => {
    expect(pkg.scripts?.prepublishOnly, 'Missing prepublishOnly — packages may publish without compiling').toBeTruthy();
  });
});

// ── Minimal Page mock (no browser, no network) ────────────────────────────────

/**
 * isLoggedIn contract:
 *   - MUST return false on an unauthenticated page
 *   - MUST return false on the login page
 *   - MUST return true when the account/nav element is present
 *
 * This was violated in the Booking adapter (bodyText.length > 100 heuristic)
 * causing health_check to report loggedIn=true for unauthenticated sessions.
 */
function makeMockPage(url: string, hasAuthElement = false) {
  return {
    url: () => url,
    locator: (sel: string) => {
      const found = hasAuthElement && sel.includes("global-nav");
      return {
        count: async () => (found ? 1 : 0),
        isVisible: async () => (found ? true : false),
        first: () => ({
          isVisible: async (_opts?: unknown) => (found ? true : false),
          click: async () => {},
        }),
      };
    },
    evaluate: async (_fn: unknown) => "",
    waitForTimeout: async () => {},
    goto: async (_url: string) => null,
    waitForSelector: async () => null,
  };
}

describe("isLoggedIn contract — unauthenticated", () => {
  it("returns false on adapter domain with no auth elements present", async () => {
    const page = makeMockPage(`https://${adapter.domain}/`, false);
    expect(await adapter.isLoggedIn(page as never)).toBe(false);
  });

  it("returns false on the login URL", async () => {
    const page = makeMockPage(adapter.loginUrl, false);
    expect(await adapter.isLoggedIn(page as never)).toBe(false);
  });
});

describe("isLoggedIn contract — authenticated", () => {
  it("returns true when the auth nav element is present", async () => {
    const page = makeMockPage(`https://${adapter.domain}/`, true);
    expect(await adapter.isLoggedIn(page as never)).toBe(true);
  });
});

// ── Tool registry ─────────────────────────────────────────────────────────────

describe("tool registry", () => {
  it("tools() returns a non-empty array", () => {
    expect(adapter.tools().length).toBeGreaterThan(0);
  });

  it("every tool has a non-empty name and description", () => {
    for (const tool of adapter.tools()) {
      expect(tool.name.length, `tool missing name`).toBeGreaterThan(0);
      expect(tool.description?.length ?? 0, `"${tool.name}" missing description`).toBeGreaterThan(10);
    }
  });

  it("every tool has a handler", () => {
    for (const tool of adapter.tools()) {
      expect(typeof tool.handler, `"${tool.name}" missing handler`).toBe("function");
    }
  });
});
