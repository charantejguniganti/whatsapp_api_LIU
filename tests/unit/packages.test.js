/**
 * Unit tests: Package catalogue, bundle arithmetic, and package recommender.
 *
 * Covers:
 * - Bundle individualTotal === sum of component prices (all 4 bundles)
 * - sumServices() correct arithmetic
 * - sumServices() throws on unknown service id
 * - getApprovedBundles() returns empty when all bundles are drafts
 * - recommendServices() returns services for known goal keywords
 * - recommendServices() returns empty for unrecognised goal text
 * - recommendServices() does NOT expose bundle price for draft bundles
 * - recommendServices() DOES expose bundle price for approved bundles
 * - recommendServices() emits session notes for session-based services
 * - formatPriceBreakdown() produces correct lines and total
 * - formatPriceBreakdown() throws on unknown service id
 * - Personal Shopping disambiguation (Section A vs Section F rates)
 * - Mixed-intent message (grooming + wellness keywords)
 * - approvedBundlesText() returns empty-state message when none approved
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  SERVICES,
  BUNDLES,
  sumServices,
  getService,
  getBundle,
  getApprovedBundles,
} from '../../src/knowledge/packages.js';

import {
  recommendServices,
  formatPriceBreakdown,
  approvedBundlesText,
  GOAL_MAPPINGS,
} from '../../src/ai/packageRecommender.js';

// ---------------------------------------------------------------------------
// Helper: temporarily patch a bundle's approved flag for a single test
// ---------------------------------------------------------------------------
function withApproved(bundleId, fn) {
  const bundle = BUNDLES.find((b) => b.id === bundleId);
  const original = bundle.approved;
  bundle.approved = true;
  try { return fn(); }
  finally { bundle.approved = original; }
}

// ============================================================================
// 1. Bundle arithmetic — individualTotal must equal sum of component prices
// ============================================================================
describe('Bundle arithmetic integrity', () => {
  it.each(BUNDLES)(
    'bundle "$id" individualTotal matches sum of component prices',
    (bundle) => {
      const computed = sumServices(bundle.componentIds);
      expect(computed).toBe(bundle.individualTotal);
    }
  );
});

// ============================================================================
// 2. sumServices
// ============================================================================
describe('sumServices()', () => {
  it('sums two services correctly', () => {
    // Image Consulting (5000) + Communication Skills (3000) = 8000
    expect(sumServices(['imageConsulting', 'communicationSkills'])).toBe(8000);
  });

  it('sums three services correctly', () => {
    // Yoga (1500) + Sound Healing (2500) + Nutrition (2500) = 6500
    expect(sumServices(['yoga', 'soundHealingMeditation', 'nutritionConsultation'])).toBe(6500);
  });

  it('returns 0 for an empty array', () => {
    expect(sumServices([])).toBe(0);
  });

  it('throws for an unknown service id', () => {
    expect(() => sumServices(['imageConsulting', 'unknownServiceXYZ'])).toThrow(
      /Unknown service id.*unknownServiceXYZ/i
    );
  });

  it('throws for a completely unknown array', () => {
    expect(() => sumServices(['fakeService'])).toThrow(/Unknown service id/i);
  });
});

// ============================================================================
// 3. Catalogue lookups
// ============================================================================
describe('getService()', () => {
  it('returns a service object for a known id', () => {
    const svc = getService('imageConsulting');
    expect(svc).toBeDefined();
    expect(svc.price).toBe(5000);
    expect(svc.basis).toBe('60 minutes');
  });

  it('returns undefined for an unknown id', () => {
    expect(getService('notAService')).toBeUndefined();
  });
});

describe('getBundle()', () => {
  it('returns a bundle for a known id', () => {
    const b = getBundle('executivePresence');
    expect(b).toBeDefined();
    expect(b.bundlePrice).toBe(10000);
  });

  it('returns undefined for an unknown bundle id', () => {
    expect(getBundle('nonExistentBundle')).toBeUndefined();
  });
});

// ============================================================================
// 4. Draft bundles — all four must start as unapproved
// ============================================================================
describe('getApprovedBundles()', () => {
  it('returns no bundles when all are drafts (default state)', () => {
    const approved = getApprovedBundles();
    expect(approved).toHaveLength(0);
  });

  it('returns only approved bundles when one is flipped', () => {
    withApproved('executivePresence', () => {
      const approved = getApprovedBundles();
      expect(approved).toHaveLength(1);
      expect(approved[0].id).toBe('executivePresence');
    });
  });
});

// ============================================================================
// 5. Service-price disambiguation — Personal Shopping
// ============================================================================
describe('Personal Shopping disambiguation', () => {
  it('Section A personal shopping costs Rs15,000 for 3 hours', () => {
    expect(SERVICES.personalShopping.price).toBe(15000);
    expect(SERVICES.personalShopping.basis).toBe('3 hours');
    expect(SERVICES.personalShopping.section).toBe('A');
  });

  it('Section F consulting personal shopping is Rs1,200 per hour', () => {
    expect(SERVICES.personalShoppingConsulting.price).toBe(1200);
    expect(SERVICES.personalShoppingConsulting.section).toBe('F');
    expect(SERVICES.personalShoppingConsulting.note).toMatch(/confuse/i);
  });

  it('the two personal shopping services have different prices', () => {
    expect(SERVICES.personalShopping.price).not.toBe(
      SERVICES.personalShoppingConsulting.price
    );
  });
});

// ============================================================================
// 6. recommendServices()
// ============================================================================
describe('recommendServices()', () => {
  it('returns relevant services for an executive-presence goal', () => {
    const result = recommendServices('I want to build my executive presence');
    const ids = result.services.map((s) => s.id);
    expect(ids).toContain('imageConsulting');
    expect(ids).toContain('communicationSkills');
    expect(ids).toContain('postureBodyLanguage');
    expect(result.individualTotal).toBeGreaterThan(0);
  });

  it('returns relevant services for a style/wardrobe goal', () => {
    const result = recommendServices('Help me with my wardrobe and personal style');
    const ids = result.services.map((s) => s.id);
    expect(ids).toContain('imageScope');
    expect(ids).toContain('wearYourColor');
    expect(ids).toContain('wardrobeEvaluation');
  });

  it('returns relevant services for a wellness goal', () => {
    const result = recommendServices('I need a wellness reset and balance');
    const ids = result.services.map((s) => s.id);
    expect(ids).toContain('yoga');
    expect(ids).toContain('soundHealingMeditation');
    expect(ids).toContain('nutritionConsultation');
  });

  it('returns an empty services array for unrecognised goal text', () => {
    const result = recommendServices('blarghnorf frazzlewick');
    expect(result.services).toHaveLength(0);
    expect(result.individualTotal).toBe(0);
  });

  it('individual total equals the sum of all recommended service prices', () => {
    const result = recommendServices('improve my communication and posture');
    const computed = result.services.reduce((sum, s) => sum + s.price, 0);
    expect(result.individualTotal).toBe(computed);
  });

  // ── Draft bundle guard ───────────────────────────────────────────────────
  it('does NOT expose matchedBundle when bundle is still a draft', () => {
    // Executive Presence exact match — bundle is draft
    const result = recommendServices(
      'I want image consulting communication skills and posture body language'
    );
    expect(result.matchedBundle).toBeNull();
    expect(result.hasDraftBundle).toBe(true);
  });

  it('DOES expose matchedBundle after the bundle is approved', () => {
    withApproved('executivePresence', () => {
      const result = recommendServices(
        'I want image consulting communication skills and posture body language'
      );
      expect(result.matchedBundle).not.toBeNull();
      expect(result.matchedBundle.id).toBe('executivePresence');
      expect(result.matchedBundle.bundlePrice).toBe(10000);
    });
  });

  // ── Session notes ────────────────────────────────────────────────────────
  it('emits session notes for session-based services', () => {
    const result = recommendServices('I want yoga and sound healing');
    expect(result.sessionNotes.length).toBeGreaterThan(0);
    expect(result.sessionNotes[0]).toMatch(/per session/i);
  });

  it('emits no session notes for non-session-based services', () => {
    const result = recommendServices('image consulting communication skills');
    expect(result.sessionNotes).toHaveLength(0);
  });

  // ── Mixed-intent ─────────────────────────────────────────────────────────
  it('handles mixed grooming + wellness keywords in one message', () => {
    const result = recommendServices(
      'I want to improve my image and also do some meditation and nutrition'
    );
    const ids = result.services.map((s) => s.id);
    // Should include at least one grooming and one wellness service
    const hasGrooming = ids.some((id) =>
      ['imageConsulting', 'imageScope', 'communicationSkills', 'postureBodyLanguage'].includes(id)
    );
    const hasWellness = ids.some((id) =>
      ['soundHealingMeditation', 'nutritionConsultation', 'yoga'].includes(id)
    );
    expect(hasGrooming).toBe(true);
    expect(hasWellness).toBe(true);
    // Total must equal the arithmetic sum
    const computed = result.services.reduce((sum, s) => sum + s.price, 0);
    expect(result.individualTotal).toBe(computed);
  });

  it('handles a message that contains only session-based services', () => {
    const result = recommendServices('yoga and dance');
    expect(result.sessionNotes.length).toBeGreaterThanOrEqual(1);
    result.services.forEach((s) => {
      expect(s.basis).toMatch(/per session/i);
    });
  });
});

// ============================================================================
// 7. formatPriceBreakdown()
// ============================================================================
describe('formatPriceBreakdown()', () => {
  it('produces one bullet line per service', () => {
    const { lines, total } = formatPriceBreakdown([
      'imageConsulting',
      'communicationSkills',
      'postureBodyLanguage',
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/Image Consulting/);
    expect(lines[0]).toMatch(/5,000/);
  });

  it('total equals sum of the listed service prices', () => {
    const { total } = formatPriceBreakdown(['yoga', 'soundHealingMeditation', 'nutritionConsultation']);
    expect(total).toBe(6500);
  });

  it('throws for an unknown service id', () => {
    expect(() => formatPriceBreakdown(['imageConsulting', 'ghost'])).toThrow(
      /Unknown service id.*ghost/i
    );
  });
});

// ============================================================================
// 8. approvedBundlesText()
// ============================================================================
describe('approvedBundlesText()', () => {
  it('returns a no-bundles message when all bundles are drafts', () => {
    const text = approvedBundlesText();
    expect(text).toBe('');  // empty string — caller wraps it
  });

  it('returns bundle details when a bundle is approved', () => {
    withApproved('personalStyleMakeover', () => {
      const text = approvedBundlesText();
      expect(text).toContain('Personal Style Makeover Bundle');
      expect(text).toContain('7,500');
    });
  });

  it('includes session note in output when present', () => {
    withApproved('wellnessReset', () => {
      const text = approvedBundlesText();
      expect(text).toContain('per-session');
    });
  });
});

// ============================================================================
// 9. GOAL_MAPPINGS structural integrity
// ============================================================================
describe('GOAL_MAPPINGS integrity', () => {
  it('every service id referenced in goal mappings exists in SERVICES', () => {
    const knownIds = new Set(Object.keys(SERVICES));
    for (const mapping of GOAL_MAPPINGS) {
      for (const id of mapping.serviceIds) {
        expect(knownIds.has(id), `Unknown service id "${id}" in GOAL_MAPPINGS`).toBe(true);
      }
    }
  });

  it('every component id in every BUNDLE exists in SERVICES', () => {
    const knownIds = new Set(Object.keys(SERVICES));
    for (const bundle of BUNDLES) {
      for (const id of bundle.componentIds) {
        expect(knownIds.has(id), `Unknown component id "${id}" in bundle "${bundle.id}"`).toBe(true);
      }
    }
  });
});
