/**
 * questionnaire/responseGenerator.js
 *
 * Converts the structured analysis result into a natural, warm WhatsApp reply.
 * Also provides the welcome message and question-transition messages.
 */

import { formatQuestion, QUESTIONS } from './questions.js';

// ---------------------------------------------------------------------------
// Welcome messages (split into 3 sequential parts)
// ---------------------------------------------------------------------------

export const WELCOME_INTRO = `Hello! Welcome to Live It Up (LIU). 🌟`;

export const WELCOME_QUESTIONS_PREP =
  `I'm *Liv*, your personal assistant. I'd love to understand your goals and help you discover the right experience for you.\n\n` +
  `I have just *a few quick questions* to personalise your experience. Let's get started! 😊`;

export const WELCOME_MESSAGE = `${WELCOME_INTRO}\n\n${WELCOME_QUESTIONS_PREP}`;

/**
 * Returns the 3 sequential welcome messages:
 * 1. Intro greeting
 * 2. Assistant description & questions notice
 * 3. Question 1
 * @returns {string[]}
 */
export function getWelcomeMessages() {
  return [
    WELCOME_INTRO,
    WELCOME_QUESTIONS_PREP,
    formatQuestion(QUESTIONS[0]),
  ];
}

// ---------------------------------------------------------------------------
// Question messages
// ---------------------------------------------------------------------------

/**
 * Returns the full welcome + first question message as a single string.
 */
export function buildWelcomeAndQ1() {
  return getWelcomeMessages().join('\n\n');
}

/**
 * Returns just the formatted question message.
 * @param {import('./questions.js').Question} question
 * @param {number} [total] - Total questions this customer sees (8 if Q8 skipped, 9 otherwise)
 */
export function buildQuestionMessage(question, total) {
  return formatQuestion(question, total);
}

/**
 * Returns the "Other" prompt for a question.
 */
export function buildOtherPrompt() {
  return `Of course! 😊 Please tell me a little more about what you're looking for.`;
}

// ---------------------------------------------------------------------------
// Final recommendation message
// ---------------------------------------------------------------------------

/**
 * Build the personalised recommendation WhatsApp message from the analysis.
 *
 * @param {object} analysis - Output from analyseAnswers()
 * @param {object} answers  - Raw answers for personalisation
 * @returns {string}
 */
export function buildRecommendationMessage(analysis, answers) {
  const { customerProfile, analysis: a, nextAction } = analysis;

  const interest = customerProfile.interest || answers.interest || 'personal development';
  const goal = customerProfile.primaryGoal || answers.primaryGoal || 'your goals';
  const learning = customerProfile.learningPreference || answers.learningPreference || '';
  const timeline = customerProfile.startTimeline || answers.startTimeline || '';
  const recommended = a.recommendedService || 'a personalised LIU programme';
  const reason = a.reasonForRecommendation || '';
  const duration = a.recommendedDuration || '';

  const lines = [
    `Thank you so much for sharing your preferences! 🙏\n`,
    `Based on your answers, here's what I understand about you:\n`,
    `🎯 *Area of Interest:* ${interest}`,
    `🌟 *Primary Goal:* ${goal}`,
  ];

  if (learning) lines.push(`📚 *Learning Preference:* ${learning}`);
  if (timeline) lines.push(`⏰ *Starting:* ${timeline}`);
  if (duration) lines.push(`📅 *Preferred Duration:* ${duration}`);

  // New fields
  const budget = answers.budget;
  const brandConscious = answers.brandConscious;
  const brandPreference = answers.brandPreference;
  if (budget) lines.push(`💰 *Budget:* ${budget}`);
  if (brandConscious) lines.push(`🏷️ *Brand Conscious:* ${brandConscious}`);
  if (brandPreference && brandPreference !== 'No') lines.push(`👗 *Brand Preference:* ${brandPreference}`);

  lines.push(`\n✨ *My Recommendation:*\n${recommended}`);

  if (reason && reason.length < 300) {
    lines.push(`\n_${reason}_`);
  }

  if (nextAction?.type === 'IMMEDIATE_FOLLOWUP') {
    lines.push(
      `\n🤝 Based on your timeline, I'd love to connect you with our LIU consultant right away!\n\n` +
      `Would you like me to arrange that? Just reply *Yes* and someone from our team will reach out to you shortly.`
    );
  } else {
    lines.push(
      `\n💬 Would you like to explore this further or speak with our LIU consultant?\n\n` +
      `Reply *Yes* to connect with our team, or feel free to ask me any questions!`
    );
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// System/command replies
// ---------------------------------------------------------------------------

export const RESTART_REPLY =
  `✅ Let's start fresh! I'll ask you the questions again.\n\n`;

export const CANCEL_REPLY =
  `No problem! 😊 Your questionnaire has been cancelled.\n\n` +
  `Feel free to message me any time if you'd like to explore LIU's services. We're always here! 🌟`;

export const HUMAN_REPLY =
  `🙌 Absolutely! I'm connecting you with the LIU team right now.\n\n` +
  `Someone will reach out to you shortly. In the meantime, you can also email us at *hello@liveitup.in*.`;

export const UNRELATED_REPLY =
  `😊 Thanks for your message! I'll keep your questionnaire progress saved — ` +
  `let's continue when you're ready.\n\n`;

