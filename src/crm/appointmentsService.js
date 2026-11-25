/**
 * Appointments Service for LIU CRM
 * Manages consultation bookings, schedules, conflict checking,
 * audit history, and status tracking.
 */
import { getStore } from '../store/index.js';
import logger from '../logger.js';
import crypto from 'crypto';

const INDEX_KEY = 'appointments:index';

export const APPOINTMENT_STATUS = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  SCHEDULED: 'SCHEDULED', // alias for confirmed
  RESCHEDULED: 'RESCHEDULED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW',
};

export const DEFAULT_CONSULTANTS = [
  { id: 'mam', name: 'Mam', role: 'Director & Lead Consultant', email: 'director@liveitup.co.in', phone: '+91 98765 00001', active: true },
  { id: 'priya', name: 'Priya Sharma', role: 'Senior Styling & Image Consultant', email: 'priya@liveitup.co.in', phone: '+91 98765 00002', active: true },
  { id: 'ananya', name: 'Ananya Roy', role: 'Grooming & Etiquette Specialist', email: 'ananya@liveitup.co.in', phone: '+91 98765 00003', active: true },
  { id: 'rahul', name: 'Rahul Verma', role: 'Executive Communication Coach', email: 'rahul@liveitup.co.in', phone: '+91 98765 00004', active: true },
];

/**
 * Send WhatsApp text safely without failing caller.
 */
async function safeSendWhatsApp(phone, message) {
  if (!phone || !message) return false;
  try {
    const { sendTextMessage } = await import('../whatsapp/client.js');
    await sendTextMessage(phone, message);
    logger.info({ phone }, 'WhatsApp appointment notification sent');
    return true;
  } catch (err) {
    logger.warn({ err: err.message, phone }, 'Could not send WhatsApp appointment notification');
    return false;
  }
}

/**
 * Send native push notification safely.
 */
async function safeSendPush(payload) {
  try {
    const { sendPushNotification } = await import('../push/pushService.js');
    await sendPushNotification(payload, { isConsultantRequest: true });
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, 'Could not send appointment push notification');
    return false;
  }
}

/**
 * Get all consultants.
 */
export async function getConsultants() {
  const store = await getStore();
  const custom = await store.get('crm:consultants');
  if (Array.isArray(custom) && custom.length > 0) {
    return custom;
  }
  return DEFAULT_CONSULTANTS;
}

/**
 * Save custom consultants list.
 */
export async function saveConsultants(list) {
  const store = await getStore();
  await store.set('crm:consultants', list);
}

/**
 * Check if consultant has an overlapping confirmed/scheduled appointment.
 * @returns {Promise<Object|null>} The conflicting appointment or null if clear.
 */
export async function checkConsultantConflict({ consultantId, date, time, durationMinutes = 60, excludeId = null }) {
  if (!consultantId || !date || !time) return null;
  const store = await getStore();
  const index = (await store.get(INDEX_KEY)) || [];

  const reqStart = new Date(`${date}T${time}:00`).getTime();
  const reqEnd = reqStart + durationMinutes * 60 * 1000;

  for (const id of index) {
    if (excludeId && id === excludeId) continue;
    const apt = await store.get(`appointment:${id}`);
    if (!apt || apt.isArchived) continue;
    if (apt.consultantId !== consultantId) continue;

    // Only confirmed/scheduled appointments occupy a consultant's calendar
    if (apt.status !== APPOINTMENT_STATUS.CONFIRMED && apt.status !== APPOINTMENT_STATUS.SCHEDULED) {
      continue;
    }
    if (apt.date !== date) continue;

    const aptStart = new Date(`${apt.date}T${apt.time || '10:00'}:00`).getTime();
    const aptDuration = apt.durationMinutes || 60;
    const aptEnd = aptStart + aptDuration * 60 * 1000;

    if (reqStart < aptEnd && reqEnd > aptStart) {
      return apt;
    }
  }
  return null;
}

/**
 * Check for duplicate appointment request submitted within 5 minutes.
 */
