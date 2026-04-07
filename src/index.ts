import { defineAdapter } from "@browserkit-dev/core";
import type { ToolReference } from "@browserkit-dev/core";
import { isAuthBlockerUrl, detectAuthBarrier } from "@browserkit-dev/core";
import { z } from "zod";
import type { Page } from "patchright";
import { SELECTORS } from "./selectors.js";
import {
  extractPage,
  scrapePerson,
  scrapeCompany,
  extractJobIds,
  buildJobSearchUrl,
  type ScrapeResult,
  type Reference,
  type SectionError,
} from "./scraper.js";
import {
  PERSON_SECTIONS,
  COMPANY_SECTIONS,
  parseSections,
} from "./sections.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a structured SectionError from an extracted.error string. */
function makeSectionError(
  error: string,
  context: string,
  targetUrl: string,
  sectionName: string
): SectionError {
  return {
    error_type: error.startsWith("Auth barrier:") ? "AuthBarrier" : "Error",
    error_message: error,
    context,
    target_url: targetUrl,
    section_name: sectionName,
  };
}

const PAGE_SIZE = 25;
const NAV_DELAY_MS = 2_000;

/** Convert scraper References to browserkit ToolReferences for traversal */
function toToolRefs(refs: Record<string, Reference[]> | undefined): ToolReference[] {
  if (!refs) return [];
  return Object.entries(refs).flatMap(([section, list]) =>
    list
      .filter((r) => r.href.startsWith("http") && !r.inNav)
      .map((r): ToolReference => ({
        kind: "linkedin",
        url: r.href,
        text: r.text || undefined,
        context: section,
      }))
  );
}

/** Serialise a ScrapeResult to the MCP content text */
function toText(result: ScrapeResult): string {
  return JSON.stringify(result, null, 2);
}

// ── Adapter ────────────────────────────────────────────────────────────────

