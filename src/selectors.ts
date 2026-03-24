import type { Page } from "patchright";

/**
 * LinkedIn DOM selectors — kept minimal.
 *
 * The adapter now uses innerText extraction + URL navigation for all content
 * tools (get_person_profile, search_jobs, etc.) which is resilient to LinkedIn's
 * frequent DOM/class-name churn. Only the auth check and get_feed tool need
 * DOM selectors here.
 */
export const SELECTORS = {
  // Auth detection — used by isLoggedIn
  globalNav: '[data-test-id="nav-top"]',

  // Feed (get_feed tool only)
  // LinkedIn rotates between data-id and data-urn for activity URNs — try both
  feedPost: '[data-urn^="urn:li:activity"], div[data-id^="urn:li:activity"], .feed-shared-update-v2, .occludable-update',
  feedPostAuthorName: '.update-components-actor__name, .feed-shared-actor__name',
  feedPostText: 'div[dir="ltr"] > span[dir="ltr"], .feed-shared-text__text-view span',
  feedPostReactions: '.social-details-social-counts__reactions-count, .social-counts-reactions__count',
} as const;

// Re-export Page type for adapters importing from selectors
export type { Page };
