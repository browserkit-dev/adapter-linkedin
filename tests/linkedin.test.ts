import { describe, it, expect } from "vitest";
import linkedinAdapter from "../src/index.js";
import { parseSections, PERSON_SECTIONS, COMPANY_SECTIONS } from "../src/sections.js";
import { stripLinkedInNoise, buildJobSearchUrl, type SectionError } from "../src/scraper.js";
import { isAuthBlockerUrl, detectAuthBarrier } from "@browserkit/core";

// ── Adapter metadata ──────────────────────────────────────────────────────

describe("LinkedIn adapter", () => {
  it("has required fields", () => {
    expect(linkedinAdapter.site).toBe("linkedin");
    expect(linkedinAdapter.domain).toBe("linkedin.com");
    expect(linkedinAdapter.loginUrl).toBe("https://www.linkedin.com/login");
  });

  it("has a positive rate limit", () => {
    expect(linkedinAdapter.rateLimit?.minDelayMs).toBeGreaterThan(0);
  });

  it("exposes all 7 expected tools", () => {
    const names = linkedinAdapter.tools().map((t) => t.name);
    expect(names).toContain("get_person_profile");
    expect(names).toContain("get_company_profile");
    expect(names).toContain("get_company_posts");
    expect(names).toContain("search_people");
    expect(names).toContain("search_jobs");
    expect(names).toContain("get_job_details");
    expect(names).toContain("get_feed");
    expect(names).not.toContain("get_messages");
  });

  it("all tools have required fields", () => {
    for (const tool of linkedinAdapter.tools()) {
      expect(tool.name, `${tool.name} missing name`).toBeTruthy();
      expect(typeof tool.description, `${tool.name} description`).toBe("string");
      expect(tool.inputSchema, `${tool.name} missing schema`).toBeDefined();
      expect(typeof tool.handler, `${tool.name} missing handler`).toBe("function");
    }
  });
});

// ── Schema validation ─────────────────────────────────────────────────────

describe("get_person_profile schema", () => {
  const tool = () => linkedinAdapter.tools().find((t) => t.name === "get_person_profile")!;

  it("requires linkedin_username", () => {
    expect(tool().inputSchema.safeParse({}).success).toBe(false);
    expect(tool().inputSchema.safeParse({ linkedin_username: "stickerdaniel" }).success).toBe(true);
  });

  it("sections is optional", () => {
    expect(tool().inputSchema.safeParse({ linkedin_username: "foo" }).success).toBe(true);
    expect(tool().inputSchema.safeParse({ linkedin_username: "foo", sections: "experience,education" }).success).toBe(true);
  });
});

describe("get_company_profile schema", () => {
  const tool = () => linkedinAdapter.tools().find((t) => t.name === "get_company_profile")!;

  it("requires company_name", () => {
    expect(tool().inputSchema.safeParse({}).success).toBe(false);
    expect(tool().inputSchema.safeParse({ company_name: "anthropic" }).success).toBe(true);
  });
});

describe("search_jobs schema", () => {
  const tool = () => linkedinAdapter.tools().find((t) => t.name === "search_jobs")!;

  it("requires keywords", () => {
    expect(tool().inputSchema.safeParse({}).success).toBe(false);
    expect(tool().inputSchema.safeParse({ keywords: "engineer" }).success).toBe(true);
  });

  it("max_pages defaults to 3 and is capped at 10", () => {
    const result = tool().inputSchema.safeParse({ keywords: "dev" });
    expect(result.success && (result.data as { max_pages: number }).max_pages).toBe(3);
    expect(tool().inputSchema.safeParse({ keywords: "dev", max_pages: 11 }).success).toBe(false);
    expect(tool().inputSchema.safeParse({ keywords: "dev", max_pages: 10 }).success).toBe(true);
  });

  it("accepts optional filters", () => {
    expect(tool().inputSchema.safeParse({
      keywords: "engineer",
      location: "Remote",
      date_posted: "past_week",
      job_type: "full_time",
      experience_level: "entry",
      work_type: "remote",
      easy_apply: true,
      sort_by: "date",
    }).success).toBe(true);
  });
});

