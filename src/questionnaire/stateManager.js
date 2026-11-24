/**
 * questionnaire/stateManager.js
 *
 * Orchestrates the full questionnaire state machine.
 *
 * State machine:
 *   IDLE
 *   → AWAITING_Q1   → AWAITING_Q1_OTHER → AWAITING_Q2
 *   → AWAITING_Q2   → AWAITING_Q2_OTHER → AWAITING_Q3
 *   → AWAITING_Q3   → AWAITING_Q3_OTHER → AWAITING_Q4
 *   → AWAITING_Q4   → AWAITING_Q4_OTHER → AWAITING_Q5
 *   → AWAITING_Q5   → AWAITING_Q5_OTHER → AWAITING_Q6
 *   → AWAITING_Q6   → AWAITING_Q7
 *   → AWAITING_Q7   (Yes → AWAITING_Q8, No → AWAITING_Q9)
 *   → AWAITING_Q8   → AWAITING_Q8_OTHER → AWAITING_Q9
 *   → AWAITING_Q9   → AWAITING_Q9_OTHER → ANALYSING
 *   → ANALYSING     → COMPLETED
 *
 * Global commands (handled from any state):
 *   RESTART — reset session and restart
 *   CANCEL  — cancel the questionnaire
 *   HUMAN   — trigger human handover
 */

import { createSessionRepository } from './sessionRepository.js';
import { validateAnswer, buildInvalidReply } from './answerValidator.js';
import { analyseAnswers } from './analysisService.js';
import {
  QUESTIONS,
  getQuestionByState,
  getNextQuestion,
  formatQuestion,
} from './questions.js';
import {
  buildWelcomeAndQ1,
  getWelcomeMessages,
  buildQuestionMessage,
  buildOtherPrompt,
  buildRecommendationMessage,
  RESTART_REPLY,
  CANCEL_REPLY,
  HUMAN_REPLY,
  UNRELATED_REPLY,
} from './responseGenerator.js';
import logger from '../logger.js';

/** @typedef {{ reply: string, handover: boolean, quizDone: boolean }} QuizResult */

/**
 * @param {import('../store/interface.js').IStore} store
 */
