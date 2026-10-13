/**
 * CATEGORY UTILITIES — single source of truth for Lookbook categories.
 *
 * Shared by dashboard.js (admin inventory: write side) and app.js (public
 * Lookbook: read side) so both always agree on how a category is labelled,
 * slugged and resolved. Keep this file free of Firebase / DOM dependencies.
 */

/** Reserved filter key for "show everything". Never a valid category slug. */
export const ALL_CATEGORIES = "all";

/** Suggestions seeded into the admin category field before any exist in Firestore. */
export const DEFAULT_CATEGORIES = ["Kaftans", "Suits", "Agbada", "Printed Shirts"];

/** Max label length — keeps filter buttons tidy on small screens. */
export const CATEGORY_MAX_LENGTH = 32;

const FALLBACK_LABEL = "Other";

/**
 * Inventory written before the category field existed only carries a
 * silhouetteSlug. Map those to a sensible category so legacy pieces still
 * filter correctly until an admin edits them.
 */
const LEGACY_SLUG_TO_CATEGORY = {
  "signature-kaftan": "Kaftans",
  "bespoke-two-piece": "Suits",
  "luxury-agbada": "Agbada",
  "printed-apparel": "Printed Shirts",
};

/** Trim, collapse inner whitespace, cap length. */
export function cleanCategoryLabel(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, CATEGORY_MAX_LENGTH);
}

/** Case/punctuation-insensitive key: "Printed  Shirts" and "printed shirts" collapse to one filter. */
export function categorySlug(label) {
  const slug = cleanCategoryLabel(label)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === ALL_CATEGORIES ? "all-items" : slug;
}

/**
 * Resolve a collection document to { label, slug, isFallback }.
 * Order: stored category → legacy silhouette mapping → "Other".
 */
export function resolveCategory(data = {}) {
  const stored = cleanCategoryLabel(data.category);
  if (stored && categorySlug(stored)) {
    return { label: stored, slug: categorySlug(stored), isFallback: false };
  }
  const legacy = LEGACY_SLUG_TO_CATEGORY[data.silhouetteSlug];
  if (legacy) {
    return { label: legacy, slug: categorySlug(legacy), isFallback: false };
  }
  return { label: FALLBACK_LABEL, slug: categorySlug(FALLBACK_LABEL), isFallback: true };
}

/** Minimal HTML escaper for admin-entered text rendered via innerHTML. */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}