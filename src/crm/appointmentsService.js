/**
 * Appointments Service for LIU CRM
 * Manages consultation bookings, schedules, and status tracking.
 */
import { getStore } from '../store/index.js';
import logger from '../logger.js';
import crypto from 'crypto';

const INDEX_KEY = 'appointments:index';

export const APPOINTMENT_STATUS = {
  SCHEDULED: 'SCHEDULED',
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
 * List all appointments with optional filters.
 * @param {Object} [filters]
 * @param {string} [filters.date] - YYYY-MM-DD
 * @param {string} [filters.from] - ISO string or YYYY-MM-DD
 * @param {string} [filters.to]   - ISO string or YYYY-MM-DD
 * @param {string} [filters.consultantId]
 * @param {string} [filters.status]
 * @param {string} [filters.customerPhone]
 * @returns {Promise<Array<Object>>}
 */
export async function listAppointments(filters = {}) {
  const store = await getStore();
  const index = (await store.get(INDEX_KEY)) || [];
  if (!Array.isArray(index) || index.length === 0) {
    return [];
  }

  const appointments = [];
  for (const id of index) {
    const item = await store.get(`appointment:${id}`);
    if (item && item.id) {
      appointments.push(item);
    }
  }

  return appointments.filter((apt) => {
    if (filters.date && apt.date !== filters.date) return false;
    if (filters.consultantId && apt.consultantId !== filters.consultantId) return false;
    if (filters.status && apt.status !== filters.status) return false;
    if (filters.customerPhone && apt.customerPhone !== filters.customerPhone) return false;

    if (filters.from) {
      const fromTime = new Date(filters.from).getTime();
      const aptTime = new Date(`${apt.date}T${apt.time || '00:00'}`).getTime();
      if (aptTime < fromTime) return false;
    }
    if (filters.to) {
      const toTime = new Date(filters.to).getTime();
      const aptTime = new Date(`${apt.date}T${apt.time || '23:59'}`).getTime();
      if (aptTime > toTime) return false;
    }

    return true;
  }).sort((a, b) => {
    const tA = new Date(`${a.date}T${a.time || '00:00'}`).getTime();
    const tB = new Date(`${b.date}T${b.time || '00:00'}`).getTime();
    return tA - tB;
  });
}

/**
 * Get an appointment by ID.
 * @param {string} id
 */
export async function getAppointment(id) {
  const store = await getStore();
  return store.get(`appointment:${id}`);
}

/**
 * Create a new appointment.
 * @param {Object} data
 */
export async function createAppointment(data) {
  const store = await getStore();
  const id = data.id || `apt_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString();

  const appointment = {
    id,
    customerPhone: data.customerPhone || '',
    customerName: data.customerName || data.customerPhone || 'Valued Customer',
    serviceId: data.serviceId || 'consultation',
    serviceName: data.serviceName || 'LIU Personal Consultation',
    consultantId: data.consultantId || 'mam',
    consultantName: data.consultantName || 'Mam',
    date: data.date, // Format: YYYY-MM-DD
    time: data.time || '10:00', // Format: HH:mm
    durationMinutes: data.durationMinutes || 60,
    status: data.status || APPOINTMENT_STATUS.SCHEDULED,
    notes: data.notes || '',
    meetingLink: data.meetingLink || '',
    location: data.location || 'LIU Studio & WhatsApp Video',
    createdAt: now,
    updatedAt: now,
  };

  await store.set(`appointment:${id}`, appointment);

  const index = (await store.get(INDEX_KEY)) || [];
  if (!index.includes(id)) {
    index.push(id);
    await store.set(INDEX_KEY, index);
  }

  // Also sync status to customer conversation if phone is provided
  if (appointment.customerPhone) {
    try {
      const conv = await store.get(`conv:${appointment.customerPhone}`);
      if (conv) {
        conv.appointmentId = id;
        conv.appointmentDate = `${appointment.date} ${appointment.time}`;
        conv.status = 'In Progress';
        await store.set(`conv:${appointment.customerPhone}`, conv);
      }
    } catch (e) {
      logger.warn({ err: e }, 'Could not link appointment to conversation');
    }
  }

  logger.info({ id, customer: appointment.customerName, date: appointment.date }, 'Created new appointment');
  return appointment;
}

/**
 * Update an existing appointment.
 * @param {string} id
 * @param {Object} updates
 */
export async function updateAppointment(id, updates) {
  const store = await getStore();
  const existing = await store.get(`appointment:${id}`);
  if (!existing) {
    throw new Error(`Appointment ${id} not found`);
  }

  const updated = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await store.set(`appointment:${id}`, updated);

  // If marked converted/completed, update conversation status
  if (updates.status === APPOINTMENT_STATUS.COMPLETED && updated.customerPhone) {
    try {
      const conv = await store.get(`conv:${updated.customerPhone}`);
      if (conv) {
        conv.status = 'Closed';
        conv.isConverted = true;
        conv.convertedAt = new Date().toISOString();
        await store.set(`conv:${updated.customerPhone}`, conv);
      }
    } catch (e) {
      // ignore
    }
  }

  return updated;
}

/**
 * Delete an appointment.
 * @param {string} id
 */
export async function deleteAppointment(id) {
  const store = await getStore();
  await store.delete(`appointment:${id}`);
  const index = (await store.get(INDEX_KEY)) || [];
  const filtered = index.filter((x) => x !== id);
  await store.set(INDEX_KEY, filtered);
  return { success: true };
}
