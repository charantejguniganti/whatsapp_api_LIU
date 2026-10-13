/**
 * OpenAI wrapper.
 * Provides a thin layer over the official OpenAI SDK.
 * Falls back to the mock adapter when USE_MOCK_AI is true.
 */
import config from '../config/index.js';
import logger from '../logger.js';

// ---------------------------------------------------------------------------
// Mock adapter (used in dev / test when no real key is configured)
// ---------------------------------------------------------------------------

/**
 * Simulated AI responses keyed by topic keywords.
 * This mock always returns sensible, on-brand answers.
 */
const MOCK_RESPONSES = [
  {
    keywords: ['human', 'agent', 'person', 'someone', 'team', 'representative', 'speak to', 'talk to', 'call me', 'manager', 'escalate'],
    reply:
      "I'd be happy to connect you with a member of the LIU team! 🙌 You can reach out directly at hello@liveitup.in, or share your contact details and someone will reach out shortly.",
  },
  {
    keywords: ['price', 'cost', 'fee', 'fees', 'charges', 'how much', 'pricing', 'quote', 'budget', 'rate', 'rates', 'schedule', 'timing', 'slot', 'slots', 'availability'],
    reply:
      "Our session pricing and availability depend on your specific programme, format (individual or group), and goals. We provide customised options rather than fixed public rates. Would you like me to connect you with our team for current schedules and fee details?",
  },
  {
    keywords: ['corporate', 'company', 'workplace', 'employee', 'employees', 'institutional', 'student', 'students', 'college', 'school', 'university', 'campus', 'workshop', 'workshops'],
    reply:
      "LIU designs tailored wellness, grooming, and professional development programmes for corporate organisations and educational institutions. We offer customised workshops to fit your group's needs. Would you like our team to get in touch?",
  },
  {
    keywords: ['grooming', 'image', 'styling', 'wardrobe', 'presentation', 'etiquette', 'appearance'],
    reply:
      "LIU's grooming and image consulting programmes help refine your personal presentation, executive presence, wardrobe styling, and self-confidence. Would you like details on individual consultations or group sessions?",
  },
  {
    keywords: ['professional development', 'communication', 'public speaking', 'leadership', 'career', 'executive', 'soft skills'],
    reply:
      "Our professional transformation programmes focus on impactful communication, public speaking, leadership skills, and executive presence to support your career growth. Would you like to connect with our team to discuss your goals?",
  },
  {
    keywords: ['wellness', 'pilates', 'barre', 'mobility', 'functional', 'fitness', 'movement', 'exercise', 'posture', 'workout', 'workouts'],
    reply:
      "At LIU, our wellness and movement focus includes Reformer & Mat Pilates, Barre, Mobility Training, and Functional Training. These help build strength, posture, flexibility, and mind-body balance. Would you like to explore a specific session?",
  },
  {
    keywords: ['hello', 'hi', 'hey', 'greetings', 'good morning', 'good afternoon', 'good evening', 'namaste'],
    reply:
      "Hello! 👋 I'm Liv, your assistant for Live It Up (LIU). We bring together wellness, grooming, personal development, and professional transformation. How can I help you today?",
  },
];

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mockReply(message) {
  for (const entry of MOCK_RESPONSES) {
    if (
      entry.keywords.some((kw) => {
        const regex = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i');
        return regex.test(message);
      })
    ) {
      return entry.reply;
    }
  }
  return (
    "Thanks for reaching out to Live It Up! ✨ I don't have specific details on that right now, " +
    "but our team would be happy to help. Would you like me to connect you with someone from the LIU team?"
  );
}

// ---------------------------------------------------------------------------
// Real OpenAI adapter
// ---------------------------------------------------------------------------

let _openaiClient = null;

async function getOpenAIClient() {
  if (_openaiClient) return _openaiClient;
  const { default: OpenAI } = await import('openai');
  _openaiClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
  return _openaiClient;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ChatMessage
 * @property {'user'|'assistant'|'system'} role
 * @property {string} content
 */

/**
 * Generate an AI reply for a conversation.
 *
 * @param {string} systemPrompt
 * @param {ChatMessage[]} history  - Prior messages in the conversation
 * @param {string} userMessage     - The latest message from the customer
 * @returns {Promise<string>}      - The AI reply text
 */
export async function generateReply(systemPrompt, history, userMessage) {
  if (config.USE_MOCK_AI) {
    logger.debug({ mock: true }, 'Using mock AI adapter');
    return mockReply(userMessage);
  }

  const client = await getOpenAIClient();
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: userMessage },
  ];

  logger.debug({ model: config.OPENAI_MODEL, messageCount: messages.length }, 'Calling OpenAI');

  const completion = await client.chat.completions.create({
    model: config.OPENAI_MODEL,
    messages,
    max_tokens: config.OPENAI_MAX_TOKENS,
    temperature: 0.4, // Low temp for consistent, factual answers
  });

  const reply = completion.choices[0]?.message?.content ?? '';
  logger.debug({ tokens: completion.usage }, 'OpenAI response received');
  return reply.trim();
}
