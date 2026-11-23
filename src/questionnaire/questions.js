/**
 * questionnaire/questions.js
 *
 * Single source of truth for the LIU WhatsApp questionnaire.
 * Each question has a key, display text, valid option letters,
 * the full option map, and the state machine state names.
 */

/** @typedef {{ letter: string, text: string }} Option */
/** @typedef {{ key: string, number: number, text: string, options: Option[], awaitState: string, otherState: string }} Question */

/** @type {Question[]} */
export const QUESTIONS = [
  {
    key: 'interest',
    number: 1,
    text: 'What would you like to improve or explore?',
    awaitState: 'AWAITING_Q1',
    otherState: 'AWAITING_Q1_OTHER',
    options: [
      { letter: 'A', text: 'Personal Styling & Fashion' },
      { letter: 'B', text: 'Grooming & Self-Care' },
      { letter: 'C', text: 'Personality Development' },
      { letter: 'D', text: 'Professional Image & Confidence' },
      { letter: 'E', text: 'Communication Skills' },
      { letter: 'F', text: 'Corporate Wellness & Development' },
      { letter: 'G', text: 'Other (Please specify)' },
    ],
  },
  {
    key: 'primaryGoal',
    number: 2,
    text: 'What is your primary goal?',
    awaitState: 'AWAITING_Q2',
    otherState: 'AWAITING_Q2_OTHER',
    options: [
      { letter: 'A', text: 'Improve my overall appearance' },
      { letter: 'B', text: 'Build self-confidence' },
      { letter: 'C', text: 'Develop better communication skills' },
      { letter: 'D', text: 'Create a strong professional presence' },
      { letter: 'E', text: 'Prepare for an important occasion' },
      { letter: 'F', text: 'Achieve an overall personal transformation' },
      { letter: 'G', text: 'Other (Please specify)' },
    ],
  },
  {
    key: 'learningPreference',
    number: 3,
    text: 'How would you prefer to learn?',
    awaitState: 'AWAITING_Q3',
    otherState: 'AWAITING_Q3_OTHER',
    options: [
      { letter: 'A', text: 'One-on-one personalised coaching' },
      { letter: 'B', text: 'Structured learning programme' },
      { letter: 'C', text: 'Practical workshops and activities' },
      { letter: 'D', text: 'Group sessions' },
      { letter: 'E', text: 'Self-paced learning' },
      { letter: 'F', text: 'Need expert guidance to decide' },
      { letter: 'G', text: 'Other (Please specify)' },
    ],
  },
  {
    key: 'startTimeline',
    number: 4,
    text: 'When would you like to start?',
    awaitState: 'AWAITING_Q4',
    otherState: 'AWAITING_Q4_OTHER',
    options: [
      { letter: 'A', text: 'Immediately' },
      { letter: 'B', text: 'Within 7 days' },
      { letter: 'C', text: 'Within 15 days' },
      { letter: 'D', text: 'Within 30 days' },
      { letter: 'E', text: 'Just exploring for now' },
      { letter: 'F', text: 'Other (Please specify)' },
    ],
  },
  {
    key: 'preferredDuration',
    number: 5,
    text: 'What programme duration would suit you best?',
    awaitState: 'AWAITING_Q5',
    otherState: 'AWAITING_Q5_OTHER',
    options: [
      { letter: 'A', text: '3 Days – Quick Learning' },
      { letter: 'B', text: '7 Days – Short-Term Programme' },
      { letter: 'C', text: '15 Days – Focused Development' },
      { letter: 'D', text: '30 Days – Structured Development' },
      { letter: 'E', text: '45 Days – Advanced Learning' },
      { letter: 'F', text: '60 Days – Extended Development' },
      { letter: 'G', text: 'Help me choose the right duration' },
      { letter: 'H', text: 'Other (Please specify)' },
    ],
  },
  {
    key: 'budget',
    number: 6,
    text: 'What is your budget for this programme?',
    awaitState: 'AWAITING_Q6',
    otherState: 'AWAITING_Q6_OTHER',
    options: [
      { letter: 'A', text: 'Up to ₹25,000 (5 Sessions)' },
      { letter: 'B', text: '₹25,000 – ₹50,000' },
      { letter: 'C', text: '₹50,000 – ₹1,00,000' },
      { letter: 'D', text: '₹1,00,000 & above – Comprehensive Personalised Course' },
    ],
  },
  {
    key: 'brandConscious',
    number: 7,
    text: 'Are you brand conscious when it comes to fashion and personal style?',
    awaitState: 'AWAITING_Q7',
    otherState: 'AWAITING_Q7_OTHER',
    // NOTE: No "Other" here — Yes/No only. otherState is unused but kept for schema consistency.
    options: [
      { letter: 'A', text: 'Yes' },
      { letter: 'B', text: 'No' },
    ],
  },
  {
    key: 'brandPreference',
    number: 8,
    // Q8 is CONDITIONAL — only shown when brandConscious = Yes (Q7=A)
    text: 'Which fashion brands do you prefer or identify with?',
    awaitState: 'AWAITING_Q8',
    otherState: 'AWAITING_Q8_OTHER',
    options: [
      { letter: 'A', text: 'Zara' },
      { letter: 'B', text: 'H&M' },
      { letter: 'C', text: 'Vero Moda' },
      { letter: 'D', text: 'Rare Rabbit' },
      { letter: 'E', text: 'Celio' },
      { letter: 'F', text: 'Other (Please specify)' },
    ],
  },
  {
    key: 'additionalQuestions',
    number: 9,
    text: 'Do you have any other questions or anything else you\'d like to share with us?',
    awaitState: 'AWAITING_Q9',
    otherState: 'AWAITING_Q9_OTHER',
    options: [
      { letter: 'A', text: 'Yes, I have a question', isOther: true },
      { letter: 'B', text: 'No, I\'m all set' },
    ],
  },
];

/** Ordered list of all await-states for quick index lookups. */
export const AWAIT_STATES = QUESTIONS.map((q) => q.awaitState);

/** Ordered list of all other-states. */
export const OTHER_STATES = QUESTIONS.map((q) => q.otherState);

/** Lookup a question by its awaitState or otherState. */
export function getQuestionByState(state) {
  return QUESTIONS.find(
    (q) => q.awaitState === state || q.otherState === state
  ) ?? null;
}

/** Lookup a question by its key (e.g. 'interest'). */
export function getQuestionByKey(key) {
  return QUESTIONS.find((q) => q.key === key) ?? null;
}

/** Get the next question after the given one (null if last). */
export function getNextQuestion(currentQuestion) {
  const idx = QUESTIONS.indexOf(currentQuestion);
  return idx >= 0 && idx < QUESTIONS.length - 1 ? QUESTIONS[idx + 1] : null;
}

/**
 * Format a question as a WhatsApp message string.
 * totalQuestions is the number of questions this customer will actually see
 * (may be 8 instead of 9 when Q8 is skipped for non-brand-conscious customers).
 * @param {Question} question
 * @param {number} totalQuestions
 * @returns {string}
 */
export function formatQuestion(question, totalQuestions = QUESTIONS.length) {
  const header = `*Question ${question.number} of ${totalQuestions}*\n\n${question.text}\n`;
  const optionLines = question.options.map((o) => `${o.letter}. ${o.text}`).join('\n');
  return `${header}\n${optionLines}`;
}

