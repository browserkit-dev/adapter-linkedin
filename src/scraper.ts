/**
 * LinkedIn extraction engine using innerText + URL navigation.
 *
 * Design philosophy (mirrors linkedin_mcp_server):
 * - Navigate directly to a section URL rather than clicking UI elements
 * - Extract innerText rather than parsing DOM selectors
 * - Strip LinkedIn page chrome (footer, sidebar) before returning
 * - Build compact link references for entity traversal
 *
 * innerText is resilient to LinkedIn's frequent DOM/class-name churn.
 */

import type { Page } from "patchright";
import { detectAuthBarrier, isAuthBlockerUrl } from "@browserkit/core";

// ── Types ──────────────────────────────────────────────────────────────────

export interface Reference {
  href: string;
  text: string;
  heading: string;
  inArticle: boolean;
  inNav: boolean;
}

/**
 * Structured error for a section that failed to scrape.
 * Mirrors linkedin_mcp_server's build_issue_diagnostics output format (simplified).
 */
export interface SectionError {
  /** "AuthBarrier" | "Error" — machine-readable category */
  error_type: string;
  /** Human-readable error message */
  error_message: string;
  /** Which scraping function detected the error: "extractPage" | "extractOverlay" */
  context: string;
  /** The URL that was being scraped when the error occurred */
  target_url: string;
  /** The section name that failed */
  section_name: string;
}

export interface ExtractedSection {
  text: string;
  references: Reference[];
  error?: string;
}

// ── Noise patterns (port of Python _NOISE_MARKERS) ─────────────────────────

const NOISE_PATTERNS: RegExp[] = [
  // Footer nav block
  /^About\n+(?:Accessibility|Talent Solutions)/m,
  // Sidebar recommendations
  /^More profiles for you$/m,
  // Premium upsell
  /^Explore premium profiles$/m,
  // InMail upsell
  /^Get up to .+ replies when you message with InMail$/m,
  // Footer nav clusters
  /^(?:Careers|Privacy & Terms|Questions\?|Select language)\n+(?:Privacy & Terms|Questions\?|Select language|Advertising|Ad Choices)/m,
];

const NOISE_LINES: RegExp[] = [
  /^(?:Play|Pause|Playback speed|Turn fullscreen on|Fullscreen)$/,
  /^(?:Show captions|Close modal window|Media player modal window)$/,
  /^(?:Loaded:.*|Remaining time.*|Stream Type.*)$/,
];

export function stripLinkedInNoise(text: string): string {
  // Find earliest noise marker and truncate there
  let earliest = text.length;
  for (const pattern of NOISE_PATTERNS) {
    const match = pattern.exec(text);
    if (match && match.index < earliest) {
      earliest = match.index;
    }
  }
  const truncated = text.slice(0, earliest).trim();

  // Filter known media/control noise lines
  return truncated
    .split("\n")
    .filter((line) => !NOISE_LINES.some((p) => p.test(line.trim())))
    .join("\n")
    .trim();
}

// ── Reference extraction ───────────────────────────────────────────────────

