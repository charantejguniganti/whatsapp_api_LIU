/**
 * LIU CRM API Routes
 * Serves live business intelligence, analytics, enquiry tracking,
 * calendar appointments, and service/team management.
 */
import { Router } from 'express';
import * as crmService from '../crm/crmService.js';
import * as appointmentsService from '../crm/appointmentsService.js';
import { getStore } from '../store/index.js';
import logger from '../logger.js';

const router = Router();

// ── KPI Overview ─────────────────────────────────────────────────────────────
router.get('/kpis', async (req, res, next) => {
  try {
    const { timeRange, from, to } = req.query;
    const kpis = await crmService.getDashboardKPIs({ timeRange, from, to });
    return res.json(kpis);
  } catch (err) {
    next(err);
  }
});

// ── Enquiry Progress Funnel ──────────────────────────────────────────────────
router.get('/funnel', async (req, res, next) => {
  try {
    const { timeRange, from, to } = req.query;
    const funnel = await crmService.getEnquiryFunnel({ timeRange, from, to });
    return res.json(funnel);
  } catch (err) {
    next(err);
  }
});

// ── Customer Response Tracking ───────────────────────────────────────────────
router.get('/response-tracking', async (req, res, next) => {
  try {
    const { filter, timeRange } = req.query;
    const data = await crmService.getCustomerResponseTracking({ filter, timeRange });
    return res.json(data);
  } catch (err) {
    next(err);
  }
});

// ── Questionnaire Analytics ─────────────────────────────────────────────────
router.get('/questionnaire-analytics', async (req, res, next) => {
  try {
    const { timeRange, service } = req.query;
    const data = await crmService.getQuestionnaireAnalytics({ timeRange, service });
    return res.json(data);
  } catch (err) {
    next(err);
  }
});

// ── Enquiry Analytics ───────────────────────────────────────────────────────
router.get('/enquiry-analytics', async (req, res, next) => {
  try {
    const { timeRange, service } = req.query;
    const data = await crmService.getEnquiryAnalytics({ timeRange, service });
    return res.json(data);
  } catch (err) {
    next(err);
  }
});

// ── Pending Actions Widget ──────────────────────────────────────────────────
router.get('/pending-actions', async (_req, res, next) => {
  try {
    const actions = await crmService.getPendingActions();
    return res.json({ actions });
  } catch (err) {
    next(err);
  }
});

// ── Services Catalogue with Real Performance ─────────────────────────────────
router.get('/services', async (_req, res, next) => {
  try {
    const services = await crmService.getServicesWithMetrics();
    return res.json({ services });
  } catch (err) {
    next(err);
  }
});

// ── Team Members & Consultant Performance ────────────────────────────────────
router.get('/team', async (_req, res, next) => {
  try {
    const team = await crmService.getTeamWithMetrics();
    return res.json({ team });
  } catch (err) {
    next(err);
  }
});

// ── Assign / Reassign Consultant ─────────────────────────────────────────────
router.post('/assign', async (req, res, next) => {
  try {
    const { phone, consultantId, consultantName } = req.body;
    if (!phone || !consultantId) {
      return res.status(400).json({ error: 'Missing phone or consultantId' });
    }

    const store = await getStore();
    const conv = await store.get(`conv:${phone}`);
    if (conv) {
      conv.claimedBy = consultantName || consultantId;
      conv.assignedAt = new Date().toISOString();
      await store.set(`conv:${phone}`, conv);
    }

    return res.json({ success: true, message: `Assigned ${phone} to ${consultantName || consultantId}` });
  } catch (err) {
    next(err);
  }
});

// ── Calendar & Appointments ──────────────────────────────────────────────────
router.get('/appointments', async (req, res, next) => {
  try {
    const { date, consultantId, status, from, to } = req.query;
    const appointments = await appointmentsService.listAppointments({ date, consultantId, status, from, to });
    const consultants = await appointmentsService.getConsultants();
    return res.json({ appointments, consultants });
  } catch (err) {
    next(err);
  }
});

router.post('/appointments', async (req, res, next) => {
  try {
    const apt = await appointmentsService.createAppointment(req.body);
    return res.status(201).json({ success: true, appointment: apt });
  } catch (err) {
    next(err);
  }
});

router.put('/appointments/:id', async (req, res, next) => {
  try {
    const apt = await appointmentsService.updateAppointment(req.params.id, req.body);
    return res.json({ success: true, appointment: apt });
  } catch (err) {
    next(err);
  }
});

router.delete('/appointments/:id', async (req, res, next) => {
  try {
    await appointmentsService.deleteAppointment(req.params.id);
    return res.json({ success: true, message: 'Appointment deleted' });
  } catch (err) {
    next(err);
  }
});

// ── Reports & CSV Export ─────────────────────────────────────────────────────
router.get('/reports', async (req, res, next) => {
  try {
    const { timeRange, from, to } = req.query;
    const data = await crmService.getReportsData({ timeRange, from, to });
    return res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/reports/csv', async (req, res, next) => {
  try {
    const { reportType, timeRange } = req.query;
    const csv = await crmService.exportReportsCSV(reportType, timeRange);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=liu_crm_report_${Date.now()}.csv`);
    return res.send(csv);
  } catch (err) {
    next(err);
  }
});

export default router;
