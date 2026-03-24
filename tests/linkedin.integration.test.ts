/**
 * LinkedIn Adapter — Integration Tests
 *
 * Verifies our adapter output structure matches stickerdaniel/linkedin-mcp-server.
 *
 * Prerequisites:
 *   1. `browserkit login linkedin` — log in to LinkedIn once
 *   2. `browserkit start --config browserkit.config.js` — daemon must be running
 *
 * Run:
 *   pnpm test:integration
 *
 * Output format we're verifying (matches stickerdaniel/linkedin-mcp-server):
 *   {
 *     url: string
 *     sections: { [name]: rawText }
 *     references?: { [section]: Reference[] }
 *     section_errors?: { [name]: string }
 *     job_ids?: string[]          // search_jobs only
 *     unknown_sections?: string[] // when invalid sections passed
 *   }
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestMcpClient, type TestMcpClient } from "@browserkit/core/testing";

const MCP_URL = "http://127.0.0.1:52744/mcp";

let client: TestMcpClient;

beforeAll(async () => {
  client = await createTestMcpClient(MCP_URL);
}, 15_000);

afterAll(async () => {
  await client.close();
});

// ── Auth check ─────────────────────────────────────────────────────────────

describe("auth", () => {
  it("health_check reports loggedIn=true", async () => {
    const r = await client.callTool("browser", { action: "health_check" });
    const status = JSON.parse(r.content[0]?.text ?? "{}") as { loggedIn: boolean; site: string };
    expect(status.site).toBe("linkedin");
    // If this fails: run `browserkit login linkedin`
    expect(status.loggedIn).toBe(true);
  });
});

// ── Output structure helpers ───────────────────────────────────────────────

interface ScrapeResult {
  url: string;
  sections: Record<string, string>;
  references?: Record<string, Array<{ href: string; text: string }>>;
  section_errors?: Record<string, string>;
  job_ids?: string[];
  unknown_sections?: string[];
}

function parseScrapeResult(toolResult: { content: Array<{ text?: string }>; isError?: boolean }): ScrapeResult {
  expect(toolResult.isError, "tool returned isError:true").toBeFalsy();
  const text = toolResult.content[0]?.text ?? "{}";
  return JSON.parse(text) as ScrapeResult;
}

// ── get_person_profile ─────────────────────────────────────────────────────

describe("get_person_profile", () => {
  it("returns url + sections.main_profile for a public profile", async () => {
    const r = await client.callTool("get_person_profile", {
      linkedin_username: "williamhgates",
    });
    const result = parseScrapeResult(r);

    // url must point to the profile
    expect(result.url).toContain("linkedin.com/in/williamhgates");

    // sections must have main_profile with substantial text
    expect(typeof result.sections.main_profile).toBe("string");
    expect(result.sections.main_profile.length).toBeGreaterThan(100);

    // references are optional but if present must be objects with href
    if (result.references?.main_profile) {
      for (const ref of result.references.main_profile) {
        expect(typeof ref.href).toBe("string");
      }
    }
  }, 30_000);

  it("returns requested sections when specified", async () => {
    const r = await client.callTool("get_person_profile", {
      linkedin_username: "williamhgates",
      sections: "experience",
    });
    const result = parseScrapeResult(r);

    // must have main_profile (always included) AND experience
    expect(result.sections).toHaveProperty("main_profile");
    expect(result.sections).toHaveProperty("experience");
    expect(result.sections.experience.length).toBeGreaterThan(50);
  }, 60_000);

  it("returns unknown_sections for invalid section names", async () => {
    const r = await client.callTool("get_person_profile", {
      linkedin_username: "williamhgates",
      sections: "fakesection",
    });
    const result = parseScrapeResult(r);
    expect(result.unknown_sections).toContain("fakesection");
  }, 30_000);
});

// ── get_company_profile ────────────────────────────────────────────────────

describe("get_company_profile", () => {
  it("returns url + sections.about for a company", async () => {
    const r = await client.callTool("get_company_profile", {
      company_name: "anthropic",
    });
    const result = parseScrapeResult(r);

    expect(result.url).toContain("linkedin.com/company/anthropic");
    expect(typeof result.sections.about).toBe("string");
    expect(result.sections.about.length).toBeGreaterThan(50);
  }, 30_000);
});

// ── get_company_posts ──────────────────────────────────────────────────────

describe("get_company_posts", () => {
  it("returns url + sections.posts for a company", async () => {
    const r = await client.callTool("get_company_posts", {
      company_name: "anthropic",
    });
    const result = parseScrapeResult(r);

    expect(result.url).toContain("/posts/");
    expect(typeof result.sections.posts).toBe("string");
    expect(result.sections.posts.length).toBeGreaterThan(0);
  }, 30_000);
});

// ── search_people ──────────────────────────────────────────────────────────

describe("search_people", () => {
  it("returns url + sections.search_results", async () => {
    const r = await client.callTool("search_people", {
      keywords: "software engineer",
      location: "Tel Aviv",
    });
    const result = parseScrapeResult(r);

    expect(result.url).toContain("search/results/people");
    expect(typeof result.sections.search_results).toBe("string");
    expect(result.sections.search_results.length).toBeGreaterThan(100);
  }, 30_000);
});

// ── search_jobs ────────────────────────────────────────────────────────────

describe("search_jobs", () => {
  it("returns url + sections.search_results + job_ids array", async () => {
    const r = await client.callTool("search_jobs", {
      keywords: "software engineer",
      location: "Israel",
      max_pages: 1,
    });
    const result = parseScrapeResult(r);

    expect(result.url).toContain("jobs/search");
    expect(typeof result.sections.search_results).toBe("string");

    // job_ids must be an array of numeric strings
    expect(Array.isArray(result.job_ids)).toBe(true);
    for (const id of result.job_ids ?? []) {
      expect(/^\d+$/.test(id), `job_id "${id}" is not numeric`).toBe(true);
    }
  }, 60_000);

  it("accepts date_posted and work_type filters", async () => {
    const r = await client.callTool("search_jobs", {
      keywords: "typescript developer",
      date_posted: "past_week",
      work_type: "remote",
      max_pages: 1,
    });
    const result = parseScrapeResult(r);
    expect(result.url).toContain("f_TPR=r604800");
    expect(result.url).toContain("f_WT=2");
  }, 30_000);
});

// ── get_job_details ────────────────────────────────────────────────────────

describe("get_job_details", () => {
  it("returns url + sections.job_details for a job ID from search", async () => {
    // Get a real job ID from search first
    const searchResult = await client.callTool("search_jobs", {
      keywords: "software engineer",
      location: "Tel Aviv",
      max_pages: 1,
    });
    const search = parseScrapeResult(searchResult);
    const jobId = search.job_ids?.[0];
    expect(jobId, "no job IDs returned from search").toBeTruthy();

    const r = await client.callTool("get_job_details", { job_id: jobId! });
    const result = parseScrapeResult(r);

    expect(result.url).toContain(`/jobs/view/${jobId}/`);
    expect(typeof result.sections.job_details).toBe("string");
    expect(result.sections.job_details.length).toBeGreaterThan(100);
  }, 90_000);
});

// ── get_feed ───────────────────────────────────────────────────────────────

describe("get_feed", () => {
  it("returns an array of feed posts", async () => {
    const r = await client.callTool("get_feed", { count: 3 });
    expect(r.isError).toBeFalsy();

    const posts = JSON.parse(r.content[0]?.text ?? "[]") as Array<{
      author: string;
      text: string;
      reactions: string;
    }>;

    expect(Array.isArray(posts)).toBe(true);
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) {
      expect(typeof post.author).toBe("string");
      expect(typeof post.text).toBe("string");
    }
  }, 30_000);
});

// ── Noise stripping validation ─────────────────────────────────────────────

describe("noise stripping", () => {
  it("section text does not contain LinkedIn footer patterns", async () => {
    const r = await client.callTool("get_person_profile", {
      linkedin_username: "williamhgates",
    });
    const result = parseScrapeResult(r);
    const text = result.sections.main_profile ?? "";

    // These are known LinkedIn footer/sidebar noise patterns
    expect(text).not.toMatch(/^About\n+Accessibility/m);
    expect(text).not.toContain("More profiles for you");
    expect(text).not.toContain("Explore premium profiles");
  }, 30_000);
});
