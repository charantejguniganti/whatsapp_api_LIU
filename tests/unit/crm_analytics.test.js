import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import * as crmService from '../../src/crm/crmService.js';
import * as appointmentsService from '../../src/crm/appointmentsService.js';
import { getStore, resetStore } from '../../src/store/index.js';
import { SERVICES } from '../../src/knowledge/packages.js';

describe('LIU CRM & Business Analytics Upgrade', () => {
  let app;
  let store;

  beforeEach(async () => {
    resetStore();
    store = await getStore();
    app = createApp();
  });

  describe('1. Appointments Service', () => {
    it('creates, lists, updates, and deletes appointments', async () => {
      const apt = await appointmentsService.createAppointment({
        customerPhone: '+919876543210',
        customerName: 'Aarav Mehta',
        serviceName: 'Personal Shopping',
        date: '2026-11-25',
        time: '14:00',
        consultantId: 'priya',
        consultantName: 'Priya Sharma',
      });

      expect(apt.id).toBeDefined();
      expect(apt.customerPhone).toBe('+919876543210');
      expect(apt.status).toBe('SCHEDULED');

      // List appointments
      const list = await appointmentsService.listAppointments({ date: '2026-11-25' });
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(apt.id);

      // Update appointment status to COMPLETED
      const updated = await appointmentsService.updateAppointment(apt.id, {
        status: appointmentsService.APPOINTMENT_STATUS.COMPLETED,
      });
      expect(updated.status).toBe('COMPLETED');

      // Delete appointment
      const del = await appointmentsService.deleteAppointment(apt.id);
      expect(del.success).toBe(true);

      const remaining = await appointmentsService.listAppointments();
      expect(remaining.length).toBe(0);
    });
  });

  describe('2. CRM Analytics Engine & Calculations', () => {
    it('calculates Dashboard KPIs from real database records', async () => {
      const phone = '+919876543211';
      const now = new Date().toISOString();

      // Seed a real conversation
      await store.set(`conv:${phone}`, {
        phone,
        customerName: 'Divya Kapoor',
        state: 'AI_ACTIVE',
        status: 'In Progress',
        interest: 'Image Consulting',
        lastMessage: 'I want to schedule a session',
        lastMessageRole: 'user', // Customer sent last message -> pending response!
        lastMessageAt: now,
        updatedAt: now,
      });

      // Seed a completed questionnaire
      await store.set(`quiz:${phone}`, {
        whatsappNumber: phone,
        status: 'COMPLETED',
        quizState: 'ANALYSING',
        consultantRequested: true,
        consultantRequestedAt: now,
        answers: { interest: 'Image Consulting' },
        createdAt: now,
        updatedAt: now,
      });

      // Seed an appointment
      await appointmentsService.createAppointment({
        customerPhone: phone,
        customerName: 'Divya Kapoor',
        serviceName: 'Image Consulting',
        date: '2026-11-26',
        time: '11:00',
        consultantId: 'mam',
        consultantName: 'Mam',
      });

      const kpis = await crmService.getDashboardKPIs({ timeRange: '7d' });
      expect(kpis.cards).toBeDefined();
      expect(kpis.cards.length).toBe(8);

      const totalConvs = kpis.cards.find((c) => c.id === 'total_conversations');
      const consultantReqs = kpis.cards.find((c) => c.id === 'consultant_requests');
      const aptsBooked = kpis.cards.find((c) => c.id === 'appointments_booked');
      const pendingResps = kpis.cards.find((c) => c.id === 'pending_responses');

      expect(totalConvs.current).toBe(1);
      expect(consultantReqs.current).toBe(1);
      expect(aptsBooked.current).toBe(1);
      expect(pendingResps.current).toBe(1);
    });

    it('computes all 9 stages in the Enquiry Conversion Funnel', async () => {
      const phone = '+919876543212';
      const now = new Date().toISOString();

      await store.set(`conv:${phone}`, {
        phone,
        customerName: 'Sanjay Dutt',
        status: 'New',
        interest: 'Communication Skills',
        lastMessageRole: 'assistant',
        lastMessageAt: now,
        updatedAt: now,
      });

      await store.set(`quiz:${phone}`, {
        whatsappNumber: phone,
        status: 'COMPLETED',
        quizState: 'ANALYSING',
        consultantRequested: true,
        consultantRequestedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const funnelData = await crmService.getEnquiryFunnel({ timeRange: '7d' });
      expect(funnelData.funnel).toBeDefined();
      expect(funnelData.funnel.length).toBe(9);

      const stageLabels = funnelData.funnel.map((s) => s.label);
      expect(stageLabels).toContain('New Enquiries');
      expect(stageLabels).toContain('Questionnaire Started');
      expect(stageLabels).toContain('Questionnaire Completed');
      expect(stageLabels).toContain('Qualified Leads');
      expect(stageLabels).toContain('Waiting for Customer');
      expect(stageLabels).toContain('Consultant Requested');
      expect(stageLabels).toContain('Appointment Scheduled');
      expect(stageLabels).toContain('Converted Customers');
      expect(stageLabels).toContain('Lost Enquiries');
    });

    it('tracks customer response SLA and waiting duration accurately', async () => {
      const phone = '+919876543213';
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

      await store.set(`conv:${phone}`, {
        phone,
        customerName: 'Meera Nair',
        status: 'In Progress',
        lastMessage: 'Could you give me a call tomorrow?',
        lastMessageRole: 'user', // customer sent message 2 hours ago
        lastMessageAt: twoHoursAgo,
        updatedAt: twoHoursAgo,
      });

      const responseTracking = await crmService.getCustomerResponseTracking({ filter: 'waiting_team' });
      expect(responseTracking.summary.waitingForTeam).toBe(1);
      expect(responseTracking.items.length).toBe(1);
      expect(responseTracking.items[0].waitingType).toBe('waiting_team');
      expect(responseTracking.items[0].waitingHours).toBeGreaterThanOrEqual(2);
    });

    it('returns questionnaire completion analysis and drop-off distribution', async () => {
      const phone = '+919876543214';
      const now = new Date().toISOString();

      await store.set(`quiz:${phone}`, {
        whatsappNumber: phone,
        status: 'IN_PROGRESS',
        quizState: 'AWAITING_Q3',
        answers: { interest: 'Posture & Body Language' },
        createdAt: now,
        updatedAt: now,
      });

      const analytics = await crmService.getQuestionnaireAnalytics({ timeRange: '7d' });
      expect(analytics.totalStarted).toBe(1);
      expect(analytics.totalIncomplete).toBe(1);
      expect(analytics.dropOffCounts.Q3).toBe(1);
      expect(analytics.incompleteTable.length).toBe(1);
      expect(analytics.incompleteTable[0].phone).toBe(phone);
    });

    it('returns services catalogue with approved pricing from packages.js', async () => {
      const services = await crmService.getServicesWithMetrics();
      expect(Array.isArray(services)).toBe(true);
      expect(services.length).toBe(Object.keys(SERVICES).length);

      const personalShopping = services.find((s) => s.id === 'personalShopping');
      expect(personalShopping).toBeDefined();
      expect(personalShopping.price).toBe(15000);
      expect(personalShopping.basis).toBe('3 hours');
    });

    it('generates downloadable CSV reports', async () => {
      const csv = await crmService.exportReportsCSV('all', '30d');
      expect(typeof csv).toBe('string');
      expect(csv).toContain('Metric Category,Metric Name,Value,Notes');
      expect(csv).toContain('Conversations,Total Active Conversations');
      expect(csv).toContain('Appointments,Total Appointments Booked');
    });
  });

  describe('3. CRM REST API Endpoints', () => {
    it('GET /api/crm/kpis returns KPI overview', async () => {
      const res = await request(app).get('/api/crm/kpis?timeRange=7d');
      expect(res.status).toBe(200);
      expect(res.body.cards).toBeDefined();
      expect(res.body.cards.length).toBe(8);
    });

    it('GET /api/crm/funnel returns 9 stages', async () => {
      const res = await request(app).get('/api/crm/funnel');
      expect(res.status).toBe(200);
      expect(res.body.funnel.length).toBe(9);
    });

    it('GET /api/crm/response-tracking returns summary and items', async () => {
      const res = await request(app).get('/api/crm/response-tracking');
      expect(res.status).toBe(200);
      expect(res.body.summary).toBeDefined();
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('GET /api/crm/questionnaire-analytics returns questionnaire stats', async () => {
      const res = await request(app).get('/api/crm/questionnaire-analytics');
      expect(res.status).toBe(200);
      expect(res.body.totalStarted).toBeDefined();
      expect(res.body.completionRate).toBeDefined();
    });

    it('GET /api/crm/services returns verified service catalogue', async () => {
      const res = await request(app).get('/api/crm/services');
      expect(res.status).toBe(200);
      expect(res.body.services.length).toBeGreaterThan(5);
    });

    it('GET /api/crm/team returns consultants and metrics', async () => {
      const res = await request(app).get('/api/crm/team');
      expect(res.status).toBe(200);
      expect(res.body.team.length).toBeGreaterThanOrEqual(4);
    });

    it('POST /api/crm/assign assigns consultant to customer conversation', async () => {
      const phone = '+919876543299';
      await store.set(`conv:${phone}`, { phone, status: 'New' });

      const res = await request(app)
        .post('/api/crm/assign')
        .send({ phone, consultantId: 'priya', consultantName: 'Priya Sharma' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const conv = await store.get(`conv:${phone}`);
      expect(conv.claimedBy).toBe('Priya Sharma');
    });

    it('GET /api/crm/reports/csv returns text/csv download', async () => {
      const res = await request(app).get('/api/crm/reports/csv');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.text).toContain('Metric Category');
    });
  });

  describe('4. Dashboard Navigation & UI Requirements Verification', () => {
    it('verifies exact 8 navbar items in index.html with NO FAQ or Questionnaire tabs', async () => {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);

      // Verify exact 8 nav items
      expect(res.text).toContain('href="#dashboard"');
      expect(res.text).toContain('href="#conversations"');
      expect(res.text).toContain('href="#enquiries"');
      expect(res.text).toContain('href="#calendar"');
      expect(res.text).toContain('href="#reports"');
      expect(res.text).toContain('href="#services"');
      expect(res.text).toContain('href="#team"');
      expect(res.text).toContain('href="#settings"');

      // STRICT REQUIREMENT: No FAQ Management or Questionnaire in navbar
      expect(res.text).not.toContain('FAQ Management');
      expect(res.text).not.toContain('href="#faq"');
      expect(res.text).not.toContain('href="#questionnaire"');

      // Verify views are present in app shell
      expect(res.text).toContain('id="view-dashboard"');
      expect(res.text).toContain('id="view-conversations"');
      expect(res.text).toContain('id="view-enquiries"');
      expect(res.text).toContain('id="view-calendar"');
      expect(res.text).toContain('id="view-reports"');
      expect(res.text).toContain('id="view-services"');
      expect(res.text).toContain('id="view-team"');

      // Verify modals
      expect(res.text).toContain('id="stage-customers-modal"');
      expect(res.text).toContain('id="appointment-modal"');
      expect(res.text).toContain('id="reassign-modal"');
      expect(res.text).toContain('id="settings-modal"');
    });
  });
});