export async function checkDuplicateSubmission({ phone, date, time, service }) {
  if (!phone) return null;
  const store = await getStore();
  const index = (await store.get(INDEX_KEY)) || [];
  const now = Date.now();
  const FIVE_MINUTES = 5 * 60 * 1000;

  for (const id of index) {
    const apt = await store.get(`appointment:${id}`);
    if (!apt || apt.isArchived) continue;
    const aptPhone = apt.phone || apt.customerPhone;
    if (aptPhone === phone && apt.date === date && apt.time === time) {
      const createdTime = new Date(apt.createdAt).getTime();
      if (now - createdTime < FIVE_MINUTES) {
        return apt;
      }
    }
  }
  return null;
}

/**
 * List all appointments with optional filtering, sorting, and pagination.
 *
 * @param {Object} [filters]
 * @param {string} [filters.status]
 * @param {string} [filters.search]
 * @param {string} [filters.consultantId]
 * @param {string} [filters.customerPhone]
 * @param {string} [filters.date]
 * @param {string} [filters.from]
 * @param {string} [filters.to]
 * @param {string} [filters.sortBy] - 'createdAt' | 'appointmentDateTime'
 * @param {boolean} [filters.paginate] - if true, returns { appointments, pagination }
 * @param {number} [filters.page]
 * @param {number} [filters.limit]
 * @returns {Promise<Array<Object>|Object>}
 */
export async function listAppointments(filters = {}) {
  const store = await getStore();
  const index = (await store.get(INDEX_KEY)) || [];
  if (!Array.isArray(index) || index.length === 0) {
    if (filters.paginate) {
      return {
        appointments: [],
        pagination: { page: 1, limit: filters.limit || 12, total: 0, totalPages: 0, hasNextPage: false }
      };
    }
    return [];
  }

  const all = [];
  for (const id of index) {
    const item = await store.get(`appointment:${id}`);
    if (item && item.id && !item.isArchived) {
      // Normalise phone & service naming aliases
      item.phone = item.phone || item.customerPhone || '';
      item.customerPhone = item.phone;
      item.service = item.service || item.serviceName || 'Personal Consultation';
      item.serviceName = item.service;
      item.appointmentDateTime = item.appointmentDateTime || (item.date && item.time ? `${item.date}T${item.time}:00` : item.createdAt);
      all.push(item);
    }
  }

  // Filter
  const filtered = all.filter((apt) => {
    if (filters.date && apt.date !== filters.date) return false;
    if (filters.consultantId && apt.consultantId !== filters.consultantId) return false;
    if (filters.customerPhone && apt.phone !== filters.customerPhone) return false;

    if (filters.status && filters.status !== 'all' && filters.status !== 'ALL') {
      const matchStatus = filters.status.toUpperCase();
      const itemStatus = (apt.status || '').toUpperCase();
      if (matchStatus === 'CONFIRMED') {
        if (itemStatus !== 'CONFIRMED' && itemStatus !== 'SCHEDULED') return false;
      } else if (itemStatus !== matchStatus) {
        return false;
      }
    }

    if (filters.search && filters.search.trim()) {
      const q = filters.search.toLowerCase().trim();
      const name = (apt.customerName || '').toLowerCase();
      const phone = (apt.phone || '').toLowerCase();
      const service = (apt.service || '').toLowerCase();
      const consultant = (apt.consultantName || '').toLowerCase();
      if (!name.includes(q) && !phone.includes(q) && !service.includes(q) && !consultant.includes(q)) {
        return false;
      }
    }

    if (filters.from) {
      const fromTime = new Date(filters.from).getTime();
      const aptTime = new Date(apt.appointmentDateTime || `${apt.date}T${apt.time || '00:00'}`).getTime();
      if (aptTime < fromTime) return false;
    }
    if (filters.to) {
      const toTime = new Date(filters.to).getTime();
      const aptTime = new Date(apt.appointmentDateTime || `${apt.date}T${apt.time || '23:59'}`).getTime();
      if (aptTime > toTime) return false;
    }

    return true;
  });

  // Sort
  // Default sorting for Enquiries view is createdAt DESC, id DESC
  // Calendar callers can pass sortBy: 'appointmentDateTime' for chronological schedule
  if (filters.sortBy === 'appointmentDateTime') {
    filtered.sort((a, b) => {
      const tA = new Date(a.appointmentDateTime || `${a.date}T${a.time || '00:00'}`).getTime();
      const tB = new Date(b.appointmentDateTime || `${b.date}T${b.time || '00:00'}`).getTime();
      if (tA !== tB) return tA - tB;
      return String(b.id).localeCompare(String(a.id));
    });
  } else {
    filtered.sort((a, b) => {
      const dateDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (dateDiff !== 0) return dateDiff;
      return String(b.id).localeCompare(String(a.id));
    });
  }

  // Pagination
  if (filters.paginate) {
    const page = Math.max(1, parseInt(filters.page, 10) || 1);
    const limit = Math.max(1, parseInt(filters.limit, 10) || 12);
    const total = filtered.length;
    const totalPages = Math.ceil(total / limit) || 0;
    const offset = (page - 1) * limit;
    const paginated = filtered.slice(offset, offset + limit);

    return {
      appointments: paginated,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages,
        hasNextPage: page < totalPages,
      },
    };
  }

  return filtered;
}

