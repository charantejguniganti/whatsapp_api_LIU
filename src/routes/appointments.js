/**
 * Appointments API Routes
 * Supports CRUD, listing, conflict checking, approval, rescheduling, and cancellation.
 */
import { Router } from 'express';
import { requireAuth } from '../admin/auth.js';
import * as appointmentsService from '../crm/appointmentsService.js';
import logger from '../logger.js';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';

const router = Router();

/**
 * Optional authentication helper: identifies admin if token provided, but doesn't block.
 */
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const cookieToken = req.cookies?.admin_token;
  const activeToken = token || cookieToken;

  if (activeToken) {
    try {
      const payload = jwt.verify(activeToken, config.JWT_SECRET);
      req.admin = payload;
    } catch (_err) {
      // ignore invalid token for optional auth
    }
  }
  next();
}

// ── GET /appointments ────────────────────────────────────────────────────────
// Retrieve appointment enquiries with filtering, newest-first sorting, and pagination
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { status, search, page, limit, consultantId, from, to, sortBy } = req.query;

    const result = await appointmentsService.listAppointments({
      status,
      search,
      consultantId,
      from,
      to,
      sortBy: sortBy || 'createdAt',
      paginate: true,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 12,
    });

    return res.json({
      success: true,
      data: result.appointments,
      pagination: result.pagination,
      // Convenience alias for existing calendar integration
      appointments: result.appointments,
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /appointments/:id ────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const apt = await appointmentsService.getAppointment(req.params.id);
    if (!apt) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }
    return res.json({ success: true, data: apt, appointment: apt });
  } catch (err) {
    next(err);
  }
});

// ── POST /appointments ───────────────────────────────────────────────────────
// Create a new appointment enquiry. Defaults status to PENDING.
router.post('/', optionalAuth, async (req, res, next) => {
  try {
    const { customerName, phone, customerPhone, service, serviceName, date, time, appointmentDateTime, consultantId, notes } = req.body ?? {};

    const rawPhone = phone || customerPhone;
    if (!rawPhone) {
      return res.status(400).json({ success: false, error: 'Customer phone number is required' });
    }

    const payload = {
      ...req.body,
      isCustomerEnquiry: true,
      status: req.body.status || appointmentsService.APPOINTMENT_STATUS.PENDING,
      customerName: (customerName || rawPhone).trim(),
      phone: rawPhone.trim(),
      customerPhone: rawPhone.trim(),
      service: service || serviceName || 'Personal Consultation',
      serviceName: service || serviceName || 'Personal Consultation',
      date: date || (appointmentDateTime ? appointmentDateTime.split('T')[0] : new Date().toISOString().split('T')[0]),
      time: time || (appointmentDateTime && appointmentDateTime.includes('T') ? appointmentDateTime.split('T')[1].substring(0, 5) : '10:00'),
      consultantId: consultantId || 'mam',
      notes: notes || '',
      createdBy: req.admin?.sub ? `Admin (${req.admin.sub})` : 'Customer',
    };

    // Unauthenticated requests are strictly PENDING
    if (!req.admin) {
      payload.status = appointmentsService.APPOINTMENT_STATUS.PENDING;
    }

    const apt = await appointmentsService.createAppointment(payload);
    return res.status(201).json({
      success: true,
      data: apt,
      appointment: apt,
    });
  } catch (err) {
    if (err.message && (err.message.toLowerCase().includes('conflict') || err.message.toLowerCase().includes('duplicate'))) {
      return res.status(409).json({ success: false, error: err.message });
    }
    next(err);
  }
});

// ── PATCH /appointments/:id ──────────────────────────────────────────────────
// Update appointment status (confirm, reschedule, cancel, notes, consultant)
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    const updates = req.body ?? {};
    const adminUser = req.admin?.sub || 'LIU Team';

    const existing = await appointmentsService.getAppointment(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Appointment not found' });
    }

    let updated;
    if (updates.status === 'CONFIRMED' || updates.status === 'SCHEDULED') {
      updated = await appointmentsService.confirmAppointment(id, {
        confirmedBy: adminUser,
        notes: updates.notes,
      });
    } else if (updates.status === 'CANCELLED') {
      updated = await appointmentsService.cancelAppointment(id, {
        cancellationReason: updates.cancellationReason || updates.notes || 'Cancelled by team',
        cancelledBy: adminUser,
      });
    } else if (updates.status === 'RESCHEDULED' || (updates.date && updates.time)) {
      updated = await appointmentsService.rescheduleAppointment(id, {
        ...updates,
        rescheduledBy: adminUser,
      });
    } else {
      updated = await appointmentsService.updateAppointment(id, updates);
    }

    return res.json({ success: true, data: updated, appointment: updated });
  } catch (err) {
    if (err.message && (err.message.toLowerCase().includes('conflict') || err.message.toLowerCase().includes('duplicate'))) {
      return res.status(409).json({ success: false, error: err.message });
    }
    next(err);
  }
});

// ── PUT /appointments/:id (compatibility alias for calendar) ─────────────────
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const id = req.params.id;
    const updates = req.body ?? {};
    const adminUser = req.admin?.sub || 'LIU Team';

    let updated;
    if (updates.status === 'CONFIRMED' || updates.status === 'SCHEDULED') {
      updated = await appointmentsService.confirmAppointment(id, { confirmedBy: adminUser, notes: updates.notes });
    } else if (updates.status === 'CANCELLED') {
      updated = await appointmentsService.cancelAppointment(id, { cancellationReason: updates.cancellationReason || updates.notes, cancelledBy: adminUser });
    } else {
      updated = await appointmentsService.updateAppointment(id, updates);
    }
    return res.json({ success: true, data: updated, appointment: updated });
  } catch (err) {
    if (err.message && (err.message.toLowerCase().includes('conflict') || err.message.toLowerCase().includes('duplicate'))) {
      return res.status(409).json({ success: false, error: err.message });
    }
    next(err);
  }
});

// ── DELETE /appointments/:id ─────────────────────────────────────────────────
// Soft-delete / Archive appointment to preserve historical records
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await appointmentsService.deleteAppointment(req.params.id, { soft: true });
    return res.json({ success: true, message: 'Appointment archived successfully', ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