async function buildReferences(page: Page): Promise<Reference[]> {
  const MAX_ANCHORS = 500;

  return page.evaluate((maxAnchors) => {
    const containerSelector = "section, article, li, div";
    const headingSelector = "h1, h2, h3";

    const getHeadingText = (el: Element): string => {
      const h = el.matches(headingSelector)
        ? el
        : el.querySelector(":scope > h1, :scope > h2, :scope > h3");
      return ((h as HTMLElement)?.innerText ?? (h as HTMLElement)?.textContent ?? "").replace(/\s+/g, " ").trim();
    };

    const getPreviousHeading = (node: Element): string => {
      let sib: Element | null = node.previousElementSibling;
      for (let i = 0; sib && i < 3; i++, sib = sib.previousElementSibling) {
        const h = getHeadingText(sib);
        if (h) return h;
      }
      return "";
    };

    const headingMap = new WeakMap<Element, string>();
    const candidates = [document.body, ...Array.from(document.querySelectorAll(containerSelector)).slice(0, 300)];
    for (const node of candidates) {
      const heading = getHeadingText(node) || getPreviousHeading(node);
      if (heading) headingMap.set(node, heading);
    }

    const findHeading = (el: Element): string => {
      let cur: Element | null = el.closest(containerSelector) ?? document.body;
      for (let depth = 0; cur && depth < 4; depth++) {
        const h = headingMap.get(cur);
        if (h) return h;
        if (cur === document.body) break;
        cur = cur.parentElement?.closest(containerSelector) ?? null;
      }
      return "";
    };

    return Array.from(document.querySelectorAll("a[href]"))
      .slice(0, maxAnchors)
      .map((anchor) => {
        const rawHref = (anchor.getAttribute("href") ?? "").trim();
        if (!rawHref || rawHref === "#") return null;
        const href = rawHref.startsWith("#") ? rawHref : (anchor as HTMLAnchorElement).href ?? rawHref;
        return {
          href,
          text: ((anchor as HTMLElement).innerText ?? anchor.textContent ?? "").replace(/\s+/g, " ").trim(),
          heading: findHeading(anchor),
          inArticle: Boolean(anchor.closest("article")),
          inNav: Boolean(anchor.closest("nav")),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, MAX_ANCHORS);
}

// ── Page extraction ────────────────────────────────────────────────────────

const NAV_DELAY_MS = 2_000;

async function waitAndScroll(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 });
  // Brief settle pause
  await page.waitForTimeout(800);
  // Scroll to trigger lazy content
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(600);
}

/**
 * Navigate to a full LinkedIn page, extract its innerText, strip noise, build refs.
 */
export async function extractPage(
  page: Page,
  url: string
): Promise<ExtractedSection> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await waitAndScroll(page);

    // Quick auth barrier check after navigation (URL path only — cheap)
    const barrier = await detectAuthBarrier(page, true);
    if (barrier) {
      return { text: "", references: [], error: `Auth barrier: ${barrier}` };
    }

    const rawText = await page.evaluate(
      () => (document.querySelector("main, .scaffold-layout, body") as HTMLElement)?.innerText ?? ""
    );
    const text = stripLinkedInNoise(rawText);
    const references = await buildReferences(page);
    return { text, references };
  } catch (err) {
    return { text: "", references: [], error: String(err) };
  }
}

/**
 * Navigate to a LinkedIn overlay (e.g. contact-info), extract its text.
 * Overlays are loaded as modal dialogs over the current page.
 */
export async function extractOverlay(
  page: Page,
  url: string
): Promise<ExtractedSection> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(1_000);

    // Quick auth barrier check
    const barrier = await detectAuthBarrier(page, true);
    if (barrier) {
      return { text: "", references: [], error: `Auth barrier: ${barrier}` };
    }

    // Try to grab the modal/dialog content first, fall back to main
    const rawText = await page.evaluate(() => {
      const modal =
        document.querySelector('[role="dialog"]') ??
        document.querySelector(".pv-contact-info") ??
        document.querySelector("section.artdeco-card") ??
        document.querySelector("main");
      return (modal as HTMLElement)?.innerText ?? "";
    });

    const text = stripLinkedInNoise(rawText);
    const references = await buildReferences(page);
    return { text, references };
  } catch (err) {
    return { text: "", references: [], error: String(err) };
  }
}

// ── Section scraping helpers ───────────────────────────────────────────────

export interface ScrapeResult {
  url: string;
  sections: Record<string, string>;
  references?: Record<string, Reference[]>;
  /** Structured errors for sections that failed to scrape. */
  section_errors?: Record<string, SectionError>;
  unknown_sections?: string[];
  job_ids?: string[];
}

/**
 * Scrape a person profile with configurable sections.
 * Always includes main_profile; iterates requested sections with NAV_DELAY.
 */
export async function scrapePerson(
  page: Page,
  username: string,
  requested: Set<string>,
  sectionMap: Record<string, { suffix: string; isOverlay: boolean }>
): Promise<ScrapeResult> {
  const baseUrl = `https://www.linkedin.com/in/${username}`;
  const sections: Record<string, string> = {};
  const references: Record<string, Reference[]> = {};
  const section_errors: Record<string, SectionError> = {};

  let first = true;
  for (const [name, cfg] of Object.entries(sectionMap)) {
    if (!requested.has(name)) continue;
    if (!first) await new Promise((r) => setTimeout(r, NAV_DELAY_MS));
    first = false;

    const url = baseUrl + cfg.suffix;
    const extracted = cfg.isOverlay
      ? await extractOverlay(page, url)
      : await extractPage(page, url);

    if (extracted.text) {
      sections[name] = extracted.text;
      if (extracted.references.length > 0) references[name] = extracted.references;
    } else if (extracted.error) {
      const isAuthErr = extracted.error.startsWith("Auth barrier:");
      section_errors[name] = {
        error_type: isAuthErr ? "AuthBarrier" : "Error",
        error_message: extracted.error,
        context: cfg.isOverlay ? "extractOverlay" : "extractPage",
        target_url: url,
        section_name: name,
      };
    }
  }

  const result: ScrapeResult = { url: `${baseUrl}/`, sections };
  if (Object.keys(references).length > 0) result.references = references;
  if (Object.keys(section_errors).length > 0) result.section_errors = section_errors;
  return result;
}