/**
 * Get an appointment by ID.
 * @param {string} id
 */
export async function getAppointment(id) {
  const store = await getStore();
  const apt = await store.get(`appointment:${id}`);
  if (!apt) return null;

  apt.phone = apt.phone || apt.customerPhone || '';
  apt.customerPhone = apt.phone;
  apt.service = apt.service || apt.serviceName || 'Personal Consultation';
  apt.serviceName = apt.service;
  return apt;
}

/**
 * Create a new appointment enquiry.
 * Defaults status to PENDING.
 * @param {Object} data
 */
export async function createAppointment(data) {
  const store = await getStore();
  const id = data.id || `apt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();

  const phone = (data.phone || data.customerPhone || '').trim();
  const customerName = (data.customerName || phone || 'Valued Customer').trim();
  const service = data.service || data.serviceName || 'LIU Personal Consultation';
  const date = data.date || (data.appointmentDateTime ? data.appointmentDateTime.split('T')[0] : new Date().toISOString().split('T')[0]);
  const time = data.time || (data.appointmentDateTime && data.appointmentDateTime.includes('T') ? data.appointmentDateTime.split('T')[1].substring(0, 5) : '10:00');
  const appointmentDateTime = data.appointmentDateTime || `${date}T${time}:00`;
  const consultantId = data.consultantId || 'mam';
  const consultantName = data.consultantName || 'Mam';

  // Check duplicate submission
  const duplicate = await checkDuplicateSubmission({ phone, date, time, service });
  if (duplicate) {
    logger.warn({ id: duplicate.id, phone }, 'Duplicate appointment submission prevented');
    throw new Error(`Duplicate appointment request: An enquiry for ${phone} on ${date} at ${time} was already submitted within the last 5 minutes.`);
  }

  // Check consultant conflict if explicitly submitted as confirmed
  if (data.status === APPOINTMENT_STATUS.CONFIRMED || data.status === APPOINTMENT_STATUS.SCHEDULED) {
    const conflict = await checkConsultantConflict({ consultantId, date, time, durationMinutes: data.durationMinutes || 60 });
    if (conflict) {
      throw new Error(`Scheduling conflict: ${consultantName} already has an appointment booked at ${date} ${time}`);
    }
  }

  const status = data.status || (data.isCustomerEnquiry ? APPOINTMENT_STATUS.PENDING : APPOINTMENT_STATUS.SCHEDULED);

  const appointment = {
    id,
    customerName,
    phone,
    customerPhone: phone,
    service,
    serviceName: service,
    serviceId: data.serviceId || 'consultation',
    consultantId,
    consultantName,
    appointmentDateTime,
    date,
    time,
    durationMinutes: data.durationMinutes || 60,
    status,
    notes: data.notes || '',
    meetingLink: data.meetingLink || '',
    location: data.location || 'LIU Studio & WhatsApp Video',
    conversationId: data.conversationId || phone || null,
    enquiryId: data.enquiryId || null,
    questionnaireSessionId: data.questionnaireSessionId || null,
    requestedDateTime: appointmentDateTime,
    confirmedAt: status === APPOINTMENT_STATUS.CONFIRMED ? now : null,
    confirmedBy: status === APPOINTMENT_STATUS.CONFIRMED ? (data.confirmedBy || 'Mam') : null,
    cancelledAt: null,
    cancellationReason: null,
    rescheduledFrom: null,
    rescheduledAt: null,
    timezone: 'Asia/Kolkata',
    createdAt: now,
    updatedAt: now,
    history: [
      {
        action: 'SUBMITTED',
        status,
        timestamp: now,
        by: data.createdBy || 'Customer',
        notes: data.notes || 'Initial appointment request submitted',
      },
    ],
    auditHistory: [
      {
        action: 'SUBMITTED',
        status,
        timestamp: now,
        by: data.createdBy || 'Customer',
        notes: data.notes || 'Initial appointment request submitted',
      },
    ],
  };

  await store.set(`appointment:${id}`, appointment);

  const index = (await store.get(INDEX_KEY)) || [];
  if (!index.includes(id)) {
    index.push(id);
    await store.set(INDEX_KEY, index);
  }

  // Link to customer conversation
  if (phone) {
    try {
      const conv = await store.get(`conv:${phone}`);
      if (conv) {
        conv.appointmentId = id;
        conv.appointmentDate = `${date} ${time}`;
        conv.status = 'Consultant Requested';
        await store.set(`conv:${phone}`, conv);
      }
    } catch (e) {
      logger.warn({ err: e }, 'Could not link appointment to conversation');
    }

    // Customer acknowledgement via WhatsApp (if newly requested as PENDING)
    if (status === APPOINTMENT_STATUS.PENDING) {
      const ackMsg =
        `🙏 Thank you for submitting your appointment request!\n\n` +
        `Your booking is *NOT CONFIRMED* yet.\n\n` +
        `Our LIU team is reviewing your request for *${service}* on *${date}* at *${time}* and checking the consultant's availability.\n\n` +
        `We will get back to you as soon as possible.\n\n` +
        `Thank you for your patience! ❤️\n\nTeam Live It Up`;

      safeSendWhatsApp(phone, ackMsg).catch(() => {});
    }

    // Notify team via Push
    safeSendPush({
      title: '📅 New Appointment Request',
      body: `${customerName} requested an appointment for ${service} on ${date} at ${time}.`,
      data: { phone, appointmentId: id, url: '/dashboard/#enquiries' },
    }).catch(() => {});
  }

  logger.info({ id, customer: customerName, date, time, status }, 'Created appointment');
  return appointment;
}

