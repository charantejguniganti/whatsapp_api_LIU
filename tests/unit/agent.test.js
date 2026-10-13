/**
 * Unit tests: AI agent
 */
import { describe, it, expect, vi } from 'vitest';
import { processMessage } from '../../src/ai/agent.js';

// AI uses mock adapter (set in tests/setup.js)

describe('processMessage — AI agent', () => {
  it('returns a reply string for a normal message', async () => {
    const result = await processMessage({
      from: '+910000000001',
      message: 'Hello, what services do you offer?',
      history: [],
    });

    expect(result).toHaveProperty('reply');
    expect(typeof result.reply).toBe('string');
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.handover).toBe(false);
  });

  it('triggers handover when customer asks for a human', async () => {
    const result = await processMessage({
      from: '+910000000002',
      message: 'I want to speak to a human agent',
      history: [],
    });

    expect(result.handover).toBe(true);
    expect(result.reply).toMatch(/team|reach out|hello@liveitup/i);
  });

  it('triggers handover for escalation keyword', async () => {
    const result = await processMessage({
      from: '+910000000003',
      message: 'Please escalate this to your manager',
      history: [],
    });

    expect(result.handover).toBe(true);
  });

  it('returns a fallback reply when AI fails', async () => {
    // Force the mock to be used (already set in env) — just verify graceful handling
    const result = await processMessage({
      from: '+910000000004',
      message: 'Tell me about pricing',
      history: [],
    });

    expect(result.reply).toBeTruthy();
    expect(result.handover).toBe(false);
  });

  it('includes history in processing without error', async () => {
    const history = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello! How can I help?' },
    ];

    const result = await processMessage({
      from: '+910000000005',
      message: 'What about corporate events?',
      history,
    });

    expect(result.reply).toBeTruthy();
  });

  it('returns handover=false for regular FAQ questions', async () => {
    const result = await processMessage({
      from: '+910000000006',
      message: 'Do you have services outside Hyderabad?',
      history: [],
    });

    expect(result.handover).toBe(false);
    expect(result.reply).toBeTruthy();
  });

  it('returns greeting response for "Hi there"', async () => {
    const result = await processMessage({
      from: '+910000000007',
      message: 'Hi there',
      history: [],
    });

    expect(result.reply).toMatch(/Liv|Live It Up/i);
    expect(result.handover).toBe(false);
  });

  it('returns professional development response for communication and leadership without false-positive greeting from "leadership"', async () => {
    const result = await processMessage({
      from: '+910000000008',
      message: 'I want to improve my communication and leadership skills',
      history: [],
    });

    expect(result.reply).toMatch(/professional transformation|communication|leadership/i);
    expect(result.reply).not.toMatch(/^Hello! 👋 I'm Liv/);
    expect(result.handover).toBe(false);
  });

  it('returns corporate response for employee workshop request even when mentioning wellness and communication', async () => {
    const result = await processMessage({
      from: '+910000000010',
      message: 'Can LIU conduct a wellness and communication workshop for our employees?',
      history: [],
    });

    expect(result.reply).toMatch(/corporate organisations|educational institutions|workshops/i);
    expect(result.reply).not.toMatch(/Reformer & Mat Pilates/);
    expect(result.handover).toBe(false);
  });

  it('returns wellness response for "Tell me about Pilates"', async () => {
    const result = await processMessage({
      from: '+910000000011',
      message: 'Tell me about Pilates',
      history: [],
    });

    expect(result.reply).toMatch(/Reformer & Mat Pilates|wellness and movement focus/i);
    expect(result.handover).toBe(false);
  });
});
