/**
 * questionnaire/sessionRepository.js
 *
 * Thin persistence layer for questionnaire sessions.
 * Uses the existing IStore (PostgreSQL / memory / JSON-file).
 *
 * Key pattern:  quiz:<phone>
 *
 * Session record shape:
 * {
 *   whatsappNumber : string,
 *   status         : 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED',
 *   quizState      : string,            // state-machine state
 *   currentQuestion: number,            // 1-9
 *   answers: {
 *     interest          : string | null,
 *     primaryGoal       : string | null,
 *     learningPreference: string | null,
 *     startTimeline     : string | null,
 *     preferredDuration : string | null,
 *     budget            : string | null,
 *     brandConscious    : string | null,
 *     brandPreference   : string | null,  // null when Q8 skipped
 *     additionalQuestions: string | null,
 *   },
 *   otherResponses : Record<string, string>,
 *   analysis       : object | null,
 *   createdAt      : string,
 *   updatedAt      : string,
 * }
 */

const KEY_PREFIX = 'quiz:';

/**
 * @param {import('../store/interface.js').IStore} store
 */
export function createSessionRepository(store) {
  /**
   * Retrieve the questionnaire session for a phone number.
   * Returns null if none exists.
   * @param {string} phone
   * @returns {Promise<object|null>}
   */
  async function getSession(phone) {
    return store.get(`${KEY_PREFIX}${phone}`);
  }

  /**
   * Persist (create or update) a questionnaire session.
   * @param {string} phone
   * @param {object} session
   */
  async function saveSession(phone, session) {
    await store.set(`${KEY_PREFIX}${phone}`, {
      ...session,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Create a fresh session for a customer.
   * @param {string} phone
   * @returns {Promise<object>}
   */
  async function createSession(phone) {
    const session = {
      whatsappNumber: phone,
      status: 'IN_PROGRESS',
      quizState: 'AWAITING_Q1',
      currentQuestion: 1,
      answers: {
        interest: null,
        primaryGoal: null,
        learningPreference: null,
        startTimeline: null,
        preferredDuration: null,
        budget: null,
        brandConscious: null,
        brandPreference: null,
        additionalQuestions: null,
      },
      otherResponses: {},
      analysis: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await store.set(`${KEY_PREFIX}${phone}`, session);
    return session;
  }

  /**
   * Delete a session (used for RESTART command).
   * @param {string} phone
   */
  async function deleteSession(phone) {
    await store.delete(`${KEY_PREFIX}${phone}`);
  }

  /**
   * Check whether an active (non-completed) session exists for a phone.
   * @param {string} phone
   * @returns {Promise<boolean>}
   */
  async function hasActiveSession(phone) {
    const session = await getSession(phone);
    return session !== null && session.status === 'IN_PROGRESS';
  }

  return {
    getSession,
    saveSession,
    createSession,
    deleteSession,
    hasActiveSession,
  };
}