/**
 * Confirm a pending appointment.
 */
export async function confirmAppointment(id, { confirmedBy = 'Mam', notes = '' } = {}) {
  const store = await getStore();
  const existing = await store.get(`appointment:${id}`);
  if (!existing) {
    throw new Error(`Appointment ${id} not found`);
  }

  // Conflict validation
  const conflict = await checkConsultantConflict({
    consultantId: existing.consultantId,
    date: existing.date,
    time: existing.time,
    durationMinutes: existing.durationMinutes,
    excludeId: id,
  });
  if (conflict) {
    throw new Error(`Cannot confirm appointment: ${existing.consultantName || 'Consultant'} has an overlapping booking with ${conflict.customerName} on ${existing.date} at ${existing.time}.`);
  }

  const now = new Date().toISOString();
  const auditEntry = {
    action: 'CONFIRMED',
    status: APPOINTMENT_STATUS.CONFIRMED,
    timestamp: now,
    by: confirmedBy,
    notes: notes || 'Appointment explicitly confirmed by LIU team',
  };

  const updated = {
    ...existing,
    status: APPOINTMENT_STATUS.CONFIRMED,
    confirmedAt: now,
    confirmedBy,
    updatedAt: now,
    notes: notes ? `${existing.notes ? existing.notes + '\n' : ''}${notes}` : existing.notes,
    history: (existing.history || []).concat([auditEntry]),
    auditHistory: (existing.auditHistory || existing.history || []).concat([auditEntry]),
  };

  await store.set(`appointment:${id}`, updated);

  // Link to conversation
  if (updated.phone) {
    try {
      const conv = await store.get(`conv:${updated.phone}`);
      if (conv) {
        conv.appointmentId = id;
        conv.appointmentDate = `${updated.date} ${updated.time}`;
        conv.status = 'In Progress';
        await store.set(`conv:${updated.phone}`, conv);
      }
    } catch (e) {
      // ignore
    }

    // WhatsApp confirmation to customer
    const confirmMsg =
      `🎉 Great news! Your consultation appointment with Live It Up (LIU) is *CONFIRMED*.\n\n` +
      `📅 *Date:* ${updated.date}\n` +
      `⏰ *Time:* ${updated.time}\n` +
      `👤 *Consultant:* ${updated.consultantName || 'Mam'}\n` +
      `✨ *Service:* ${updated.service || 'Personal Consultation'}\n\n` +
      `We look forward to meeting you! If you have any questions, feel free to reply here.\n\nTeam Live It Up`;

    safeSendWhatsApp(updated.phone, confirmMsg).catch(() => {});
  }

  // Push to team
  safeSendPush({
    title: '✅ Appointment Confirmed',
    body: `Appointment confirmed for ${updated.customerName} with ${updated.consultantName} on ${updated.date} at ${updated.time}.`,
    data: { phone: updated.phone, appointmentId: id, url: '/dashboard/#calendar' },
  }).catch(() => {});

  logger.info({ id, confirmedBy }, 'Confirmed appointment');
  return updated;
}

