/**
 * Unit tests: Lead capture service
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryStore } from '../../src/store/memory.js';
import { createLeadService, LEAD_STATE } from '../../src/leads/service.js';

function makeService() {
  const store = createMemoryStore();
  const service = createLeadService(store);
  return { store, service };
}

describe('Lead capture service', () => {
  describe('startLeadCollection', () => {
    it('returns a question asking for name', async () => {
      const { service } = makeService();
      const reply = await service.startLeadCollection('+910000000010');
      expect(reply).toMatch(/name/i);
    });

    it('sets state to AWAITING_NAME', async () => {
      const { service } = makeService();
      await service.startLeadCollection('+910000000011');
      const state = await service.getLeadState('+910000000011');
      expect(state.state).toBe(LEAD_STATE.AWAITING_NAME);
    });
  });

  describe('isInLeadFlow', () => {
    it('returns false before starting a flow', async () => {
      const { service } = makeService();
      expect(await service.isInLeadFlow('+910000000020')).toBe(false);
    });

    it('returns true after starting a flow', async () => {
      const { service } = makeService();
      await service.startLeadCollection('+910000000021');
      expect(await service.isInLeadFlow('+910000000021')).toBe(true);
    });
  });

  describe('processLeadMessage — full happy path', () => {
    it('collects name, interest, contact time, and consent', async () => {
      const { service } = makeService();
      const phone = '+910000000030';

      await service.startLeadCollection(phone);

      // Step 1: Provide name
      let result = await service.processLeadMessage(phone, 'Arjun Kumar');
      expect(result.reply).toMatch(/arjun kumar/i);
      expect(result.complete).toBe(false);

      // Step 2: Provide interest
      result = await service.processLeadMessage(phone, 'Corporate team building event');
      expect(result.reply).toMatch(/contact/i);
      expect(result.complete).toBe(false);

      // Step 3: Provide contact time
      result = await service.processLeadMessage(phone, 'Weekday afternoons after 3 PM');
      expect(result.reply).toMatch(/confirm|consent|yes/i);
      expect(result.complete).toBe(false);

      // Step 4: Give consent
      result = await service.processLeadMessage(phone, 'Yes please');
      expect(result.complete).toBe(true);
      expect(result.lead).toBeTruthy();
      expect(result.lead.name).toBe('Arjun Kumar');
      expect(result.lead.interest).toBe('Corporate team building event');
      expect(result.lead.consentGiven).toBe(true);
    });
  });

  describe('processLeadMessage — no consent', () => {
    it('gracefully handles declined consent', async () => {
      const { service } = makeService();
      const phone = '+910000000040';

      await service.startLeadCollection(phone);
      await service.processLeadMessage(phone, 'Priya');
      await service.processLeadMessage(phone, 'Birthday party');
      await service.processLeadMessage(phone, 'Evenings');

      const result = await service.processLeadMessage(phone, 'No thank you');
      expect(result.complete).toBe(false);
      expect(result.lead).toBeNull();
      expect(result.reply).toMatch(/no problem|feel free|reach out/i);
    });
  });

  describe('processLeadMessage — idle state', () => {
    it('returns null reply when not in flow', async () => {
      const { service } = makeService();
      const result = await service.processLeadMessage('+910000000050', 'Hello');
      expect(result.reply).toBeNull();
      expect(result.complete).toBe(false);
    });
  });
});