/**
 * Scrape a company profile with configurable sections.
 * Always includes about; iterates requested sections with NAV_DELAY.
 */
export async function scrapeCompany(
  page: Page,
  companyName: string,
  requested: Set<string>,
  sectionMap: Record<string, { suffix: string; isOverlay: boolean }>
): Promise<ScrapeResult> {
  const baseUrl = `https://www.linkedin.com/company/${companyName}`;
  const sections: Record<string, string> = {};
  const references: Record<string, Reference[]> = {};
  const section_errors: Record<string, SectionError> = {};

  let first = true;
  for (const [name, cfg] of Object.entries(sectionMap)) {
    if (!requested.has(name)) continue;
    if (!first) await new Promise((r) => setTimeout(r, NAV_DELAY_MS));
    first = false;

    const url = baseUrl + cfg.suffix;
    const extracted = await extractPage(page, url);

    if (extracted.text) {
      sections[name] = extracted.text;
      if (extracted.references.length > 0) references[name] = extracted.references;
    } else if (extracted.error) {
      const isAuthErr = extracted.error.startsWith("Auth barrier:");
      section_errors[name] = {
        error_type: isAuthErr ? "AuthBarrier" : "Error",
        error_message: extracted.error,
        context: "extractPage",
        target_url: url,
        section_name: name,
      };
    }
  }

  const result: ScrapeResult = { url: `${baseUrl}/`, sections };
  if (Object.keys(references).length > 0) result.references = references;
  if (Object.keys(section_errors).length > 0) result.section_errors = section_errors;
  return result;
}

/**
 * Extract job IDs from the current page's anchor hrefs.
 */
export async function extractJobIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const anchor of Array.from(document.querySelectorAll('a[href*="/jobs/view/"]'))) {
      const href = (anchor as HTMLAnchorElement).href;
      const match = href.match(/\/jobs\/view\/(\d+)/);
      if (match?.[1] && !seen.has(match[1])) {
        seen.add(match[1]);
        ids.push(match[1]);
      }
    }
    return ids;
  });
}

// ── URL builders ───────────────────────────────────────────────────────────

const DATE_POSTED_MAP: Record<string, string> = {
  past_hour:    "r3600",
  past_24_hours: "r86400",
  past_week:    "r604800",
  past_month:   "r2592000",
};

const EXPERIENCE_LEVEL_MAP: Record<string, string> = {
  internship: "1", entry: "2", associate: "3",
  mid_senior: "4", director: "5", executive: "6",
};

const JOB_TYPE_MAP: Record<string, string> = {
  full_time: "F", part_time: "P", contract: "C", temporary: "T",
  volunteer: "V", internship: "I", other: "O",
};

const WORK_TYPE_MAP: Record<string, string> = {
  on_site: "1", remote: "2", hybrid: "3",
};

const SORT_BY_MAP: Record<string, string> = { date: "DD", relevance: "R" };

function normalizeCsv(value: string, map: Record<string, string>): string {
  return value.split(",").map((v) => map[v.trim()] ?? v.trim()).join(",");
}

export function buildJobSearchUrl(opts: {
  keywords: string;
  location?: string;
  datePosted?: string;
  jobType?: string;
  experienceLevel?: string;
  workType?: string;
  easyApply?: boolean;
  sortBy?: string;
}): string {
  const params = new URLSearchParams();
  params.set("keywords", opts.keywords);
  if (opts.location) params.set("location", opts.location);
  if (opts.datePosted) params.set("f_TPR", normalizeCsv(opts.datePosted, DATE_POSTED_MAP));
  if (opts.jobType) params.set("f_JT", normalizeCsv(opts.jobType, JOB_TYPE_MAP));
  if (opts.experienceLevel) params.set("f_E", normalizeCsv(opts.experienceLevel, EXPERIENCE_LEVEL_MAP));
  if (opts.workType) params.set("f_WT", normalizeCsv(opts.workType, WORK_TYPE_MAP));
  if (opts.easyApply) params.set("f_LF", "f_AL");
  if (opts.sortBy) params.set("sortBy", normalizeCsv(opts.sortBy, SORT_BY_MAP));
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}
