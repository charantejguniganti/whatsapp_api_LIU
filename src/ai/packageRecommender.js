/**
 * Package Recommender
 *
 * Pure business-logic module — no I/O, no LLM calls.
 * The AI agent imports this to:
 *   1. Recommend relevant service combinations based on a customer's goals.
 *   2. Calculate accurate price totals for those combinations.
 *   3. Optionally surface an approved bundle discount when one exists.
 *
 * Guarantees:
 * - Never surfaces a bundle price unless bundle.approved === true.
 * - Never invents a price not listed in packages.js.
 * - Never multiplies session-based prices without flagging the session count.
 */
import {
  SERVICES,
  BUNDLES,
  sumServices,
  getApprovedBundles,
} from '../knowledge/packages.js';

// ---------------------------------------------------------------------------
// Goal → service-id mapping
// ---------------------------------------------------------------------------

/**
 * Maps customer goal keywords to the service ids that address them.
 * Keywords are tested case-insensitively against the customer message.
 * A service id can appear under multiple goal keywords.
 *
 * @type {Array<{keywords: string[], serviceIds: string[]}>}
 */
export const GOAL_MAPPINGS = [
  {
    keywords: ['executive', 'executive presence', 'leadership', 'corporate image', 'professional image'],
    serviceIds: ['imageConsulting', 'communicationSkills', 'postureBodyLanguage'],
  },
  {
    keywords: ['style', 'wardrobe', 'clothing', 'outfit', 'personal style', 'makeover', 'fashion'],
    serviceIds: ['imageScope', 'wearYourColor', 'wardrobeEvaluation'],
  },
  {
    keywords: ['color', 'colour', 'palette', 'skin tone', 'wear your color'],
    serviceIds: ['wearYourColor'],
  },
  {
    keywords: ['body language', 'posture', 'non-verbal', 'presence', 'body'],
    serviceIds: ['postureBodyLanguage'],
  },
  {
    keywords: ['communication', 'speak', 'public speaking', 'voice', 'articulate'],
    serviceIds: ['communicationSkills'],
  },
  {
    keywords: ['etiquette', 'soft skills', 'manners', 'dining', 'business etiquette'],
    serviceIds: ['etiquetteSoftSkills'],
  },
  {
    keywords: ['dining etiquette', 'fine dining', 'table manners', 'business lunch'],
    serviceIds: ['diningEtiquette'],
  },
  {
    keywords: ['image', 'consulting', 'image consulting', 'personal brand', 'appearance'],
    serviceIds: ['imageConsulting'],
  },
  {
    keywords: ['yoga', 'flexibility', 'mindfulness'],
    serviceIds: ['yoga'],
  },
  {
    keywords: ['sound healing', 'meditation', 'mindfulness', 'stress', 'calm', 'healing'],
    serviceIds: ['soundHealingMeditation'],
  },
  {
    keywords: ['nutrition', 'diet', 'food', 'eating', 'nutritionist', 'health'],
    serviceIds: ['nutritionConsultation'],
  },
  {
    keywords: ['wellness', 'reset', 'balance', 'holistic', 'wellbeing', 'well-being'],
    serviceIds: ['yoga', 'soundHealingMeditation', 'nutritionConsultation'],
  },
  {
    keywords: ['transformation', 'complete', 'full', 'everything', 'all', 'comprehensive'],
    serviceIds: [
      'imageConsulting',
      'communicationSkills',
      'postureBodyLanguage',
      'soundHealingMeditation',
      'nutritionConsultation',
    ],
  },
  {
    keywords: ['makeup', 'make-up', 'grooming', 'skincare', 'beauty', 'face'],
    serviceIds: ['makeupGrooming'],
  },
  {
    keywords: ['shopping', 'shop', 'buy', 'purchase'],
    serviceIds: ['personalShoppingConsulting'],
  },
  {
    keywords: ['dance'],
    serviceIds: ['dance'],
  },
  {
    keywords: ['pilates', 'reformer'],
    serviceIds: ['reformerAddon', 'onlineBarrePilates'],
  },
  {
    keywords: ['barre'],
    serviceIds: ['onlineBarrePilates'],
  },
];

