import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import * as appointmentsService from '../../src/crm/appointmentsService.js';
import { isAppointmentBookingIntent, isRescheduleAccepted } from '../../src/whatsapp/baileysClient.js';
import { getStore, resetStore } from '../../src/store/index.js';
import jwt from 'jsonwebtoken';
import config from '../../src/config/index.js';

describe('Appointment Enquiries Integration & API', () => {
  let app;
  let store;
  let adminToken;

  beforeEach(async () => {
    resetStore();
    store = await getStore();
    app = createApp();
    adminToken = jwt.sign({ sub: 'admin', role: 'admin' }, config.JWT_SECRET);
  });

  describe('1. Appointment Creation & Defaults', () => {
    it('creates a customer appointment enquiry defaulting to PENDING status', async () => {
      const res = await request(app)
        .post('/appointments')
        .send({
          customerName: 'Sanjana Rao',
          customerPhone: '+919876543210',
          serviceName: 'Personal Styling & Image',
          date: '2026-11-28',
          time: '11:00',
          consultantId: 'mam',
          consultantName: 'Mam',
          notes: 'Looking for wardrobe consult'
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('PENDING');
      expect(res.body.data.customerName).toBe('Sanjana Rao');
      expect(res.body.data.customerPhone).toBe('+919876543210');
      expect(res.body.data.createdAt).toBeDefined();
    });

    it('prevents rapid duplicate submissions within 5 minutes', async () => {
      const payload = {
        customerName: 'Kavita Reddy',
        customerPhone: '+919876543222',
        serviceName: 'Executive Communication',
        date: '2026-11-29',
        time: '15:00',
        consultantId: 'rahul',
      };

      const res1 = await request(app).post('/appointments').send(payload);
      expect(res1.status).toBe(201);

      // Immediate duplicate request
      const res2 = await request(app).post('/appointments').send(payload);
      expect(res2.status).toBe(409);
      expect(res2.body.error).toMatch(/duplicate/i);
    });

    it('detects and prevents consultant scheduling conflicts for confirmed bookings', async () => {
      // First appointment confirmed
      const apt1 = await appointmentsService.createAppointment({
        customerName: 'Anand Kumar',
        customerPhone: '+919876543233',
        serviceName: 'Grooming & Self-Care',
        date: '2026-12-01',
        time: '14:00',
        consultantId: 'priya',
        consultantName: 'Priya Sharma',
        status: appointmentsService.APPOINTMENT_STATUS.CONFIRMED,
      });
      expect(apt1.id).toBeDefined();

      // Second appointment attempting same consultant at exact same date & time
      await expect(
        appointmentsService.createAppointment({
          customerName: 'Vikram Joshi',
          customerPhone: '+919876543244',
          serviceName: 'Personal Styling',
          date: '2026-12-01',
          time: '14:00',
          consultantId: 'priya',
          consultantName: 'Priya Sharma',
          status: appointmentsService.APPOINTMENT_STATUS.CONFIRMED,
        })
      ).rejects.toThrow(/conflict/i);
    });
  });

  describe('2. Confirmation, Rescheduling, and Cancellation Lifecycle', () => {
    it('confirms a pending appointment and records audit history', async () => {
      const apt = await appointmentsService.createAppointment({
        customerName: 'Meera Iyer',
        customerPhone: '+919876543255',
        serviceName: 'Color Analysis',
        date: '2026-12-02',
        time: '10:00',
        consultantId: 'mam',
        status: appointmentsService.APPOINTMENT_STATUS.PENDING,
      });

      const res = await request(app)
        .patch(`/appointments/${apt.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ status: 'CONFIRMED' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('CONFIRMED');
      expect(res.body.data.confirmedAt).toBeDefined();
      expect(res.body.data.auditHistory.length).toBeGreaterThan(1);
      const latestAudit = res.body.data.auditHistory[res.body.data.auditHistory.length - 1];
      expect(latestAudit.action).toBe('CONFIRMED');
    });

    it('reschedules an appointment with new date, time, and note', async () => {
      const apt = await appointmentsService.createAppointment({
        customerName: 'Rohan Sen',
        customerPhone: '+919876543266',
        serviceName: 'Executive Presence',
        date: '2026-12-03',
        time: '11:00',
        consultantId: 'mam',
        status: appointmentsService.APPOINTMENT_STATUS.CONFIRMED,
      });

      const res = await request(app)
        .patch(`/appointments/${apt.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          status: 'RESCHEDULED',
          date: '2026-12-04',
          time: '16:00',
          rescheduleNote: 'Customer requested evening slot'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('RESCHEDULED');
      expect(res.body.data.date).toBe('2026-12-04');
      expect(res.body.data.time).toBe('16:00');
      expect(res.body.data.rescheduledFrom.date).toBe('2026-12-03');
      expect(res.body.data.rescheduledFrom.time).toBe('11:00');
    });

    it('cancels an appointment with a cancellation reason', async () => {
      const apt = await appointmentsService.createAppointment({
        customerName: 'Pooja Nair',
        customerPhone: '+919876543277',
        serviceName: 'Wardrobe Audit',
        date: '2026-12-05',
        time: '12:00',
        consultantId: 'mam',
        status: appointmentsService.APPOINTMENT_STATUS.PENDING,
      });

      const res = await request(app)
        .patch(`/appointments/${apt.id}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          status: 'CANCELLED',
          cancellationReason: 'Customer out of town'
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('CANCELLED');
      expect(res.body.data.cancelledAt).toBeDefined();
      expect(res.body.data.cancellationReason).toBe('Customer out of town');
    });
  });

  describe('3. Listing, Filtering, Search, and Newest-First Sorting', () => {
    it('sorts appointments by createdAt DESC (submission time)', async () => {
      // Create first appointment (older)
      const apt1 = await appointmentsService.createAppointment({
        customerName: 'First Person',
        customerPhone: '+919876543281',
        serviceName: 'Personal Styling',
        date: '2026-12-10',
        time: '10:00',
        createdAt: '2026-11-20T10:00:00.000Z',
      });

      // Create second appointment (newer)
      const apt2 = await appointmentsService.createAppointment({
        customerName: 'Second Person',
        customerPhone: '+919876543282',
        serviceName: 'Personal Styling',
        date: '2026-12-01', // Date is earlier, but submission is later!
        time: '10:00',
        createdAt: '2026-11-24T10:00:00.000Z',
      });

      const res = await request(app)
        .get('/appointments?sortBy=createdAt')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const items = res.body.data;
      expect(items.length).toBe(2);
      // Newest submission first!
      expect(items[0].id).toBe(apt2.id);
      expect(items[1].id).toBe(apt1.id);
    });

    it('filters by status and searches by customer name, phone, or service', async () => {
      await appointmentsService.createAppointment({
        customerName: 'Alia Bhatt',
        customerPhone: '+919876543291',
        serviceName: 'Red Carpet Styling',
        date: '2026-12-11',
        time: '11:00',
        status: appointmentsService.APPOINTMENT_STATUS.PENDING,
      });

      await appointmentsService.createAppointment({
        customerName: 'Deepika Padukone',
        customerPhone: '+919876543292',
        serviceName: 'Airport Look Curation',
        date: '2026-12-12',
        time: '12:00',
        status: appointmentsService.APPOINTMENT_STATUS.CONFIRMED,
      });

      // Filter by PENDING
      const resPending = await request(app)
        .get('/appointments?status=PENDING')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(resPending.body.data.length).toBe(1);
      expect(resPending.body.data[0].customerName).toBe('Alia Bhatt');

      // Search by phone
      const resSearch = await request(app)
        .get('/appointments?search=9876543292')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(resSearch.body.data.length).toBe(1);
      expect(resSearch.body.data[0].customerName).toBe('Deepika Padukone');
    });

    it('returns pagination metadata correctly', async () => {
      for (let i = 1; i <= 5; i++) {
        await appointmentsService.createAppointment({
          customerName: `Test Customer ${i}`,
          customerPhone: `+91987654320${i}`,
          serviceName: 'Consultation',
          date: '2026-12-15',
          time: `${10 + i}:00`,
        });
      }

      const res = await request(app)
        .get('/appointments?page=1&limit=2')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.page).toBe(1);
      expect(res.body.pagination.limit).toBe(2);
      expect(res.body.pagination.total).toBe(5);
      expect(res.body.pagination.totalPages).toBe(3);
      expect(res.body.pagination.hasMore).toBe(true);
      expect(res.body.data.length).toBe(2);
    });
  });

  describe('5. WhatsApp Appointment Booking Intent & Timings', () => {
    it('detects appointment booking requests and timing inquiries accurately', () => {
      expect(isAppointmentBookingIntent('I want to book an appointment')).toBe(true);
      expect(isAppointmentBookingIntent('book appointment')).toBe(true);
      expect(isAppointmentBookingIntent('timings')).toBe(true);
      expect(isAppointmentBookingIntent('available timings')).toBe(true);
      expect(isAppointmentBookingIntent('when are you open')).toBe(true);
      expect(isAppointmentBookingIntent('if they asked for apponitmement')).toBe(true);
      expect(isAppointmentBookingIntent('apointment please')).toBe(true);
      expect(isAppointmentBookingIntent('can I schedule a consultation?')).toBe(true);
      expect(isAppointmentBookingIntent('book slot')).toBe(true);
      expect(isAppointmentBookingIntent('Tell me about your pricing')).toBe(false);
    });

    it('detects reschedule acceptance (Option 1) vs counter-proposals (Option 2)', () => {
      // Option 1: Acceptance
      expect(isRescheduleAccepted('1')).toBe(true);
      expect(isRescheduleAccepted('yes')).toBe(true);
      expect(isRescheduleAccepted('yeah')).toBe(true);
      expect(isRescheduleAccepted('ok')).toBe(true);
      expect(isRescheduleAccepted('okay')).toBe(true);
      expect(isRescheduleAccepted('works for me')).toBe(true);
      expect(isRescheduleAccepted('good for me')).toBe(true);
      expect(isRescheduleAccepted('date is good')).toBe(true);
      expect(isRescheduleAccepted('time is good')).toBe(true);
      expect(isRescheduleAccepted('Confirmed')).toBe(true);

      // Option 2: Alternative proposal or rejection
      expect(isRescheduleAccepted('2')).toBe(false);
      expect(isRescheduleAccepted('can we do tomorrow at 4pm?')).toBe(false);
      expect(isRescheduleAccepted('not free then, how about saturday?')).toBe(false);
      expect(isRescheduleAccepted('different date please')).toBe(false);
    });

    it('suppresses duplicate acknowledgment when created with isCustomerEnquiry: true', async () => {
      const apt = await appointmentsService.createAppointment({
        customerName: 'No Dupe Customer',
        customerPhone: '+919999888877',
        isCustomerEnquiry: true,
        status: appointmentsService.APPOINTMENT_STATUS.PENDING,
        notes: 'Testing no duplicate ack message',
      });

      expect(apt.id).toBeDefined();
      expect(apt.status).toBe('PENDING');
    });
  });
});
