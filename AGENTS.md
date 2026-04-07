# @browserkit-dev/adapter-linkedin

LinkedIn adapter for browserkit. Requires login.
Provides profile lookup, company info, job search, and feed reading.

## Stack

- Language: TypeScript 5.x → compiled to `dist/`
- Runtime: Node.js 20+
- Browser: Patchright (Playwright fork, anti-detection) via `@browserkit-dev/core`
- Key deps: `@browserkit-dev/core` (peer), `patchright` (peer), `zod`

## Repo layout

```
src/
  index.ts    # adapter definition — tools, isLoggedIn, selectors, rateLimit
  scraper.ts  # DOM extraction helpers
  selectors.ts# CSS/ARIA selectors (edit here when site DOM changes)
tests/
  linkedin.test.ts            # L1 unit — metadata, schemas, helpers (no browser)
  linkedin.integration.test.ts# L2 live scraping — real browser, real network
  mcp-protocol.test.ts       # L3 MCP protocol — server lifecycle, tool dispatch
  harness.test.ts            # Harness guards — isLoggedIn contract, pkg.json checks
dist/         # compiled output (gitignored; included in npm publish via "files")
```

## How to run

```bash
npm install          # install deps
npm run build        # tsc → dist/
npm test             # unit + harness tests (no browser)
npm run test:integration  # live browser tests (requires internet + login)
make agent-check     # full verification gate — run before declaring done
```

## Engineering rules

1. **`isLoggedIn` must return `false` by default** when not authenticated — never use body-content
   length, cookie presence, or other heuristics; only return `true` when a specific auth element
   is confirmed present (a hard lesson: `bodyText.length > 100` matched the public homepage).
2. **Auth selectors must be exclusive to logged-in state** — never `[aria-label*="account"]`
   (matches "Create an account" and other public nav). Use `data-testid` or `data-component`.
3. **`package.json` must have `"files": ["dist", "README.md"]`** — without it, npm follows
   `.gitignore` and ships source-only packages that the daemon can't load.
4. **`repository.url` required** — npm provenance rejects publishes without it.
5. **`prepublishOnly: "tsc"`** — ensures `dist/` is always rebuilt before `npm publish`.
6. **Selectors belong in `selectors.ts`** — never hardcode CSS strings in `index.ts` or `scraper.ts`.
7. **No `any` types** — use `unknown` with type narrowing or Zod schemas.
8. **Use `isAuthBlockerUrl` + `detectAuthBarrier` from `@browserkit-dev/core`** — these cover 7+ LinkedIn auth redirect patterns; never DIY auth detection.
9. **CSS class selectors break on LinkedIn** — use `innerText`-based extraction and ARIA walk-ups; `data-*` attributes are more stable.
10. **Rate limit is 3s minimum** — LinkedIn rate-limits aggressively; never reduce below 2s.

## Done criteria

A task is complete when ALL of the following pass:

- [ ] `npm run build` exits 0 (no TypeScript errors)
- [ ] `npm test` passes (L1 unit + harness tests, no browser needed)
- [ ] `make agent-check` passes (build + test in one command)
- [ ] `npm pack --dry-run` shows `dist/` files in the tarball
- [ ] `isLoggedIn` harness test passes with mock page (no regression)


## Deeper docs

- Architecture: `../../ARCH.md` (monorepo) or `README.md` in this repo
- Selector maintenance: update `src/selectors.ts` when the site changes DOM
- Publishing: push to `main` → CI builds and publishes via OIDC (no token needed)