// ---------------------------------------------------------------------------
// Core recommendation function
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RecommendationResult
 * @property {import('../knowledge/packages.js').Service[]} services
 *   - Deduplicated list of recommended services (in catalogue price order).
 * @property {number}   individualTotal  - Sum of all recommended service prices.
 * @property {import('../knowledge/packages.js').Bundle|null} matchedBundle
 *   - An approved bundle that covers the same combination, if one exists.
 * @property {boolean}  hasDraftBundle
 *   - True if a matching bundle exists but is not yet approved.
 * @property {string[]} sessionNotes
 *   - Warnings to include when session-based services are present.
 */

/**
 * Recommend services matching a customer's free-text goal description.
 *
 * @param {string} goalText   - Customer's raw message or goal description.
 * @returns {RecommendationResult}
 */
export function recommendServices(goalText) {
  const lower = goalText.toLowerCase();

  // Collect matching service ids (deduplicated, insertion-ordered)
  const seen = new Set();
  for (const mapping of GOAL_MAPPINGS) {
    if (mapping.keywords.some((kw) => lower.includes(kw.toLowerCase()))) {
      for (const id of mapping.serviceIds) {
        seen.add(id);
      }
    }
  }

  const services = [...seen]
    .map((id) => SERVICES[id])
    .filter(Boolean);

  const individualTotal = services.reduce((sum, s) => sum + s.price, 0);

  // Session-based service warning
  const sessionNotes = services
    .filter((s) => s.basis.toLowerCase().startsWith('per session'))
    .map((s) => `${s.name} is priced per session (${s.basis}).`);

  // Try to find a matching bundle (same component ids, order-independent)
  const serviceIdSet = new Set(seen);
  const matchedBundle = BUNDLES.find((b) => {
    if (b.componentIds.length !== serviceIdSet.size) return false;
    return b.componentIds.every((cid) => serviceIdSet.has(cid));
  }) ?? null;

  const hasDraftBundle = matchedBundle !== null && !matchedBundle.approved;

  return {
    services,
    individualTotal,
    matchedBundle: matchedBundle?.approved ? matchedBundle : null,
    hasDraftBundle,
    sessionNotes,
  };
}

// ---------------------------------------------------------------------------
// Price breakdown formatter (used by the system prompt section)
// ---------------------------------------------------------------------------

/**
 * Format a price breakdown string suitable for WhatsApp.
 * Calls sumServices() for arithmetic — never multiplies session rates.
 *
 * @param {string[]} serviceIds
 * @returns {{ lines: string[], total: number }}
 */
export function formatPriceBreakdown(serviceIds) {
  const lines = serviceIds.map((id) => {
    const svc = SERVICES[id];
    if (!svc) throw new Error(`Unknown service id: "${id}"`);
    return `• ${svc.name} — ₹${svc.price.toLocaleString('en-IN')} (${svc.basis})`;
  });
  const total = sumServices(serviceIds);
  return { lines, total };
}

// ---------------------------------------------------------------------------
// Bundle prompt text
// ---------------------------------------------------------------------------

/**
 * Returns the text block that describes all approved bundles.
 * Returns an empty string when no bundles are approved yet.
 *
 * @returns {string}
 */
export function approvedBundlesText() {
  const approved = getApprovedBundles();
  if (approved.length === 0) return '';

  const lines = ['### Currently Available Bundles\n'];
  for (const b of approved) {
    const components = b.componentIds
      .map((id) => SERVICES[id]?.name ?? id)
      .join(', ');
    lines.push(
      `**${b.name}**\n` +
      `Components: ${components}\n` +
      `Individual total: ₹${b.individualTotal.toLocaleString('en-IN')}\n` +
      `Bundle price: ₹${b.bundlePrice.toLocaleString('en-IN')}\n` +
      (b.sessionNote ? `Note: ${b.sessionNote}\n` : '') +
      `---`
    );
  }
  return lines.join('\n');
}
