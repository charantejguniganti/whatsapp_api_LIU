/**
 * tests/unit/questionnaire.test.js
 *
 * Full test suite for the LIU WhatsApp Questionnaire system.
 * Covers all questions Q1–Q9 including conditional Q8 skip.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createQuestionnaireManager } from '../../src/questionnaire/stateManager.js';
import { validateAnswer, buildInvalidReply } from '../../src/questionnaire/answerValidator.js';
import { QUESTIONS, formatQuestion, getNextQuestion } from '../../src/questionnaire/questions.js';
import { analyseAnswers } from '../../src/questionnaire/analysisService.js';

// ---------------------------------------------------------------------------
// In-memory store mock
// ---------------------------------------------------------------------------

function createMemoryStore() {
  const data = new Map();
  return {
    async get(key) { return data.get(key) ?? null; },
    async set(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async keys(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
    _data: data,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Q1–Q9 answers with Q7=A (Yes/brand conscious) so Q8 is included
// Q1=A, Q2=B, Q3=A, Q4=A, Q5=D, Q6=B, Q7=A(Yes), Q8=C(Vero Moda), Q9=B(No)
const ALL_VALID_ANSWERS = ['A', 'B', 'A', 'A', 'D', 'B', 'A', 'C', 'B'];

async function completeQuiz(manager, phone, answers = ALL_VALID_ANSWERS) {
  // Greeting
  await manager.processMessage(phone, 'Hi');
  // Q1-Q9
  for (const ans of answers) {
    await manager.processMessage(phone, ans);
  }
}

// ---------------------------------------------------------------------------
// Test 1: Valid options for all nine questions (brand conscious = Yes → Q8 shown)
// ---------------------------------------------------------------------------

describe('Test 1 – Valid options for all nine questions', () => {
  it('completes the questionnaire with valid letter answers', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000001';

    const r1 = await manager.processMessage(phone, 'Hi');
    expect(r1).not.toBeNull();
    expect(r1.reply).toContain('Welcome to Live It Up');
    expect(r1.reply).toContain('Question 1');
    expect(r1.messages).toHaveLength(3);
    expect(r1.messages[0]).toContain('Hello! Welcome to Live It Up');
    expect(r1.messages[1]).toContain('Liv');
    expect(r1.messages[2]).toContain('Question 1 of 9');

    const r2 = await manager.processMessage(phone, 'A');
    expect(r2.reply).toContain('Question 2');

    const r3 = await manager.processMessage(phone, 'B');
    expect(r3.reply).toContain('Question 3');

    const r4 = await manager.processMessage(phone, 'C');
    expect(r4.reply).toContain('Question 4');

    const r5 = await manager.processMessage(phone, 'A');
    expect(r5.reply).toContain('Question 5');

    const r6 = await manager.processMessage(phone, 'D');
    expect(r6.reply).toContain('Question 6');

    // Q7 = A (Yes, brand conscious)
    const r7 = await manager.processMessage(phone, 'B'); // budget B
    expect(r7.reply).toContain('Question 7');

    const r8 = await manager.processMessage(phone, 'A'); // brandConscious = Yes
    expect(r8.reply).toContain('Question 8');

    const r9 = await manager.processMessage(phone, 'C'); // brandPreference = Vero Moda
    expect(r9.reply).toContain('Question 9');

    const r10 = await manager.processMessage(phone, 'B'); // additionalQuestions = No
    expect(r10.quizDone).toBe(true);
    expect(r10.reply).toContain('Thank you');

    // Session should be COMPLETED with all answers saved
    const session = await store.get(`quiz:${phone}`);
    expect(session.status).toBe('COMPLETED');
    expect(session.answers.interest).toBe('Personal Styling & Fashion');
    expect(session.answers.primaryGoal).toBe('Build self-confidence');
    expect(session.answers.budget).toBe('₹25,000 – ₹50,000');
    expect(session.answers.brandConscious).toBe('Yes');
    expect(session.answers.brandPreference).toBe('Vero Moda');
    expect(session.answers.additionalQuestions).toBe("No, I'm all set");
  });
});

// ---------------------------------------------------------------------------
// Test 2: Customer selects Other and provides custom text
// ---------------------------------------------------------------------------

describe('Test 2 – Other option with custom text', () => {
  it('handles Other selection and free-text input', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000002';

    await manager.processMessage(phone, 'Hello');
    // Q1 – select Other (G)
    const r2 = await manager.processMessage(phone, 'G');
    expect(r2.reply).toContain('tell me a little more');
    expect(r2.quizDone).toBe(false);

    // Provide free-text
    const r3 = await manager.processMessage(phone, 'I want to improve my public speaking skills');
    expect(r3.reply).toContain('Question 2');

    const session = await store.get(`quiz:${phone}`);
    expect(session.answers.interest).toContain('Other:');
    expect(session.otherResponses.interest).toBe('I want to improve my public speaking skills');
  });
});

// ---------------------------------------------------------------------------
// Test 3: Invalid answer – reprompt
// ---------------------------------------------------------------------------

describe('Test 3 – Invalid answer triggers reprompt', () => {
  it('reprompts on invalid input', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000003';

    await manager.processMessage(phone, 'Hi');

    // Invalid answer X
    const r = await manager.processMessage(phone, 'X');
    expect(r.quizDone).toBe(false);
    // Should still be on Q1
    const session = await store.get(`quiz:${phone}`);
    expect(session.quizState).toBe('AWAITING_Q1');
  });
});

// ---------------------------------------------------------------------------
// Test 4: Lowercase answers accepted
// ---------------------------------------------------------------------------

describe('Test 4 – Lowercase answers accepted', () => {
  it('accepts lowercase option letters', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000004';

    await manager.processMessage(phone, 'Hi');
    const r = await manager.processMessage(phone, 'a');
    expect(r.reply).toContain('Question 2');
  });
});

// ---------------------------------------------------------------------------
// Test 5: Full option text accepted
// ---------------------------------------------------------------------------

describe('Test 5 – Full option text accepted', () => {
  it('accepts full option text as answer', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000005';

    await manager.processMessage(phone, 'Hi');
    const r = await manager.processMessage(phone, 'Personal Styling & Fashion');
    expect(r.reply).toContain('Question 2');
  });
});

// ---------------------------------------------------------------------------
// Test 6: Q8 is SKIPPED when brand conscious = No (Q7 = B)
// ---------------------------------------------------------------------------

describe('Test 6 – Q8 skipped when brand conscious = No', () => {
  it('jumps from Q7 to Q9 when brandConscious = No', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000006';

    await manager.processMessage(phone, 'Hi');
    // Q1–Q6
    for (const ans of ['A', 'B', 'A', 'A', 'D', 'B']) {
      await manager.processMessage(phone, ans);
    }

    // Q7 = B (No, not brand conscious)
    const r = await manager.processMessage(phone, 'B');

    // Should jump to Q9 (not Q8)
    expect(r.reply).toContain('Question 9');

    const session = await store.get(`quiz:${phone}`);
    expect(session.quizState).toBe('AWAITING_Q9');
    expect(session.answers.brandPreference).toBeNull();
  });

  it('completes with Q8 skipped (8 questions total)', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000006b';

    await manager.processMessage(phone, 'Hi');
    // Q1–Q7: last answer B = No (skip Q8)
    for (const ans of ['A', 'B', 'A', 'A', 'D', 'B', 'B']) {
      await manager.processMessage(phone, ans);
    }
    // Q9
    const r = await manager.processMessage(phone, 'B');
    expect(r.quizDone).toBe(true);

    const session = await store.get(`quiz:${phone}`);
    expect(session.status).toBe('COMPLETED');
    expect(session.answers.brandPreference).toBeNull();
    expect(session.answers.additionalQuestions).toBe("No, I'm all set");
  });

  it('handles customer replying "Yes" after quiz completion to connect with team', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000006c';

    await manager.processMessage(phone, 'Hi');
    for (const ans of ['A', 'B', 'A', 'A', 'D', 'B', 'B', 'B']) {
      await manager.processMessage(phone, ans);
    }

    // Customer says "Yes" after receiving recommendations
    const postQuizReply = await manager.processMessage(phone, 'Yes');
    expect(postQuizReply).not.toBeNull();
    expect(postQuizReply.reply).toBe('Thanks for reaching out to Live It Up! 🌟 Our team will contact you soon.');
    expect(postQuizReply.handover).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Q9 "Yes, I have a question" triggers Other free-text flow
// ---------------------------------------------------------------------------

describe('Test 7 – Q9 "Yes" triggers free-text and completes quiz', () => {
  it('saves free-text question and completes quiz', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000007';

    await manager.processMessage(phone, 'Hi');
    // Q1-Q7 (Q7=A/Yes so Q8 shown)
    for (const ans of ['A', 'B', 'A', 'A', 'D', 'B', 'A']) {
      await manager.processMessage(phone, ans);
    }
    // Q8
    await manager.processMessage(phone, 'C');
    // Q9 = A (Yes, I have a question)
    const r9 = await manager.processMessage(phone, 'A');
    expect(r9.reply).toContain('tell me a little more');

    // Free-text question
    const r10 = await manager.processMessage(phone, 'What is the class schedule?');
    expect(r10.quizDone).toBe(true);

    const session = await store.get(`quiz:${phone}`);
    expect(session.status).toBe('COMPLETED');
    expect(session.answers.additionalQuestions).toContain('Other:');
    expect(session.otherResponses.additionalQuestions).toBe('What is the class schedule?');
  });
});

// ---------------------------------------------------------------------------
// Test 8: Multiple customers have independent sessions
// ---------------------------------------------------------------------------

describe('Test 8 – Multiple customers are independent', () => {
  it('tracks sessions independently', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);

    await manager.processMessage('+919000000008a', 'Hi');
    await manager.processMessage('+919000000008b', 'Hi');

    await manager.processMessage('+919000000008a', 'A');
    await manager.processMessage('+919000000008b', 'C');

    const s1 = await store.get('quiz:+919000000008a');
    const s2 = await store.get('quiz:+919000000008b');

    expect(s1.answers.interest).toBe('Personal Styling & Fashion');
    expect(s2.answers.interest).toBe('Personality Development');
    expect(s1.quizState).toBe('AWAITING_Q2');
    expect(s2.quizState).toBe('AWAITING_Q2');
  });
});

// ---------------------------------------------------------------------------
// Test 9: State persists (simulate restart)
// ---------------------------------------------------------------------------

describe('Test 9 – State persists across calls', () => {
  it('state is preserved after each message', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000009';

    await manager.processMessage(phone, 'Hi');
    await manager.processMessage(phone, 'B');

    const session = await store.get(`quiz:${phone}`);
    expect(session.quizState).toBe('AWAITING_Q2');
    expect(session.answers.interest).toBe('Grooming & Self-Care');
  });
});

// ---------------------------------------------------------------------------
// Test 10: RESTART command
// ---------------------------------------------------------------------------

describe('Test 10 – RESTART command', () => {
  it('resets the session and starts fresh', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000010';

    await manager.processMessage(phone, 'Hi');
    await manager.processMessage(phone, 'A');

    const r = await manager.processMessage(phone, 'RESTART');
    expect(r.reply).toContain('Question 1');

    const session = await store.get(`quiz:${phone}`);
    expect(session.answers.interest).toBeNull();
    expect(session.quizState).toBe('AWAITING_Q1');
    expect(session.currentQuestion).toBe(1);
    // All 9 answer fields reset to null
    expect(session.answers.budget).toBeNull();
    expect(session.answers.brandConscious).toBeNull();
    expect(session.answers.brandPreference).toBeNull();
    expect(session.answers.additionalQuestions).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 11: CANCEL command
// ---------------------------------------------------------------------------

describe('Test 11 – CANCEL command', () => {
  it('cancels the questionnaire gracefully', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000012';

    await manager.processMessage(phone, 'Hi');
    const r = await manager.processMessage(phone, 'CANCEL');
    expect(r.quizDone).toBe(true);
    expect(r.reply).toContain('cancelled');

    const session = await store.get(`quiz:${phone}`);
    expect(session.status).toBe('CANCELLED');
  });
});

// ---------------------------------------------------------------------------
// Test 12: Unrelated messages during questionnaire
// ---------------------------------------------------------------------------

describe('Test 12 – Unrelated message during questionnaire', () => {
  it('responds briefly and retains quiz state', async () => {
    const store = createMemoryStore();
    const manager = createQuestionnaireManager(store);
    const phone = '+919000000013';

    await manager.processMessage(phone, 'Hi');

    // Send a long unrelated message
    const r = await manager.processMessage(
      phone,
      'Can you tell me about the opening hours of the studio and what classes you offer every day of the week?'
    );

    expect(r.reply).toContain('questionnaire progress saved');
    // Quiz state should still be AWAITING_Q1
    const session = await store.get(`quiz:${phone}`);
    expect(session.quizState).toBe('AWAITING_Q1');
  });
});

// ---------------------------------------------------------------------------
// Unit: validateAnswer
// ---------------------------------------------------------------------------

describe('validateAnswer', () => {
  const q1 = QUESTIONS[0];

  it('accepts uppercase letter', () => {
    expect(validateAnswer(q1, 'A').valid).toBe(true);
    expect(validateAnswer(q1, 'A').letter).toBe('A');
  });

  it('accepts lowercase letter', () => {
    expect(validateAnswer(q1, 'a').valid).toBe(true);
  });

  it('accepts full option text', () => {
    expect(validateAnswer(q1, 'Personal Styling & Fashion').valid).toBe(true);
  });

  it('rejects invalid letter X', () => {
    expect(validateAnswer(q1, 'X').valid).toBe(false);
  });

  it('marks Other as isOther=true', () => {
    const lastOpt = q1.options[q1.options.length - 1];
    const result = validateAnswer(q1, lastOpt.letter);
    expect(result.isOther).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: analyseAnswers (mock mode)
// ---------------------------------------------------------------------------

describe('analyseAnswers (mock mode)', () => {
  it('returns a valid analysis structure', async () => {
    const answers = {
      interest: 'Professional Image & Confidence',
      primaryGoal: 'Create a strong professional presence',
      learningPreference: 'One-on-one personalised coaching',
      startTimeline: 'Immediately',
      preferredDuration: '30 Days – Structured Development',
      budget: '₹25,000 – ₹50,000',
      brandConscious: 'Yes',
      brandPreference: 'Zara',
      additionalQuestions: "No, I'm all set",
    };
    const result = await analyseAnswers(answers, {});
    expect(result).toHaveProperty('customerProfile');
    expect(result).toHaveProperty('analysis');
    expect(result).toHaveProperty('nextAction');
    expect(result.analysis.priority).toBe('High');
    expect(result.nextAction.type).toBe('IMMEDIATE_FOLLOWUP');
  });
});

// ---------------------------------------------------------------------------
// Unit: formatQuestion
// ---------------------------------------------------------------------------

describe('formatQuestion', () => {
  it('includes question number, text, and all options', () => {
    const q = QUESTIONS[0];
    const text = formatQuestion(q, 9);
    expect(text).toContain('Question 1 of 9');
    expect(text).toContain('What would you like to improve');
    q.options.forEach((o) => {
      expect(text).toContain(o.letter);
      expect(text).toContain(o.text);
    });
  });

  it('shows "of 8" when total=8 (Q8 skipped)', () => {
    const q = QUESTIONS[8]; // Q9
    const text = formatQuestion(q, 8);
    expect(text).toContain('Question 9 of 8');
  });
});

// ---------------------------------------------------------------------------
// Unit: getNextQuestion
// ---------------------------------------------------------------------------

describe('getNextQuestion', () => {
  it('returns next question for Q1-Q8', () => {
    expect(getNextQuestion(QUESTIONS[0])).toBe(QUESTIONS[1]);
    expect(getNextQuestion(QUESTIONS[3])).toBe(QUESTIONS[4]);
    expect(getNextQuestion(QUESTIONS[7])).toBe(QUESTIONS[8]); // Q8 → Q9
  });

  it('returns null after the last question (Q9)', () => {
    expect(getNextQuestion(QUESTIONS[8])).toBeNull();
  });
});
