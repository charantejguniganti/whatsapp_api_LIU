/**
 * questionnaire/analysisService.js
 *
 * Analyses the completed questionnaire answers and generates a structured
 * customer profile + service recommendation.
 *
 * Uses the real OpenAI API when available; falls back to a deterministic
 * rule-based analyser in mock mode.
 *
 * The output conforms to the JSON schema defined in the master prompt.
 */

import config from '../config/index.js';
import { recommendServices } from '../ai/packageRecommender.js';
import logger from '../logger.js';

// ---------------------------------------------------------------------------
// Rule-based fallback
// ---------------------------------------------------------------------------

/** Map questionnaire interest keys to recommender goal text */
const INTEREST_TO_GOAL = {
  'Personal Styling & Fashion': 'style wardrobe fashion makeover',
  'Grooming & Self-Care': 'grooming makeup appearance',
  'Personality Development': 'communication soft skills confidence',
  'Professional Image & Confidence': 'executive presence professional image',
  'Communication Skills': 'communication public speaking',
  'Corporate Wellness & Development': 'corporate wellness transformation',
};

function ruleBasedAnalysis(answers) {
  const interest = answers.interest || '';
  const goal = answers.primaryGoal || '';
  const learning = answers.learningPreference || '';
  const timeline = answers.startTimeline || '';
  const duration = answers.preferredDuration || '';
  const budget = answers.budget || '';
  const brandConscious = answers.brandConscious || '';
  const brandPreference = answers.brandPreference || '';

  // Build a goal text from all answers for the recommender
  const goalText = [
    INTEREST_TO_GOAL[interest] || interest,
    goal,
    brandPreference,
  ].join(' ');

  const rec = recommendServices(goalText);

  const recommendedService =
    rec.services.length > 0
      ? rec.services.map((s) => s.name).join(', ')
      : 'Personalised consultation with the LIU team';

  // Urgency based on start timeline
  const urgencyMap = {
    'Immediately': 'High',
    'Within 7 days': 'High',
    'Within 15 days': 'Medium',
    'Within 30 days': 'Medium',
    'Just exploring for now': 'Low',
  };
  const urgency = urgencyMap[timeline] || 'Medium';

  return {
    customerProfile: {
      interest,
      primaryGoal: goal,
      learningPreference: learning,
      startTimeline: timeline,
      preferredDuration: duration,
      budget,
      brandConscious,
      brandPreference: brandPreference || null,
    },
    analysis: {
      intent: `Customer interested in ${interest || 'personal development'}`,
      customerNeeds: [interest, goal].filter(Boolean),
      priority: urgency,
      recommendedService,
      recommendedDuration: duration || 'To be discussed with the LIU team',
      reasonForRecommendation:
        `Based on your interest in ${interest}, goal to ${goal}, and preference for ${learning}, ` +
        `${recommendedService} aligns closely with your needs.`,
    },
    nextAction: {
      type: urgency === 'High' ? 'IMMEDIATE_FOLLOWUP' : 'SCHEDULED_FOLLOWUP',
      description:
        urgency === 'High'
          ? 'Connect customer with LIU consultant immediately'
          : 'Schedule a follow-up call within 48 hours',
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-powered analysis
// ---------------------------------------------------------------------------

async function aiPoweredAnalysis(answers, otherResponses) {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: config.OPENAI_API_KEY });

  const systemPrompt = `
You are an expert consultant for LIU (Live It Up), a wellness and personal development company.
Analyse the customer questionnaire answers and return a JSON object matching exactly this schema:
{
  "customerProfile": {
    "interest": string,
    "primaryGoal": string,
    "learningPreference": string,
    "startTimeline": string,
    "preferredDuration": string
  },
  "analysis": {
    "intent": string,
    "customerNeeds": string[],
    "priority": "High" | "Medium" | "Low",
    "recommendedService": string,
    "recommendedDuration": string,
    "reasonForRecommendation": string
  },
  "nextAction": {
    "type": "IMMEDIATE_FOLLOWUP" | "SCHEDULED_FOLLOWUP" | "INFORMATION_ONLY",
    "description": string
  }
}

LIU services include: Pilates, Barre, Wellness, Image Consulting, Grooming, Communication Skills,
Posture & Body Language, Etiquette, Personal Styling, Wardrobe Evaluation, Nutrition, Sound Healing,
Executive Presence, and Professional Transformation.

RULES:
- Only recommend services LIU actually offers.
- Do not invent prices, timelines, or guarantees.
- Return only valid JSON — no markdown, no extra text.
`.trim();

  const userContent = `
Customer questionnaire answers:
Q1 (Area of Interest): ${answers.interest || 'Not provided'}
Q2 (Primary Goal): ${answers.primaryGoal || 'Not provided'}
Q3 (Learning Preference): ${answers.learningPreference || 'Not provided'}
Q4 (Start Timeline): ${answers.startTimeline || 'Not provided'}
Q5 (Programme Duration): ${answers.preferredDuration || 'Not provided'}
Q6 (Budget): ${answers.budget || 'Not provided'}
Q7 (Brand Conscious): ${answers.brandConscious || 'Not provided'}
Q8 (Brand Preference): ${answers.brandPreference || 'Not applicable / skipped'}
Q9 (Additional Questions): ${answers.additionalQuestions || 'Not provided'}
${Object.keys(otherResponses).length > 0
  ? `\nAdditional details: ${JSON.stringify(otherResponses)}`
  : ''}
`.trim();

  const completion = await client.chat.completions.create({
    model: config.OPENAI_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: 600,
    temperature: 0.3,
    response_format: { type: 'json_object' },
  });

  const raw = completion.choices[0]?.message?.content ?? '{}';
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyse completed questionnaire answers.
 *
 * @param {object} answers        - { interest, primaryGoal, learningPreference, startTimeline, preferredDuration }
 * @param {object} otherResponses - Free-text "Other" answers keyed by question key
 * @returns {Promise<object>}     - Structured analysis result
 */
export async function analyseAnswers(answers, otherResponses = {}) {
  if (config.USE_MOCK_AI) {
    logger.debug('Using rule-based questionnaire analysis (mock mode)');
    return ruleBasedAnalysis(answers);
  }

  try {
    const result = await aiPoweredAnalysis(answers, otherResponses);
    // Validate essential fields
    if (!result.customerProfile || !result.analysis || !result.nextAction) {
      throw new Error('Invalid AI analysis structure');
    }
    return result;
  } catch (err) {
    logger.error({ err }, 'AI analysis failed — falling back to rule-based');
    return ruleBasedAnalysis(answers);
  }
}