/**
 * Reschedule an appointment.
 */
export async function rescheduleAppointment(id, updates = {}) {
  const store = await getStore();
  const existing = await store.get(`appointment:${id}`);
  if (!existing) {
    throw new Error(`Appointment ${id} not found`);
  }

  const now = new Date().toISOString();
  const newDate = updates.date || (updates.appointmentDateTime ? updates.appointmentDateTime.split('T')[0] : existing.date);
  const newTime = updates.time || (updates.appointmentDateTime && updates.appointmentDateTime.includes('T') ? updates.appointmentDateTime.split('T')[1].substring(0, 5) : existing.time);
  const newConsultantId = updates.consultantId || existing.consultantId;
  const newConsultantName = updates.consultantName || existing.consultantName;
  const newDateTime = updates.appointmentDateTime || `${newDate}T${newTime}:00`;

  // Conflict validation for new slot
  const conflict = await checkConsultantConflict({
    consultantId: newConsultantId,
    date: newDate,
    time: newTime,
    durationMinutes: updates.durationMinutes || existing.durationMinutes || 60,
    excludeId: id,
  });
  if (conflict) {
    throw new Error(`Cannot reschedule: ${newConsultantName || 'Consultant'} has an overlapping booking with ${conflict.customerName} on ${newDate} at ${newTime}.`);
  }

  const rescheduledFrom = {
    date: existing.date,
    time: existing.time,
    dateTime: existing.appointmentDateTime || `${existing.date}T${existing.time}:00`,
  };

  const auditEntry = {
    action: 'RESCHEDULED',
    status: updates.status || APPOINTMENT_STATUS.RESCHEDULED,
    timestamp: now,
    by: updates.rescheduledBy || 'LIU Team',
    from: `${existing.date} ${existing.time}`,
    to: newDateTime,
    notes: updates.notes || `Rescheduled to ${newDate} at ${newTime}`,
  };

  const updated = {
    ...existing,
    date: newDate,
    time: newTime,
    appointmentDateTime: newDateTime,
    consultantId: newConsultantId,
    consultantName: newConsultantName,
    status: updates.status || APPOINTMENT_STATUS.RESCHEDULED,
    rescheduledFrom,
    rescheduledAt: now,
    notes: updates.notes ? `${existing.notes ? existing.notes + '\n' : ''}${updates.notes}` : existing.notes,
    updatedAt: now,
    history: (existing.history || []).concat([auditEntry]),
    auditHistory: (existing.auditHistory || existing.history || []).concat([auditEntry]),
  };

  await store.set(`appointment:${id}`, updated);

  // Sync to conversation
  if (updated.phone) {
    try {
      const conv = await store.get(`conv:${updated.phone}`);
      if (conv) {
        conv.appointmentDate = `${newDate} ${newTime}`;
        await store.set(`conv:${updated.phone}`, conv);
      }
    } catch (e) {
      // ignore
    }

    // Customer notification via WhatsApp
    const reschedMsg =
      `ℹ️ Your LIU consultation appointment has been *RESCHEDULED*.\n\n` +
      `📅 *New Date:* ${newDate}\n` +
      `⏰ *New Time:* ${newTime}\n` +
      `👤 *Consultant:* ${newConsultantName}\n` +
      `✨ *Service:* ${updated.service}\n\n` +
      `If this new time works for you, please reply to confirm, or let us know your preferred alternative.\n\nTeam Live It Up`;

    safeSendWhatsApp(updated.phone, reschedMsg).catch(() => {});
  }

  logger.info({ id, from: rescheduledFrom, to: newDateTime }, 'Rescheduled appointment');
  return updated;
}