export default defineAdapter({
  site: "linkedin",
  minCoreVersion: "0.1.0",
  domain: "linkedin.com",
  loginUrl: "https://www.linkedin.com/login",
  selectors: { globalNav: SELECTORS.globalNav },
  rateLimit: { minDelayMs: 3_000 },

  async isLoggedIn(page: Page): Promise<boolean> {
    try {
      // 1. Dismiss "Remember Me" / "Stay signed in?" prompt if present.
      //    LinkedIn shows this between login and the feed — if not dismissed,
      //    every subsequent navigation redirects back to this prompt.
      const rememberMeDiv = page.locator('#rememberme-div, [data-id="remember-me-prompt"]').first();
      if (await rememberMeDiv.isVisible({ timeout: 1500 }).catch(() => false)) {
        const skipBtn = page
          .locator('button:has-text("Not now"), button:has-text("Skip"), button[aria-label*="dismiss"]')
          .first();
        if (await skipBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await skipBtn.click().catch(() => {});
          await page.waitForTimeout(800);
        }
      }

      // 2. Fail-fast on auth blocker URLs (7 patterns — more comprehensive than before)
      if (isAuthBlockerUrl(page.url())) return false;

      // 3. Full auth barrier check: title + body text markers
      const barrier = await detectAuthBarrier(page, false);
      if (barrier) return false;

      // 4. Old nav selector set (LinkedIn pre-2024 DOM)
      const oldNav = await page.locator(
        '.global-nav__primary-link, [data-control-name="nav.settings"]'
      ).count();
      // 5. New nav selector set (LinkedIn 2024+ DOM)
      const newNav = await page.locator(
        'nav a[href*="/feed"], nav button:has-text("Home"), nav a[href*="/mynetwork"]'
      ).count();

      if (oldNav > 0 || newNav > 0) return true;

      // 6. URL fallback for authenticated-only pages
      const url = page.url();
      const authenticatedPaths = ["/feed", "/mynetwork", "/messaging", "/notifications"];
      const isAuthPage = authenticatedPaths.some((p) => url.includes(`linkedin.com${p}`));
      if (!isAuthPage) return false;

      // 7. Body text check — prevent false positives on empty authenticated pages
      //    (can happen during cookie bridge/import recovery)
      const bodyText = await page.evaluate(
        () => (document.body?.innerText ?? "").trim()
      ).catch(() => "");
      return typeof bodyText === "string" && bodyText.length > 0;
    } catch {
      return false;
    }
  },

  tools: () => [

    // ── get_person_profile ──────────────────────────────────────────────────
    {
      name: "get_person_profile",
      description: [
        "Get a LinkedIn person profile. The main profile page is always scraped.",
        "Use the sections parameter to request additional sub-pages.",
        "",
        "Available sections: experience, education, interests, honors, languages, contact_info, posts",
        "Example: sections='experience,education'",
        "",
        "Returns: { url, sections: { [name]: rawText }, references?, section_errors?, unknown_sections? }",
        "The LLM should parse the raw text in each section.",
      ].join("\n"),
      inputSchema: z.object({
        linkedin_username: z.string().min(1).describe(
          "LinkedIn username, e.g. 'stickerdaniel' or 'williamhgates'"
        ),
        sections: z.string().optional().describe(
          "Comma-separated extra sections: experience, education, interests, honors, languages, contact_info, posts"
        ),
      }),
      annotations: { readOnlyHint: true as const, openWorldHint: true as const },
      async handler(page: Page, input: unknown) {
        const { linkedin_username, sections } = z.object({
          linkedin_username: z.string(),
          sections: z.string().optional(),
        }).parse(input);

        const { requested, unknown } = parseSections(sections, PERSON_SECTIONS, "main_profile");
        const result = await scrapePerson(page, linkedin_username, requested, PERSON_SECTIONS);
        if (unknown.length > 0) result.unknown_sections = unknown;

        return {
          content: [{ type: "text" as const, text: toText(result) }],
          references: toToolRefs(result.references),
        };
      },
    },

    // ── get_company_profile ────────────────────────────────────────────────
    {
      name: "get_company_profile",
      description: [
        "Get a LinkedIn company profile. The about page is always scraped.",
        "Use the sections parameter to request additional sub-pages.",
        "",
        "Available sections: posts, jobs",
        "Example: sections='posts,jobs'",
        "",
        "Returns: { url, sections: { [name]: rawText }, references?, section_errors?, unknown_sections? }",
      ].join("\n"),
      inputSchema: z.object({
        company_name: z.string().min(1).describe(
          "LinkedIn company slug, e.g. 'anthropic', 'microsoft', 'docker'"
        ),
        sections: z.string().optional().describe(
          "Comma-separated extra sections: posts, jobs"
        ),
      }),
      annotations: { readOnlyHint: true as const, openWorldHint: true as const },
      async handler(page: Page, input: unknown) {
        const { company_name, sections } = z.object({
          company_name: z.string(),
          sections: z.string().optional(),
        }).parse(input);

        const { requested, unknown } = parseSections(sections, COMPANY_SECTIONS, "about");
        const result = await scrapeCompany(page, company_name, requested, COMPANY_SECTIONS);
        if (unknown.length > 0) result.unknown_sections = unknown;

        return {
          content: [{ type: "text" as const, text: toText(result) }],
          references: toToolRefs(result.references),
        };
      },
    },

    // ── get_company_posts ──────────────────────────────────────────────────
    {
      name: "get_company_posts",
      description: [
        "Get recent posts from a LinkedIn company's feed.",
        "",
        "Returns: { url, sections: { posts: rawText }, references? }",
        "The LLM should parse the raw text to extract individual posts.",
      ].join("\n"),
      inputSchema: z.object({
        company_name: z.string().min(1).describe(
          "LinkedIn company slug, e.g. 'anthropic', 'microsoft'"
        ),
      }),
      annotations: { readOnlyHint: true as const, openWorldHint: true as const },
      async handler(page: Page, input: unknown) {
        const { company_name } = z.object({ company_name: z.string() }).parse(input);

        const url = `https://www.linkedin.com/company/${company_name}/posts/`;
        const extracted = await extractPage(page, url);

        const sections: Record<string, string> = {};
        const references: Record<string, Reference[]> = {};
        const section_errors: Record<string, SectionError> = {};

        if (extracted.text) {
          sections["posts"] = extracted.text;
          if (extracted.references.length > 0) references["posts"] = extracted.references;
        } else if (extracted.error) {
          section_errors["posts"] = makeSectionError(extracted.error, "extractPage", url, "posts");
        }

        const result: ScrapeResult = { url, sections };
        if (Object.keys(references).length > 0) result.references = references;
        if (Object.keys(section_errors).length > 0) result.section_errors = section_errors;

        return {
          content: [{ type: "text" as const, text: toText(result) }],
          references: toToolRefs(result.references),
        };
      },
    },

    // ── search_people ──────────────────────────────────────────────────────
    {
      name: "search_people",
      description: [
        "Search for people on LinkedIn by keywords and optional location.",
        "",
        "Returns: { url, sections: { search_results: rawText }, references? }",
        "The LLM should parse the raw text to extract individual people.",
      ].join("\n"),
      inputSchema: z.object({
        keywords: z.string().min(1).describe(
          "Search keywords, e.g. 'software engineer at Google', 'recruiter'"
        ),
        location: z.string().optional().describe(
          "Optional location filter, e.g. 'New York', 'Remote'"
        ),
      }),
      annotations: { readOnlyHint: true as const, openWorldHint: true as const },
      async handler(page: Page, input: unknown) {
        const { keywords, location } = z.object({
          keywords: z.string(),
          location: z.string().optional(),
        }).parse(input);

        const params = new URLSearchParams({ keywords });
        if (location) params.set("location", location);
        const url = `https://www.linkedin.com/search/results/people/?${params.toString()}`;

        const extracted = await extractPage(page, url);
        const sections: Record<string, string> = {};
        const references: Record<string, Reference[]> = {};
        const section_errors: Record<string, SectionError> = {};

        if (extracted.text) {
          sections["search_results"] = extracted.text;
          if (extracted.references.length > 0) references["search_results"] = extracted.references;
        } else if (extracted.error) {
          section_errors["search_results"] = makeSectionError(extracted.error, "extractPage", url, "search_results");
        }

        const result: ScrapeResult = { url, sections };
        if (Object.keys(references).length > 0) result.references = references;
        if (Object.keys(section_errors).length > 0) result.section_errors = section_errors;

        return {
          content: [{ type: "text" as const, text: toText(result) }],
          references: toToolRefs(result.references),
        };
      },
    },

    // ── search_jobs ────────────────────────────────────────────────────────
    {
      name: "search_jobs",
      description: [
        "Search for jobs on LinkedIn. Returns job IDs that can be passed to get_job_details.",
        "",
        "Returns: { url, sections: { search_results: rawText }, job_ids: string[], references? }",
        "Use job_ids with get_job_details to get full job descriptions.",
      ].join("\n"),
      inputSchema: z.object({
        keywords: z.string().min(1).describe("Search keywords, e.g. 'software engineer'"),
        location: z.string().optional().describe("Location filter, e.g. 'San Francisco'"),
        max_pages: z.number().int().min(1).max(10).default(3).describe("Max result pages (1–10)"),
        date_posted: z.string().optional().describe(
          "Filter by date: past_hour, past_24_hours, past_week, past_month"
        ),
        job_type: z.string().optional().describe(
          "Job type (comma-separated): full_time, part_time, contract, temporary, volunteer, internship, other"
        ),
        experience_level: z.string().optional().describe(
          "Experience level (comma-separated): internship, entry, associate, mid_senior, director, executive"
        ),
        work_type: z.string().optional().describe(
          "Work type (comma-separated): on_site, remote, hybrid"
        ),
        easy_apply: z.boolean().default(false).describe("Only show Easy Apply jobs"),
        sort_by: z.string().optional().describe("Sort: date or relevance"),
      }),
      annotations: { readOnlyHint: true as const, openWorldHint: true as const },
      async handler(page: Page, input: unknown) {
        const opts = z.object({
          keywords: z.string(),
          location: z.string().optional(),
          max_pages: z.number().default(3),
          date_posted: z.string().optional(),
          job_type: z.string().optional(),
          experience_level: z.string().optional(),
          work_type: z.string().optional(),
          easy_apply: z.boolean().default(false),
          sort_by: z.string().optional(),
        }).parse(input);

        const baseUrl = buildJobSearchUrl({
          keywords: opts.keywords,
          location: opts.location,
          datePosted: opts.date_posted,
          jobType: opts.job_type,
          experienceLevel: opts.experience_level,
          workType: opts.work_type,
          easyApply: opts.easy_apply,
          sortBy: opts.sort_by,
        });

        const allJobIds: string[] = [];
        const seenIds = new Set<string>();
        const pageTexts: string[] = [];
        const pageRefs: Reference[] = [];
        const section_errors: Record<string, SectionError> = {};

        for (let pageNum = 0; pageNum < opts.max_pages; pageNum++) {
          if (pageNum > 0) await new Promise((r) => setTimeout(r, NAV_DELAY_MS));

          const url = pageNum === 0 ? baseUrl : `${baseUrl}&start=${pageNum * PAGE_SIZE}`;
          const extracted = await extractPage(page, url);

          if (!extracted.text) {
            if (extracted.error) section_errors["search_results"] = makeSectionError(extracted.error, "extractPage", url, "search_results");
            break;
          }

          const newIds = (await extractJobIds(page)).filter((id) => !seenIds.has(id));
          if (pageNum > 0 && newIds.length === 0) {
            pageTexts.push(extracted.text);
            if (extracted.references.length > 0) pageRefs.push(...extracted.references);
            break;
          }
          for (const id of newIds) { seenIds.add(id); allJobIds.push(id); }
          pageTexts.push(extracted.text);
          if (extracted.references.length > 0) pageRefs.push(...extracted.references);
        }

        const result: ScrapeResult = {
          url: baseUrl,
          sections: pageTexts.length > 0
            ? { search_results: pageTexts.join("\n---\n") }
            : {},
          job_ids: allJobIds,
        };
        if (pageRefs.length > 0) result.references = { search_results: pageRefs };
        if (Object.keys(section_errors).length > 0) result.section_errors = section_errors;

        return {
          content: [{ type: "text" as const, text: toText(result) }],
          references: toToolRefs(result.references),
        };
      },
    },

    // ── get_job_details ────────────────────────────────────────────────────
    {
      name: "get_job_details",
      description: [
        "Get full details for a LinkedIn job posting by its ID.",
        "",
        "Use search_jobs first to find job IDs, then call this tool for each.",
        "",
        "Returns: { url, sections: { job_details: rawText }, references? }",
      ].join("\n"),
      inputSchema: z.object({
        job_id: z.string().min(1).regex(/^\d+$/, "job_id must be numeric").describe(
          "LinkedIn job ID, e.g. '4252026496'. Get from search_jobs."
        ),
      }),
      annotations: { readOnlyHint: true as const, openWorldHint: true as const },
      async handler(page: Page, input: unknown) {
        const { job_id } = z.object({
          job_id: z.string().regex(/^\d+$/),
        }).parse(input);

        const url = `https://www.linkedin.com/jobs/view/${job_id}/`;
        const extracted = await extractPage(page, url);

        const sections: Record<string, string> = {};
        const references: Record<string, Reference[]> = {};
        const section_errors: Record<string, SectionError> = {};

        if (extracted.text) {
          sections["job_details"] = extracted.text;
          if (extracted.references.length > 0) references["job_details"] = extracted.references;
        } else if (extracted.error) {
          section_errors["job_details"] = makeSectionError(extracted.error, "extractPage", url, "job_details");
        }

        const result: ScrapeResult = { url, sections };
        if (Object.keys(references).length > 0) result.references = references;
        if (Object.keys(section_errors).length > 0) result.section_errors = section_errors;

        return {
          content: [{ type: "text" as const, text: toText(result) }],
          references: toToolRefs(result.references),
        };
      },
    },

    // ── get_feed ───────────────────────────────────────────────────────────
    // Kept from original adapter — not in stickerdaniel/linkedin-mcp-server
    // but retained per user request. Uses DOM selectors (feed structure is
    // stable enough to not need innerText approach).
    {
      name: "get_feed",
      description: "Get the top N posts from your LinkedIn feed",
      inputSchema: z.object({
        count: z.number().int().min(1).max(50).default(10).describe("Number of posts to return"),
      }),
      annotations: { readOnlyHint: true as const, openWorldHint: true as const },
      async handler(page: Page, input: unknown) {
        const { count } = z.object({ count: z.number() }).parse(input);

        // Navigate to feed if not already there
        const currentUrl = page.url();
        if (!currentUrl.includes("linkedin.com/feed")) {
          await page.goto("https://www.linkedin.com/feed/", {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
        }
        await page.waitForTimeout(2_000);

        // Find feed post cards by walking up from social-action buttons.
        // This approach is resilient to DOM/class churn — "Like", "Comment",
        // "Repost", "Send" button labels are stable semantic elements that
        // appear in every feed post regardless of React component version.
        const rawPosts: string[] = await page.evaluate((maxPosts: number) => {
          const actionLabels = ["like", "comment", "repost", "send", "react"];
          const actionButtons = Array.from(document.querySelectorAll("button[aria-label]")).filter(
            (btn) => actionLabels.some(label =>
              (btn as HTMLElement).getAttribute("aria-label")?.toLowerCase().includes(label)
            )
          );

          // Walk up from each button to find the enclosing post card.
          // A post card is the smallest ancestor that is "wide" (full-width card).
          const seen = new Set<Element>();
          const cards: HTMLElement[] = [];
          for (const btn of actionButtons) {
            let el: HTMLElement = btn as HTMLElement;
            // Walk up until we find an element with offsetHeight > 150px (a real card)
            for (let i = 0; i < 15 && el.parentElement; i++) {
              el = el.parentElement as HTMLElement;
              if (el.offsetHeight > 150 && el.offsetWidth > 400) break;
            }
            if (!seen.has(el)) {
              seen.add(el);
              cards.push(el);
            }
            if (cards.length >= maxPosts) break;
          }

          return cards.map(card => card.innerText.trim().slice(0, 1000));
        }, count);

        const results = rawPosts
          .filter(text => text.length > 50)
          .map((text, i) => ({
            post_index: i + 1,
            content: text,
          }));

        return {
          content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }],
        };
      },
    },

  ],
});
