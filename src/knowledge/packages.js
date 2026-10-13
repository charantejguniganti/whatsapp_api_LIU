/**
 * LIU Package & Bundle Catalogue
 *
 * SOURCE OF TRUTH for all service prices and proposed bundles.
 *
 * Rules:
 * - Prices come verbatim from the two LIU pricing PDFs.
 * - A bundle with `approved: false` is a DRAFT. The assistant MUST NOT
 *   advertise the bundle price to customers until LIU sets `approved: true`.
 * - Never add a bundle without a matching, verified component list.
 * - `individualTotal` must equal the sum of the component prices — the
 *   test suite enforces this automatically.
 *
 * Updating prices:
 *   Change the price in SERVICES and re-run the test suite. Any bundle
 *   whose `individualTotal` no longer matches the component sum will fail,
 *   prompting you to review the bundle discount too.
 */

// ---------------------------------------------------------------------------
// Individual service catalogue
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Service
 * @property {string}  id      - Unique slug (camelCase)
 * @property {string}  name    - Display name
 * @property {number}  price   - Price in INR
 * @property {string}  basis   - Human-readable pricing basis
 * @property {string}  section - Source section (A-F from pricing PDFs)
 * @property {string}  [note]  - Optional caveat surfaced to the assistant
 */

/** @type {Record<string, Service>} */
export const SERVICES = {
  // Section A: Grooming & Image Consulting
  personalShopping: {
    id: 'personalShopping',
    name: 'Personal Shopping',
    price: 15000,
    basis: '3 hours',
    section: 'A',
    note: 'Do not confuse with the consulting Personal Shopping rate (Rs1,200/hr) in Section F.',
  },
  personalShoppingAddon: {
    id: 'personalShoppingAddon',
    name: 'Personal Shopping (add-on)',
    price: 2000,
    basis: 'Per additional hour',
    section: 'A',
  },
  imageConsulting: {
    id: 'imageConsulting',
    name: 'Image Consulting',
    price: 5000,
    basis: '60 minutes',
    section: 'A',
  },
  imageConsultingAddon: {
    id: 'imageConsultingAddon',
    name: 'Image Consulting (add-on)',
    price: 1000,
    basis: 'Per additional hour',
    section: 'A',
  },
  communicationSkills: {
    id: 'communicationSkills',
    name: 'Communication Skills',
    price: 3000,
    basis: '60 minutes',
    section: 'A',
  },
  communicationSkillsAddon: {
    id: 'communicationSkillsAddon',
    name: 'Communication Skills (add-on)',
    price: 1000,
    basis: 'Per additional hour',
    section: 'A',
  },
  etiquetteSoftSkills: {
    id: 'etiquetteSoftSkills',
    name: 'Etiquette / Soft Skills',
    price: 3000,
    basis: '60 minutes',
    section: 'A',
  },
  etiquetteSoftSkillsAddon: {
    id: 'etiquetteSoftSkillsAddon',
    name: 'Etiquette / Soft Skills (add-on)',
    price: 1000,
    basis: 'Per additional hour',
    section: 'A',
  },
  postureBodyLanguage: {
    id: 'postureBodyLanguage',
    name: 'Posture & Body Language',
    price: 3000,
    basis: '60 minutes',
    section: 'A',
  },
  postureBodyLanguageAddon: {
    id: 'postureBodyLanguageAddon',
    name: 'Posture & Body Language (add-on)',
    price: 1000,
    basis: 'Per additional hour',
    section: 'A',
  },

  // Section B: Wellness Services
  reformerAddon: {
    id: 'reformerAddon',
    name: 'Reformer Add-on',
    price: 1500,
    basis: 'Per session add-on',
    section: 'B',
  },
  onlineBarrePilates: {
    id: 'onlineBarrePilates',
    name: 'Online Barre & Pilates',
    price: 1000,
    basis: 'Per hour',
    section: 'B',
  },

  // Section D: Private 1:1 Services
  yoga: {
    id: 'yoga',
    name: 'Yoga',
    price: 1500,
    basis: 'Per session',
    section: 'D',
  },
  dance: {
    id: 'dance',
    name: 'Dance',
    price: 1500,
    basis: 'Per session',
    section: 'D',
  },
  soundHealingMeditation: {
    id: 'soundHealingMeditation',
    name: 'Sound Healing / Meditation',
    price: 2500,
    basis: 'Per session',
    section: 'D',
  },
  nutritionConsultation: {
    id: 'nutritionConsultation',
    name: 'Nutrition Consultation',
    price: 2500,
    basis: 'Per consultation',
    section: 'D',
  },

  // Section F: One-on-One Image Consulting
  imageScope: {
    id: 'imageScope',
    name: 'Image Scope',
    price: 1500,
    basis: '1 hour',
    section: 'F',
  },
  lookThePart: {
    id: 'lookThePart',
    name: 'Look the Part',
    price: 3000,
    basis: '2.5 hours',
    section: 'F',
  },
  styleYourShape: {
    id: 'styleYourShape',
    name: 'Style Your Shape & Shape Your Style',
    price: 3000,
    basis: '2.5 hours',
    section: 'F',
  },
  wearYourColor: {
    id: 'wearYourColor',
    name: 'Wear Your Color',
    price: 3000,
    basis: '2.5 hours',
    section: 'F',
  },
  discoverYourIndividuality: {
    id: 'discoverYourIndividuality',
    name: 'Discover Your Individuality Through Personal Style',
    price: 4000,
    basis: '3 hours',
    section: 'F',
  },
  wardrobeEvaluation: {
    id: 'wardrobeEvaluation',
    name: 'Wardrobe Evaluation & the Art of Clustering',
    price: 4000,
    basis: '3 hours',
    section: 'F',
  },
  diningEtiquette: {
    id: 'diningEtiquette',
    name: 'Dining Etiquette',
    price: 5000,
    basis: '4 hours',
    section: 'F',
  },
  personalShoppingConsulting: {
    id: 'personalShoppingConsulting',
    name: 'Personal Shopping Services (consulting)',
    price: 1200,
    basis: 'Per hour — duration depends on requirements',
    section: 'F',
    note: 'Hourly rate; do not confuse with Section A Personal Shopping (Rs15,000 for 3 hours).',
  },
  makeupGrooming: {
    id: 'makeupGrooming',
    name: 'Make-up, Face Shape Evaluation & Personal Grooming',
    price: 6000,
    basis: '6 hours',
    section: 'F',
  },
  makeupShopping: {
    id: 'makeupShopping',
    name: 'Personalized Make-up Shopping',
    price: 800,
    basis: 'Per hour — duration depends on requirements',
    section: 'F',
  },
  comprehensivePackage: {
    id: 'comprehensivePackage',
    name: 'One-on-One Consulting Comprehensive Package',
    price: 22000,
    basis: '20 hours (all consulting services + 4 hrs personal shopping + quick reference guide)',
    section: 'F',
  },
  briefPackage: {
    id: 'briefPackage',
    name: 'One-on-One Consulting Brief Package',
    price: 2000,
    basis: '5 hours (Image Scope, abridged Look the Part, body shape, colour & face shape)',
    section: 'F',
  },
};