describe("get_job_details schema", () => {
  const tool = () => linkedinAdapter.tools().find((t) => t.name === "get_job_details")!;

  it("requires a numeric job_id", () => {
    expect(tool().inputSchema.safeParse({}).success).toBe(false);
    expect(tool().inputSchema.safeParse({ job_id: "abc" }).success).toBe(false);
    expect(tool().inputSchema.safeParse({ job_id: "4252026496" }).success).toBe(true);
  });
});

describe("search_people schema", () => {
  const tool = () => linkedinAdapter.tools().find((t) => t.name === "search_people")!;

  it("requires keywords", () => {
    expect(tool().inputSchema.safeParse({}).success).toBe(false);
    expect(tool().inputSchema.safeParse({ keywords: "John Smith" }).success).toBe(true);
  });

  it("location is optional", () => {
    expect(tool().inputSchema.safeParse({ keywords: "dev", location: "NYC" }).success).toBe(true);
  });
});

describe("get_feed schema", () => {
  const tool = () => linkedinAdapter.tools().find((t) => t.name === "get_feed")!;

  it("accepts count", () => {
    expect(tool().inputSchema.safeParse({ count: 5 }).success).toBe(true);
    expect(tool().inputSchema.safeParse({ count: 0 }).success).toBe(false);
  });
});

// ── Section parsing ───────────────────────────────────────────────────────

describe("parseSections", () => {
  it("always includes the default section", () => {
    const { requested } = parseSections(null, PERSON_SECTIONS, "main_profile");
    expect(requested.has("main_profile")).toBe(true);
  });

  it("parses comma-separated sections", () => {
    const { requested, unknown } = parseSections("experience,education", PERSON_SECTIONS, "main_profile");
    expect(requested.has("experience")).toBe(true);
    expect(requested.has("education")).toBe(true);
    expect(requested.has("main_profile")).toBe(true);
    expect(unknown).toHaveLength(0);
  });

  it("collects unknown sections", () => {
    const { requested, unknown } = parseSections("experience,fakesection", PERSON_SECTIONS, "main_profile");
    expect(requested.has("experience")).toBe(true);
    expect(unknown).toContain("fakesection");
  });

  it("handles empty/null input", () => {
    expect(parseSections("", PERSON_SECTIONS, "main_profile").requested.size).toBe(1);
    expect(parseSections(undefined, PERSON_SECTIONS, "main_profile").requested.size).toBe(1);
  });

  it("PERSON_SECTIONS has all expected sections", () => {
    const names = Object.keys(PERSON_SECTIONS);
    expect(names).toContain("main_profile");
    expect(names).toContain("experience");
    expect(names).toContain("contact_info");
    expect(names).toContain("posts");
  });

  it("COMPANY_SECTIONS has expected sections", () => {
    const names = Object.keys(COMPANY_SECTIONS);
    expect(names).toContain("about");
    expect(names).toContain("posts");
    expect(names).toContain("jobs");
  });
});

// ── Scraper utilities ─────────────────────────────────────────────────────

describe("stripLinkedInNoise", () => {
  it("removes footer nav blocks", () => {
    const text = "Profile content here\nAbout\nAccessibility\nTalent Solutions";
    const cleaned = stripLinkedInNoise(text);
    expect(cleaned).not.toContain("Accessibility");
    expect(cleaned).toContain("Profile content here");
  });

  it("removes sidebar recommendation blocks", () => {
    const text = "Useful content\nMore profiles for you\nSome sidebar name";
    expect(stripLinkedInNoise(text)).not.toContain("More profiles for you");
    expect(stripLinkedInNoise(text)).toContain("Useful content");
  });

  it("returns text unchanged when no noise present", () => {
    const text = "Clean profile text with no noise markers";
    expect(stripLinkedInNoise(text)).toBe(text);
  });
});

describe("buildJobSearchUrl", () => {
  it("builds a valid URL with keywords", () => {
    const url = buildJobSearchUrl({ keywords: "software engineer" });
    expect(url).toContain("linkedin.com/jobs/search/");
    expect(url).toContain("keywords=software+engineer");
  });

  it("includes location when provided", () => {
    const url = buildJobSearchUrl({ keywords: "dev", location: "Remote" });
    expect(url).toContain("location=Remote");
  });

  it("normalizes date_posted filter", () => {
    const url = buildJobSearchUrl({ keywords: "dev", datePosted: "past_week" });
    expect(url).toContain("f_TPR=r604800");
  });

  it("normalizes work_type filter", () => {
    const url = buildJobSearchUrl({ keywords: "dev", workType: "remote" });
    expect(url).toContain("f_WT=2");
  });

  it("includes easy_apply flag", () => {
    const url = buildJobSearchUrl({ keywords: "dev", easyApply: true });
    expect(url).toContain("f_LF=f_AL");
  });
});

