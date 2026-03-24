/**
 * LinkedIn section configuration maps.
 *
 * Each entry maps a section name to its URL suffix and whether it is a
 * modal overlay (isOverlay: true) rather than a full page navigation.
 *
 * Direct TypeScript port of linkedin_mcp_server/scraping/fields.py.
 */

export interface SectionConfig {
  suffix: string;
  isOverlay: boolean;
}

export const PERSON_SECTIONS: Record<string, SectionConfig> = {
  main_profile: { suffix: "/", isOverlay: false },
  experience:   { suffix: "/details/experience/", isOverlay: false },
  education:    { suffix: "/details/education/", isOverlay: false },
  interests:    { suffix: "/details/interests/", isOverlay: false },
  honors:       { suffix: "/details/honors/", isOverlay: false },
  languages:    { suffix: "/details/languages/", isOverlay: false },
  contact_info: { suffix: "/overlay/contact-info/", isOverlay: true },
  posts:        { suffix: "/recent-activity/all/", isOverlay: false },
} as const;

export const COMPANY_SECTIONS: Record<string, SectionConfig> = {
  about: { suffix: "/about/", isOverlay: false },
  posts: { suffix: "/posts/", isOverlay: false },
  jobs:  { suffix: "/jobs/", isOverlay: false },
} as const;

export interface ParsedSections {
  requested: Set<string>;
  unknown: string[];
}

/**
 * Parse a comma-separated section string into a validated set.
 * The default section is always included regardless of input.
 * Unknown section names are collected separately (not silently dropped).
 */
export function parseSections(
  input: string | null | undefined,
  valid: Record<string, SectionConfig>,
  defaultSection: string
): ParsedSections {
  const requested = new Set<string>([defaultSection]);
  const unknown: string[] = [];

  if (!input) return { requested, unknown };

  for (const raw of input.split(",")) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (name in valid) {
      requested.add(name);
    } else {
      unknown.push(name);
    }
  }

  return { requested, unknown };
}