/**
 * Cancel an appointment.
 */
export async function cancelAppointment(id, { cancellationReason = 'Cancelled by customer/team', cancelledBy = 'LIU Team' } = {}) {
  const store = await getStore();
  const existing = await store.get(`appointment:${id}`);
  if (!existing) {
    throw new Error(`Appointment ${id} not found`);
  }

  const now = new Date().toISOString();
  const auditEntry = {
    action: 'CANCELLED',
    status: APPOINTMENT_STATUS.CANCELLED,
    timestamp: now,
    by: cancelledBy,
    reason: cancellationReason,
    notes: cancellationReason,
  };

  const updated = {
    ...existing,
    status: APPOINTMENT_STATUS.CANCELLED,
    cancelledAt: now,
    cancellationReason,
    updatedAt: now,
    history: (existing.history || []).concat([auditEntry]),
    auditHistory: (existing.auditHistory || existing.history || []).concat([auditEntry]),
  };

  await store.set(`appointment:${id}`, updated);

  // Notify customer
  if (updated.phone) {
    const cancelMsg =
      `Your consultation appointment for *${updated.service}* scheduled on *${updated.date}* at *${updated.time}* has been *CANCELLED*.\n\n` +
      `Reason: ${cancellationReason}\n\n` +
      `If you would like to book another time, please reply anytime. We're happy to assist!\n\nTeam Live It Up`;

    safeSendWhatsApp(updated.phone, cancelMsg).catch(() => {});
  }

  logger.info({ id, cancellationReason }, 'Cancelled appointment');
  return updated;
}

/**
 * General update for an existing appointment.
 */
export async function updateAppointment(id, updates) {
  if (updates.status === APPOINTMENT_STATUS.CONFIRMED) {
    return confirmAppointment(id, updates);
  }
  if (updates.status === APPOINTMENT_STATUS.CANCELLED) {
    return cancelAppointment(id, updates);
  }
  if (updates.status === APPOINTMENT_STATUS.RESCHEDULED || (updates.date && updates.time)) {
    return rescheduleAppointment(id, updates);
  }

  const store = await getStore();
  const existing = await store.get(`appointment:${id}`);
  if (!existing) {
    throw new Error(`Appointment ${id} not found`);
  }

  const now = new Date().toISOString();
  const updated = {
    ...existing,
    ...updates,
    updatedAt: now,
  };

  // Normalise phone & service
  updated.phone = updated.phone || updated.customerPhone || '';
  updated.customerPhone = updated.phone;
  updated.service = updated.service || updated.serviceName || 'Personal Consultation';
  updated.serviceName = updated.service;

  await store.set(`appointment:${id}`, updated);

  if (updates.status === APPOINTMENT_STATUS.COMPLETED && updated.phone) {
    try {
      const conv = await store.get(`conv:${updated.phone}`);
      if (conv) {
        conv.status = 'Closed';
        conv.isConverted = true;
        conv.convertedAt = now;
        await store.set(`conv:${updated.phone}`, conv);
      }
    } catch (e) {
      // ignore
    }
  }

  return updated;
}

/**
 * Delete / Archive an appointment.
 */
export async function deleteAppointment(id, { soft = true } = {}) {
  const store = await getStore();
  const existing = await store.get(`appointment:${id}`);
  if (!existing) {
    return { success: true };
  }

  if (soft) {
    existing.isArchived = true;
    existing.status = APPOINTMENT_STATUS.CANCELLED;
    existing.archivedAt = new Date().toISOString();
    await store.set(`appointment:${id}`, existing);
    logger.info({ id }, 'Soft-archived appointment');
    return { success: true, archived: true };
  }

  await store.delete(`appointment:${id}`);
  const index = (await store.get(INDEX_KEY)) || [];
  const filtered = index.filter((x) => x !== id);
  await store.set(INDEX_KEY, filtered);
  logger.info({ id }, 'Permanently deleted appointment');
  return { success: true, deleted: true };
}