// ---------------------------------------------------------------------------
// Proposed bundles
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Bundle
 * @property {string}   id              - Unique slug
 * @property {string}   name            - Marketing name
 * @property {string}   description     - One-line description
 * @property {string[]} componentIds    - Keys into SERVICES
 * @property {number}   individualTotal - Sum of component prices (verified by tests)
 * @property {number}   bundlePrice     - Proposed discounted price
 * @property {boolean}  approved        - Set true only when LIU confirms the offer
 * @property {string}   [sessionNote]   - Shown when any component is session-based
 */

/** @type {Bundle[]} */
export const BUNDLES = [
  {
    id: 'executivePresence',
    name: 'Executive Presence Bundle',
    description:
      'Image Consulting + Communication Skills + Posture & Body Language — ' +
      'ideal for professionals aiming to build executive presence.',
    componentIds: ['imageConsulting', 'communicationSkills', 'postureBodyLanguage'],
    individualTotal: 11000,
    bundlePrice: 10000,
    approved: false,
  },
  {
    id: 'personalStyleMakeover',
    name: 'Personal Style Makeover Bundle',
    description:
      'Image Scope + Wear Your Color + Wardrobe Evaluation & the Art of Clustering — ' +
      'a complete personal style overhaul.',
    componentIds: ['imageScope', 'wearYourColor', 'wardrobeEvaluation'],
    individualTotal: 8500,
    bundlePrice: 7500,
    approved: false,
  },
  {
    id: 'wellnessReset',
    name: 'Wellness Reset Bundle',
    description:
      'Yoga (1 session) + Sound Healing / Meditation (1 session) + Nutrition Consultation — ' +
      'reset your mind, body, and habits.',
    componentIds: ['yoga', 'soundHealingMeditation', 'nutritionConsultation'],
    individualTotal: 6500,
    bundlePrice: 5900,
    approved: false,
    sessionNote:
      'Yoga and Sound Healing / Meditation are per-session services — ' +
      'the bundle price covers one session of each.',
  },
  {
    id: 'completeTransformation',
    name: 'Complete Transformation Bundle',
    description:
      'Image Consulting + Communication Skills + Posture & Body Language + ' +
      'Sound Healing / Meditation (1 session) + Nutrition Consultation.',
    componentIds: [
      'imageConsulting',
      'communicationSkills',
      'postureBodyLanguage',
      'soundHealingMeditation',
      'nutritionConsultation',
    ],
    individualTotal: 16000,
    bundlePrice: 15000,
    approved: false,
    sessionNote:
      'Sound Healing / Meditation is a per-session service — the bundle price covers one session.',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up a service by id. Returns undefined for unknown ids.
 * @param {string} id
 * @returns {Service|undefined}
 */
export function getService(id) {
  return SERVICES[id];
}

/**
 * Look up a bundle by id. Returns undefined for unknown ids.
 * @param {string} id
 * @returns {Bundle|undefined}
 */
export function getBundle(id) {
  return BUNDLES.find((b) => b.id === id);
}

/**
 * Return only the bundles that LIU has approved.
 * @returns {Bundle[]}
 */
export function getApprovedBundles() {
  return BUNDLES.filter((b) => b.approved);
}

/**
 * Calculate the sum of prices for an array of service ids.
 * Throws if any id is not found in SERVICES.
 *
 * @param {string[]} serviceIds
 * @returns {number} Total in INR
 */
export function sumServices(serviceIds) {
  return serviceIds.reduce((total, id) => {
    const svc = SERVICES[id];
    if (!svc) throw new Error(`Unknown service id: "${id}"`);
    return total + svc.price;
  }, 0);
}
