/**
 * questionnaire/answerValidator.js
 *
 * Validates a customer's raw WhatsApp reply against the current question.
 *
 * Accepts:
 *  - Single letter  : "A", "b", "C"
 *  - Full option text (case-insensitive, trimmed)
 *
 * Returns:
 *  { valid: true,  letter, text, isOther }  — when answer is valid
 *  { valid: false }                          — when answer is invalid
 */

import { QUESTIONS } from './questions.js';

/**
 * Helper to determine if an option triggers the free-text "Other" flow.
 * @param {import('./questions.js').Question} question
 * @param {import('./questions.js').Option} option
 * @returns {boolean}
 */
function isOtherOption(question, option) {
  if (option.isOther) return true;
  const lower = option.text.toLowerCase();
  return lower.startsWith('other') || (question.key === 'additionalQuestions' && option.letter === 'A');
}

/**
 * @param {import('./questions.js').Question} question
 * @param {string} rawInput
 * @returns {{ valid: boolean, letter?: string, text?: string, isOther?: boolean }}
 */
export function validateAnswer(question, rawInput) {
  const trimmed = rawInput.trim();
  if (!trimmed) return { valid: false };

  const upper = trimmed.toUpperCase();

  // 1. Try single-letter match
  const byLetter = question.options.find((o) => o.letter === upper);
  if (byLetter) {
    return {
      valid: true,
      letter: byLetter.letter,
      text: byLetter.text,
      isOther: isOtherOption(question, byLetter),
    };
  }

  // 2. Try full-text match (case-insensitive, ignore punctuation differences)
  const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const normInput = normalise(trimmed);
  const byText = question.options.find(
    (o) => normalise(o.text) === normInput
  );
  if (byText) {
    return {
      valid: true,
      letter: byText.letter,
      text: byText.text,
      isOther: isOtherOption(question, byText),
    };
  }

  // 3. Partial match — input must contain the core option text words
  const byPartial = question.options.find((o) => {
    const coreText = normalise(o.text.replace(/\(.*\)/, '')); // strip parenthetical
    return coreText.length > 3 && normInput.includes(coreText);
  });
  if (byPartial) {
    return {
      valid: true,
      letter: byPartial.letter,
      text: byPartial.text,
      isOther: isOtherOption(question, byPartial),
    };
  }

  return { valid: false };
}

/**
 * Build the "invalid answer" reprompt message for a question.
 * @param {import('./questions.js').Question} question
 * @returns {string}
 */
export function buildInvalidReply(question) {
  const validLetters = question.options.map((o) => o.letter).join(', ');
  return (
    `😊 I didn't quite catch that! Please reply with one of the options below:\n\n` +
    `Valid choices: *${validLetters}*\n\n` +
    question.options.map((o) => `${o.letter}. ${o.text}`).join('\n')
  );
}

