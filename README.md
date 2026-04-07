# @browserkit-dev/adapter-linkedin

[LinkedIn](https://www.linkedin.com) adapter for [browserkit](https://github.com/browserkit-dev/browserkit) — exposes LinkedIn as MCP tools over your authenticated local browser session. Runs entirely on your machine; no credentials leave localhost.

## Tools

| Tool | Key inputs | Description |
|---|---|---|
| `get_person_profile` | `linkedin_username`, `sections?` | Scrape a person's profile. Optional sections: `experience`, `education`, `interests`, `honors`, `languages`, `contact_info`, `posts` |
| `get_company_profile` | `company_id`, `sections?` | Scrape a company page. Optional sections: `about`, `jobs`, `people`, `insights` |
| `get_company_posts` | `company_id`, `count?` | Recent posts from a company page |
| `search_people` | `keywords`, `count?` | Search LinkedIn people |
| `search_jobs` | `keywords`, `location?`, `count?` | Search LinkedIn job listings |
| `get_job_details` | `job_id` | Full details for a specific job posting |
| `get_feed` | `count?` | Your personalised LinkedIn feed |

Plus auto-registered management tools from the framework: `browser` (health check, screenshot, page state, mode switch, navigate), `close_session`.

## Setup

```bash
# Install
pnpm add @browserkit-dev/adapter-linkedin

# One-time login (opens a browser window — sign in normally)
browserkit login linkedin

# Start
browserkit start --config browserkit.config.js
```

```js
// browserkit.config.js
import { defineConfig } from "@browserkit-dev/core";

export default defineConfig({
  adapters: {
    "@browserkit-dev/adapter-linkedin": {
      port: 3848,
      channel: "chrome",   // use real Chrome — avoids bot detection on login
    },
  },
});
```

Connect your MCP client (Cursor, Claude Desktop, etc.) to `http://127.0.0.1:3848/mcp`.

## How it works

LinkedIn's DOM changes frequently. This adapter uses an **`innerText` extraction strategy** rather than CSS class selectors: it navigates directly to section URLs and reads raw text content. This makes it resilient to React component upgrades and class-name churn.

For the feed tool, post cards are located by walking up from their social action buttons (`aria-label` containing "like"/"comment"/"repost") — stable semantic anchors that don't rotate.

Auth uses a persistent browser profile (`~/Library/Application Support/browserkit/profiles/linkedin` on macOS). Cookies survive daemon restarts — you only need to `browserkit login linkedin` once.

## Session notes

- Use `channel: "chrome"` in your adapter config to use real Google Chrome. This avoids LinkedIn's bot detection on the login page.
- The adapter runs headless by default. Use the `browser` MCP tool with `action: "set_mode"` and `mode: "watch"` to make it visible for debugging.
- Rate limit is 3 seconds between tool calls by default to avoid triggering LinkedIn's anti-scraping measures.

## Tests

```bash
pnpm test                # unit tests (schema, scraper logic, URL building)
pnpm test:integration    # live browser tests against real LinkedIn (requires login)
```

## License

MIT