// ── isAuthBlockerUrl (core utility) ──────────────────────────────────────

describe("isAuthBlockerUrl", () => {
  it("detects exact auth blocker paths", () => {
    expect(isAuthBlockerUrl("https://www.linkedin.com/login")).toBe(true);
    expect(isAuthBlockerUrl("https://www.linkedin.com/authwall")).toBe(true);
    expect(isAuthBlockerUrl("https://www.linkedin.com/checkpoint")).toBe(true);
    expect(isAuthBlockerUrl("https://www.linkedin.com/challenge")).toBe(true);
    expect(isAuthBlockerUrl("https://www.linkedin.com/uas/login")).toBe(true);
  });

  it("detects auth blocker paths with trailing slash", () => {
    expect(isAuthBlockerUrl("https://www.linkedin.com/login/")).toBe(true);
    expect(isAuthBlockerUrl("https://www.linkedin.com/checkpoint/")).toBe(true);
  });

  it("detects auth blocker paths with sub-paths", () => {
    expect(isAuthBlockerUrl("https://www.linkedin.com/checkpoint/lg/login-submit")).toBe(true);
    expect(isAuthBlockerUrl("https://www.linkedin.com/challenge/solve/abc123")).toBe(true);
  });

  it("does NOT match normal pages", () => {
    expect(isAuthBlockerUrl("https://www.linkedin.com/feed/")).toBe(false);
    expect(isAuthBlockerUrl("https://www.linkedin.com/in/stickerdaniel")).toBe(false);
    expect(isAuthBlockerUrl("https://www.linkedin.com/jobs/search/")).toBe(false);
    expect(isAuthBlockerUrl("https://www.linkedin.com/company/anthropic")).toBe(false);
  });

  it("does NOT match slugs that START WITH but aren't the blocker path", () => {
    // /login-tips should NOT match /login
    expect(isAuthBlockerUrl("https://www.linkedin.com/login-tips")).toBe(false);
    // /checkpoint-article should NOT match /checkpoint
    expect(isAuthBlockerUrl("https://www.linkedin.com/checkpoint-article")).toBe(false);
  });

  it("handles invalid URLs gracefully", () => {
    expect(isAuthBlockerUrl("not-a-url")).toBe(false);
    expect(isAuthBlockerUrl("")).toBe(false);
  });
});

// ── detectAuthBarrier (core utility) ─────────────────────────────────────

describe("detectAuthBarrier", () => {
  it("detects auth barrier from URL via mock page", async () => {
    // Mock a page at an authwall URL
    const mockPage = {
      url: () => "https://www.linkedin.com/authwall",
      title: async () => "LinkedIn",
      locator: () => ({ count: async () => 0, innerText: async () => "" }),
    } as unknown as Parameters<typeof detectAuthBarrier>[0];

    const result = await detectAuthBarrier(mockPage, true);
    expect(result).not.toBeNull();
    expect(result).toContain("authwall");
  });

  it("returns null for a normal page URL in quick mode", async () => {
    const mockPage = {
      url: () => "https://www.linkedin.com/feed/",
      title: async () => "LinkedIn Feed",
      locator: () => ({ count: async () => 1, innerText: async () => "Home" }),
    } as unknown as Parameters<typeof detectAuthBarrier>[0];

    const result = await detectAuthBarrier(mockPage, true);
    expect(result).toBeNull();
  });
});

// ── SectionError structured format ───────────────────────────────────────

describe("SectionError type", () => {
  it("has all required fields defined in the type", () => {
    // Compile-time check — this just verifies the interface shape
    const err: SectionError = {
      error_type: "AuthBarrier",
      error_message: "Auth barrier: auth blocker URL: https://linkedin.com/authwall",
      context: "extractPage",
      target_url: "https://www.linkedin.com/in/username/details/experience/",
      section_name: "experience",
    };
    expect(err.error_type).toBe("AuthBarrier");
    expect(err.context).toBe("extractPage");
    expect(typeof err.target_url).toBe("string");
  });
});