export function createQuestionnaireManager(store) {
  const repo = createSessionRepository(store);

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Update a single answer field on the session. */
  async function saveAnswer(session, questionKey, answerText) {
    session.answers[questionKey] = answerText;
    await repo.saveSession(session.whatsappNumber, session);
  }

  /** Save a free-text "Other" response. */
  async function saveOtherResponse(session, questionKey, freeText) {
    session.otherResponses[questionKey] = freeText;
    session.answers[questionKey] = `Other: ${freeText}`;
    await repo.saveSession(session.whatsappNumber, session);
  }

  /** Advance state to the next question's await-state (or ANALYSING). */
  async function advanceToNextQuestion(session, currentQuestion) {
    let nextQ = getNextQuestion(currentQuestion);

    // Conditional skip: Q8 (brandPreference) is only shown when Q7 (brandConscious) = Yes (A)
    if (nextQ && nextQ.key === 'brandPreference') {
      const brandAns = (session.answers.brandConscious || '').trim().toLowerCase();
      const isNo = brandAns === 'no' || brandAns === 'b';
      if (isNo) {
        session.answers.brandPreference = null; // explicitly mark as skipped
        nextQ = getNextQuestion(nextQ);         // jump over Q8 → Q9
      }
    }

    if (nextQ) {
      // Determine total questions this customer will actually see
      const brandAns = (session.answers.brandConscious || '').trim().toLowerCase();
      const skippingQ8 = brandAns === 'no' || brandAns === 'b';
      const total = skippingQ8 ? QUESTIONS.length - 1 : QUESTIONS.length;

      session.quizState = nextQ.awaitState;
      session.currentQuestion = nextQ.number;
      await repo.saveSession(session.whatsappNumber, session);
      return buildQuestionMessage(nextQ, total);
    }
    // All questions answered — run analysis
    return runAnalysis(session);
  }

  /** Run AI analysis and build final reply. */
  async function runAnalysis(session) {
    session.quizState = 'ANALYSING';
    session.status = 'IN_PROGRESS';
    await repo.saveSession(session.whatsappNumber, session);

    try {
      const analysis = await analyseAnswers(session.answers, session.otherResponses);
      session.analysis = analysis;
      session.quizState = 'COMPLETED';
      session.status = 'COMPLETED';
      await repo.saveSession(session.whatsappNumber, session);

      logger.info({ phone: session.whatsappNumber }, 'Questionnaire completed');
      return buildRecommendationMessage(analysis, session.answers);
    } catch (err) {
      logger.error({ err, phone: session.whatsappNumber }, 'Analysis failed');
      session.quizState = 'COMPLETED';
      session.status = 'COMPLETED';
      await repo.saveSession(session.whatsappNumber, session);
      return (
        `Thank you for completing the questionnaire! 🌟\n\n` +
        `Our LIU team will review your preferences and reach out with a personalised recommendation. ` +
        `Feel free to email us at *hello@liveitup.in* in the meantime.`
      );
    }
  }

  // ── Global command detector ───────────────────────────────────────────────

  function detectCommand(text) {
    const upper = text.trim().toUpperCase();
    if (upper === 'RESTART' || upper === 'START OVER' || upper === 'START AGAIN') return 'RESTART';
    if (upper === 'CANCEL' || upper === 'STOP' || upper === 'QUIT') return 'CANCEL';
    if (upper === 'HUMAN' || upper === 'AGENT' || upper === 'PERSON') return 'HUMAN';
    return null;
  }

  // ── Consultant affirmative detector ──────────────────────────────────────
  function isConsultantHandoffAffirmative(text) {
    const lower = text.trim().toLowerCase();
    // 1. Direct short affirmative responses
    if (/^(yes|yeah|yep|sure|ok|okay|y|please|connect|contact|call|interested|yes please|absolutely|definitely|i do)[\s!.,]*$/i.test(lower)) {
      return true;
    }
    // 2. Starts with affirmative
    if (/^(yes|yeah|yep|sure|ok|okay|yes please|absolutely|definitely)\b/i.test(lower)) {
      return true;
    }
    // 3. Explicit consultant or team contact intent
    if (
      /connect me with (the|our|a)?\s*(consultant|team)/i.test(lower) ||
      /speak with (the|our|a)?\s*(consultant|team)/i.test(lower) ||
      /speak to (someone|a consultant|the team)/i.test(lower) ||
      /talk to (someone|a consultant|the team)/i.test(lower) ||
      /i (want|would like) to (speak|talk|connect) (with|to) (a|the|our)?\s*(consultant|team|someone)/i.test(lower) ||
      /i would like someone to contact me/i.test(lower) ||
      /someone to contact me/i.test(lower) ||
      /contact me/i.test(lower)
    ) {
      return true;
    }
    return false;
  }

  // ── Greeting detector ─────────────────────────────────────────────────────

  function isGreeting(text) {
    return /^(hi|hello|hey|good morning|good afternoon|good evening|namaste|hii+|helo)[\s!.,]*$/i.test(
      text.trim()
    );
  }

  // ── Main message processor ────────────────────────────────────────────────

  /**
   * Process an inbound message for the questionnaire system.
   *
   * Returns null if the message is NOT related to the questionnaire
   * (i.e. no active session and not a greeting) — the caller should
   * fall through to the regular AI agent.
   *
   * @param {string} phone   - Customer's WhatsApp number (E.164)
   * @param {string} message - Raw inbound message text
   * @returns {Promise<QuizResult|null>}
   */
  async function processMessage(phone, message) {
    const session = await repo.getSession(phone);
    const trimmed = message.trim();

    // ── Handle global commands from any active session ──────────────────────
    if (session && session.status === 'IN_PROGRESS') {
      const command = detectCommand(trimmed);

      if (command === 'RESTART') {
        await repo.deleteSession(phone);
        const newSession = await repo.createSession(phone);
        logger.info({ phone }, 'Quiz restarted');
        const welcomeMsgs = getWelcomeMessages();
        return {
          reply: RESTART_REPLY + welcomeMsgs.join('\n\n'),
          messages: [RESTART_REPLY.trim(), ...welcomeMsgs],
          handover: false,
          quizDone: false,
        };
      }

      if (command === 'CANCEL') {
        session.quizState = 'COMPLETED';
        session.status = 'CANCELLED';
        await repo.saveSession(phone, session);
        return { reply: CANCEL_REPLY, handover: false, quizDone: true };
      }

      if (command === 'HUMAN') {
        session.quizState = 'COMPLETED';
        session.status = 'CANCELLED';
        await repo.saveSession(phone, session);
        return { reply: HUMAN_REPLY, handover: true, quizDone: true };
      }
    }

    // ── No active session ───────────────────────────────────────────────────
    if (!session || session.status !== 'IN_PROGRESS') {
      // Customer confirmed after questionnaire completion (e.g. replied "Yes" to connect with consultant)
      if (session && session.status === 'COMPLETED') {
        if (isConsultantHandoffAffirmative(trimmed)) {
          const isFirstTime = !session.consultantRequested;
          session.consultantRequested = true;
          session.consultantRequestedAt = session.consultantRequestedAt || new Date().toISOString();
          await repo.saveSession(phone, session);

          return {
            reply: 'Thanks for reaching out to Live It Up! 🌟 Our team will contact you soon.',
            handover: true,
            quizDone: true,
            isConsultantRequest: isFirstTime,
            consultantRequested: true,
          };
        }
      }

      // Start questionnaire on greeting
      if (isGreeting(trimmed)) {
        const newSession = await repo.createSession(phone);
        logger.info({ phone }, 'Quiz started');
        const welcomeMsgs = getWelcomeMessages();
        return {
          reply: welcomeMsgs.join('\n\n'),
          messages: welcomeMsgs,
          handover: false,
          quizDone: false,
        };
      }
      // Not our concern — let the regular AI handle it
      return null;
    }

    // ── Active session — process by state ───────────────────────────────────
    const { quizState } = session;

    // Handle AWAITING_Qn_OTHER states (free-text collection)
    const otherStateMatch = quizState.match(/^AWAITING_Q(\d)_OTHER$/);
    if (otherStateMatch) {
      const qNum = parseInt(otherStateMatch[1], 10);
      const question = QUESTIONS[qNum - 1];
      await saveOtherResponse(session, question.key, trimmed);
      session.quizState = question.otherState; // keep same but advance below
      const reply = await advanceToNextQuestion(session, question);
      return { reply, handover: false, quizDone: session.status === 'COMPLETED' };
    }

    // Handle AWAITING_Qn states (option selection)
    const awaitStateMatch = quizState.match(/^AWAITING_Q(\d)$/);
    if (awaitStateMatch) {
      const qNum = parseInt(awaitStateMatch[1], 10);
      const question = QUESTIONS[qNum - 1];

      const validation = validateAnswer(question, trimmed);

      if (!validation.valid) {
        // Check if this looks like a completely unrelated message (long prose)
        if (trimmed.length > 60 && !trimmed.match(/^[A-H]$/i)) {
          return {
            reply:
              UNRELATED_REPLY +
              `To continue, please answer Question ${question.number}:\n\n` +
              formatQuestion(question),
            handover: false,
            quizDone: false,
          };
        }
        // Otherwise — invalid option, reprompt
        return {
          reply: buildInvalidReply(question),
          handover: false,
          quizDone: false,
        };
      }

      // Save valid answer
      await saveAnswer(session, question.key, validation.text);

      // If "Other" was chosen, ask for free-text
      if (validation.isOther) {
        session.quizState = question.otherState;
        await repo.saveSession(phone, session);
        return { reply: buildOtherPrompt(), handover: false, quizDone: false };
      }

      // Advance to next question or analysis
      const reply = await advanceToNextQuestion(session, question);
      return { reply, handover: false, quizDone: session.status === 'COMPLETED' };
    }

    // ANALYSING or COMPLETED
    if (quizState === 'ANALYSING') {
      return {
        reply: `⏳ Just a moment, I'm preparing your personalised recommendation...`,
        handover: false,
        quizDone: false,
      };
    }

    // Completed session but customer messages again — not our concern
    return null;
  }

  /**
   * Check if a customer has an active questionnaire session.
   * @param {string} phone
   * @returns {Promise<boolean>}
   */
  async function isInQuiz(phone) {
    return repo.hasActiveSession(phone);
  }

  return { processMessage, isInQuiz };
}

