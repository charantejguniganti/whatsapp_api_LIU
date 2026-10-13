/**
 * Integration & unit tests for Conversation Qualification & Mam Takeover Workflow
 */
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { resetStore, getStore } from '../../src/store/index.js';
import {
  classifyMessage,
  buildEnquirySummary,
  createConversationService,
  MESSAGE_CLASS,
  CONV_STATE,
} from '../../src/conversations/service.js';

describe('Message Qualification & Spam Classification', () => {
  it('classifies spam patterns accurately', () => {
    expect(classifyMessage('Congratulations you have won a prize click here')).toBe(MESSAGE_CLASS.SPAM);
    expect(classifyMessage('Earn money fast https://spam.com/offer')).toBe(MESSAGE_CLASS.SPAM);
  });

  it('classifies qualified booking / custom package messages', () => {
    expect(classifyMessage('I want to book an appointment for Pilates')).toBe(MESSAGE_CLASS.QUALIFIED);
    expect(classifyMessage('Can you make a custom package for me?')).toBe(MESSAGE_CLASS.QUALIFIED);
    expect(classifyMessage('How much for booking Image Consulting?')).toBe(MESSAGE_CLASS.QUALIFIED);
  });

  it('classifies routine general queries', () => {
    expect(classifyMessage('What is barre?')).toBe(MESSAGE_CLASS.ROUTINE);
    expect(classifyMessage('Tell me about your pilates classes')).toBe(MESSAGE_CLASS.ROUTINE);
    expect(classifyMessage('Where are you located?')).toBe(MESSAGE_CLASS.ROUTINE);
  });
});

describe('Conversation Service State Transitions', () => {
  let store;
  let convService;

  beforeEach(async () => {
    resetStore();
    store = await getStore();
    convService = createConversationService(store);
  });

  it('starts in AI_ACTIVE state by default', async () => {
    const isAi = await convService.isAiActive('+919876500001');
    expect(isAi).toBe(true);
    const state = await convService.getConvState('+919876500001');
    expect(state).toBe(CONV_STATE.AI_ACTIVE);
  });

  it('transitions to HUMAN_TAKEOVER on claim, pausing AI', async () => {
    await convService.claimConversation('+919876500001', 'admin');
    const isAi = await convService.isAiActive('+919876500001');
    expect(isAi).toBe(false);
    const state = await convService.getConvState('+919876500001');
    expect(state).toBe(CONV_STATE.HUMAN_TAKEOVER);
  });

  it('transitions back to AI_RESUMED on resume', async () => {
    await convService.claimConversation('+919876500001', 'admin');
    await convService.resumeAi('+919876500001');
    const isAi = await convService.isAiActive('+919876500001');
    expect(isAi).toBe(true);
    const state = await convService.getConvState('+919876500001');
    expect(state).toBe(CONV_STATE.AI_RESUMED);
  });

  it('tracks notification deduplication correctly', async () => {
    expect(await convService.hasBeenNotified('+919876500001')).toBe(false);
    await convService.markNotified('+919876500001');
    expect(await convService.hasBeenNotified('+919876500001')).toBe(true);
    await convService.resetNotification('+919876500001');
    expect(await convService.hasBeenNotified('+919876500001')).toBe(false);
  });

  it('generates a formatted enquiry summary for Mam', () => {
    const summary = buildEnquirySummary({
      customerPhone: '+919876543210',
      customerName: 'Priya',
      interest: 'Executive Presence Package',
      recentMessages: ['Hi', 'I want to improve my communication and posture'],
      aiRecommendation: 'Recommended Executive Presence draft bundle',
    });

    expect(summary).toContain('*LIU — New Qualified Enquiry*');
    expect(summary).toContain('Priya');
    expect(summary).toContain('+919876543210');
    expect(summary).toContain('TAKE +919876543210');
    expect(summary).toContain('RESUME +919876543210');
  });
});
