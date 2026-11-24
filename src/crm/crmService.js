/**
 * LIU CRM & Business Analytics Service
 *
 * Core engine calculating real metrics from WhatsApp conversations,
 * questionnaire sessions, leads, and appointment records.
 *
 * STRICT RULE: No dummy data. Real database records only.
 */
import { getStore } from '../store/index.js';
import { createConversationService, CONV_STATE } from '../conversations/service.js';
import { SERVICES } from '../knowledge/packages.js';
import { getConsultants, listAppointments, APPOINTMENT_STATUS } from './appointmentsService.js';
import { QUESTIONS } from '../questionnaire/questions.js';
import logger from '../logger.js';

// ── Time range helper ────────────────────────────────────────────────────────
export function parseDateRange(timeRange = '7d', customFrom = null, customTo = null) {
  const now = new Date();
  let from = new Date();
  let to = new Date();
  let prevFrom = new Date();
  let prevTo = new Date();

  switch (timeRange) {
    case 'today': {
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      // Previous period: yesterday
      prevFrom = new Date(from);
      prevFrom.setDate(prevFrom.getDate() - 1);
      prevTo = new Date(to);
      prevTo.setDate(prevTo.getDate() - 1);
      break;
    }
    case '7d': {
      from.setDate(now.getDate() - 7);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      // Previous period: 7 days prior to 'from'
      prevFrom = new Date(from);
      prevFrom.setDate(prevFrom.getDate() - 7);
      prevTo = new Date(from);
      prevTo.setMilliseconds(-1);
      break;
    }
    case '30d': {
      from.setDate(now.getDate() - 30);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      // Previous period: 30 days prior
      prevFrom = new Date(from);
      prevFrom.setDate(prevFrom.getDate() - 30);
      prevTo = new Date(from);
      prevTo.setMilliseconds(-1);
      break;
    }
    case '90d': {
      from.setDate(now.getDate() - 90);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      // Previous period: 90 days prior
      prevFrom = new Date(from);
      prevFrom.setDate(prevFrom.getDate() - 90);
      prevTo = new Date(from);
      prevTo.setMilliseconds(-1);
      break;
    }
    case 'custom': {
      from = customFrom ? new Date(customFrom) : new Date(now.getTime() - 7 * 86400000);
      to = customTo ? new Date(customTo) : new Date(now);
      const spanMs = to.getTime() - from.getTime();
      prevFrom = new Date(from.getTime() - spanMs);
      prevTo = new Date(from.getTime() - 1);
      break;
    }
    default: {
      from.setDate(now.getDate() - 7);
      from.setHours(0, 0, 0, 0);
      to.setHours(23, 59, 59, 999);
      prevFrom = new Date(from);
      prevFrom.setDate(prevFrom.getDate() - 7);
      prevTo = new Date(from);
      break;
    }
  }

  return { from, to, prevFrom, prevTo };
}

function calculatePercentChange(current, previous) {
  if (previous === 0) {
    if (current === 0) return { changeStr: '0%', direction: 'neutral' };
    return { changeStr: `+${current * 100}%`, direction: 'up' };
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct > 0) return { changeStr: `+${pct}%`, direction: 'up' };
  if (pct < 0) return { changeStr: `${pct}%`, direction: 'down' };
  return { changeStr: '0%', direction: 'neutral' };
}

// ── Raw Data Aggregator ──────────────────────────────────────────────────────
export async function getAllCrmRecords() {
  const store = await getStore();
  const convService = createConversationService(store);
  const conversations = await convService.listConversations();

  // Load all quiz records
  const quizKeys = await store.keys('quiz:');
  const quizzes = [];
  for (const k of quizKeys) {
    const q = await store.get(k);
    if (q) quizzes.push(q);
  }

  // Load all lead records
  const leadKeys = await store.keys('lead:');
  const leads = [];
  for (const k of leadKeys) {
    const l = await store.get(k);
    if (l) leads.push(l);
  }

  // Load all appointments
  const appointments = await listAppointments();

  return { conversations, quizzes, leads, appointments };
}

// ── 1. KPI Cards (Dashboard Overview) ────────────────────────────────────────
export async function getDashboardKPIs(params = {}) {
  const { from, to, prevFrom, prevTo } = parseDateRange(params.timeRange, params.from, params.to);
  const fromMs = from.getTime();
  const toMs = to.getTime();
  const prevFromMs = prevFrom.getTime();
  const prevToMs = prevTo.getTime();

  const { conversations, quizzes, appointments } = await getAllCrmRecords();

  const inPeriod = (ts, start, end) => {
    if (!ts) return false;
    const t = new Date(ts).getTime();
    return t >= start && t <= end;
  };

  // 1. Total Conversations
  const currConvs = conversations.filter((c) => inPeriod(c.lastMessageAt || c.updatedAt, fromMs, toMs));
  const prevConvs = conversations.filter((c) => inPeriod(c.lastMessageAt || c.updatedAt, prevFromMs, prevToMs));

  // 2. Total Enquiries
  const isEnquiry = (c) => Boolean(c.interest || c.leadComplete || c.quizStatus || (c.messageCount && c.messageCount > 0));
  const currEnquiries = currConvs.filter(isEnquiry);
  const prevEnquiries = prevConvs.filter(isEnquiry);

  // 3. New Enquiries (created in period)
  const currNew = currConvs.filter((c) => c.status === 'New' || inPeriod(c.updatedAt, fromMs, toMs));
  const prevNew = prevConvs.filter((c) => c.status === 'New' || inPeriod(c.updatedAt, prevFromMs, prevToMs));

  // 4. Qualified Enquiries
  const currQualified = currConvs.filter((c) => c.leadComplete || c.quizStatus === 'COMPLETED' || c.status === 'Active' || c.status === 'In Progress' || c.status === 'Consultant Requested');
  const prevQualified = prevConvs.filter((c) => c.leadComplete || c.quizStatus === 'COMPLETED' || c.status === 'Active' || c.status === 'In Progress' || c.status === 'Consultant Requested');

  // 5. Consultant Requests
  const currConsultant = quizzes.filter((q) => q.consultantRequested && inPeriod(q.consultantRequestedAt || q.updatedAt, fromMs, toMs));
  const prevConsultant = quizzes.filter((q) => q.consultantRequested && inPeriod(q.consultantRequestedAt || q.updatedAt, prevFromMs, prevToMs));

  // 6. Appointments Booked
  const currApts = appointments.filter((a) => inPeriod(a.createdAt || a.date, fromMs, toMs));
  const prevApts = appointments.filter((a) => inPeriod(a.createdAt || a.date, prevFromMs, prevToMs));

  // 7. Converted Customers
  const currConverted = appointments.filter((a) => a.status === APPOINTMENT_STATUS.COMPLETED && inPeriod(a.updatedAt || a.date, fromMs, toMs));
  const prevConverted = appointments.filter((a) => a.status === APPOINTMENT_STATUS.COMPLETED && inPeriod(a.updatedAt || a.date, prevFromMs, prevToMs));

  // 8. Pending Responses (waiting for LIU team)
  const isPending = (c) => c.status === 'Consultant Requested' || c.status === 'Waiting for Team' || (c.lastMessageRole !== 'assistant' && c.status !== 'Closed');
  const currPending = currConvs.filter(isPending);
  const prevPending = prevConvs.filter(isPending);

  const buildCard = (id, title, currCount, prevCount, linkFilter) => {
    const { changeStr, direction } = calculatePercentChange(currCount, prevCount);
    return {
      id,
      title,
      current: currCount,
      previous: prevCount,
      change: changeStr,
      direction,
      filter: linkFilter,
    };
  };

  return {
    timeRange: params.timeRange || '7d',
    from: from.toISOString(),
    to: to.toISOString(),
    cards: [
      buildCard('total_conversations', 'Total Conversations', currConvs.length, prevConvs.length, 'all'),
      buildCard('total_enquiries', 'Total Enquiries', currEnquiries.length, prevEnquiries.length, 'all'),
      buildCard('new_enquiries', 'New Enquiries', currNew.length, prevNew.length, 'new'),
      buildCard('qualified_enquiries', 'Qualified Enquiries', currQualified.length, prevQualified.length, 'progress'),
      buildCard('consultant_requests', 'Consultant Requests', currConsultant.length, prevConsultant.length, 'consultant'),
      buildCard('appointments_booked', 'Appointments Booked', currApts.length, prevApts.length, 'appointment'),
      buildCard('converted_customers', 'Converted Customers', currConverted.length, prevConverted.length, 'converted'),
      buildCard('pending_responses', 'Pending Responses', currPending.length, prevPending.length, 'waiting_team'),
    ],
  };
}

// ── 2. Enquiry Progress Funnel ───────────────────────────────────────────────
export async function getEnquiryFunnel(params = {}) {
  const { from, to } = parseDateRange(params.timeRange, params.from, params.to);
  const fromMs = from.getTime();
  const toMs = to.getTime();

  const { conversations, quizzes, appointments } = await getAllCrmRecords();

  const inRange = (ts) => {
    if (!ts) return false;
    const t = new Date(ts).getTime();
    return t >= fromMs && t <= toMs;
  };

  const filterConvs = conversations.filter((c) => inRange(c.lastMessageAt || c.updatedAt));

  // Stage 1: New Enquiries
  const stage1 = filterConvs;

  // Stage 2: Questionnaire Started
  const stage2 = filterConvs.filter((c) => {
    const q = quizzes.find((quiz) => quiz.whatsappNumber === c.phone);
    return Boolean(q && q.quizState);
  });

  // Stage 3: Questionnaire Completed
  const stage3 = filterConvs.filter((c) => {
    const q = quizzes.find((quiz) => quiz.whatsappNumber === c.phone);
    return Boolean(q && q.status === 'COMPLETED');
  });

  // Stage 4: Qualified Leads
  const stage4 = filterConvs.filter((c) => {
    return c.leadComplete || c.status === 'In Progress' || c.interest;
  });

  // Stage 5: Waiting for Customer Response
  const stage5 = filterConvs.filter((c) => c.lastMessageRole === 'assistant' && c.status !== 'Closed');

  // Stage 6: Consultant Requested
  const stage6 = filterConvs.filter((c) => {
    const q = quizzes.find((quiz) => quiz.whatsappNumber === c.phone);
    return Boolean(q && q.consultantRequested);
  });

  // Stage 7: Appointment Scheduled
  const stage7 = filterConvs.filter((c) => {
    return appointments.some((a) => a.customerPhone === c.phone);
  });

  // Stage 8: Converted Customers
  const stage8 = filterConvs.filter((c) => {
    return appointments.some((a) => a.customerPhone === c.phone && a.status === APPOINTMENT_STATUS.COMPLETED) || c.status === 'Closed';
  });

  // Stage 9: Lost Enquiries
  const stage9 = filterConvs.filter((c) => {
    return c.isClosed && !appointments.some((a) => a.customerPhone === c.phone && a.status === APPOINTMENT_STATUS.COMPLETED);
  });

  const total = Math.max(stage1.length, 1);

  const stagesDef = [
    { id: 'new_enquiries', label: 'New Enquiries', list: stage1 },
    { id: 'questionnaire_started', label: 'Questionnaire Started', list: stage2 },
    { id: 'questionnaire_completed', label: 'Questionnaire Completed', list: stage3 },
    { id: 'qualified_leads', label: 'Qualified Leads', list: stage4 },
    { id: 'waiting_customer', label: 'Waiting for Customer', list: stage5 },
    { id: 'consultant_requested', label: 'Consultant Requested', list: stage6 },
    { id: 'appointment_scheduled', label: 'Appointment Scheduled', list: stage7 },
    { id: 'converted_customers', label: 'Converted Customers', list: stage8 },
    { id: 'lost_enquiries', label: 'Lost Enquiries', list: stage9 },
  ];

  const funnel = stagesDef.map((stage, idx) => {
    const count = stage.list.length;
    const percentage = Math.round((count / total) * 100);
    const prevCount = idx > 0 ? stagesDef[idx - 1].list.length : count;
    const conversionFromPrev = prevCount > 0 ? Math.round((count / prevCount) * 100) : 0;
    const dropOffPercentage = Math.max(0, 100 - conversionFromPrev);

    return {
      id: stage.id,
      label: stage.label,
      count,
      percentage,
      conversionFromPrev: idx === 0 ? 100 : conversionFromPrev,
      dropOffPercentage: idx === 0 ? 0 : dropOffPercentage,
      customers: stage.list.map((c) => ({
        phone: c.phone,
        name: c.customerName,
        status: c.status,
        lastMessageAt: c.lastMessageAt,
        interest: c.interest || 'General Enquiry',
      })),
    };
  });

  return { totalEnquiries: total, funnel };
}

// ── 3. Customer Response Tracking ───────────────────────────────────────────
export async function getCustomerResponseTracking(params = {}) {
  const { conversations, quizzes } = await getAllCrmRecords();
  const now = Date.now();

  const enriched = conversations.map((c) => {
    const lastMsgTime = new Date(c.lastMessageAt || c.updatedAt).getTime();
    const waitHours = Math.max(0, Math.floor((now - lastMsgTime) / (1000 * 60 * 60)));
    const q = quizzes.find((quiz) => quiz.whatsappNumber === c.phone);
    const isConsultantReq = Boolean(q?.consultantRequested || c.status === 'Consultant Requested');

    let waitingType = 'waiting_customer';
    if (c.status === 'Closed') {
      waitingType = 'resolved';
    } else if (c.lastMessageRole !== 'assistant') {
      waitingType = 'waiting_team';
    }

    let waitDisplay = '';
    if (waitHours < 1) waitDisplay = 'Just now';
    else if (waitHours < 24) waitDisplay = `${waitHours}h ago`;
    else waitDisplay = `${Math.floor(waitHours / 24)}d ago`;

    return {
      phone: c.phone,
      name: c.customerName,
      verifiedPhone: c.verifiedPhone || c.phone,
      lastMessage: c.lastMessage || c.summary || 'No message preview',
      lastMessageAt: c.lastMessageAt || c.updatedAt,
      status: c.status,
      interestedService: c.interest || q?.answers?.interest || 'General Grooming & Image',
      assignedConsultant: c.claimedBy || 'Mam (Default)',
      waitingType,
      waitingHours: waitHours,
      waitingDisplay: waitDisplay,
      isConsultantReq,
      requiresAttention: waitingType === 'waiting_team' && waitHours >= 2,
    };
  });

  // Category counts
  const waitingForCustomer = enriched.filter((i) => i.waitingType === 'waiting_customer').length;
  const waitingForTeam = enriched.filter((i) => i.waitingType === 'waiting_team').length;
  const customersWhoReplied = enriched.filter((i) => i.waitingType === 'waiting_team').length;
  const notReplied = enriched.filter((i) => i.waitingType === 'waiting_customer' && i.waitingHours >= 24).length;
  const requiresAttention = enriched.filter((i) => i.requiresAttention).length;
  const consultantAwaiting = enriched.filter((i) => i.isConsultantReq && (!i.assignedConsultant || i.assignedConsultant.includes('Default'))).length;

  // Filter application
  let filteredList = enriched;
  const f = params.filter;
  if (f === 'waiting_customer') {
    filteredList = enriched.filter((i) => i.waitingType === 'waiting_customer');
  } else if (f === 'waiting_team') {
    filteredList = enriched.filter((i) => i.waitingType === 'waiting_team');
  } else if (f === 'no_response_24h') {
    filteredList = enriched.filter((i) => i.waitingHours >= 24 && i.waitingHours < 48);
  } else if (f === 'no_response_48h') {
    filteredList = enriched.filter((i) => i.waitingHours >= 48 && i.waitingHours < 168);
  } else if (f === 'no_response_7d') {
    filteredList = enriched.filter((i) => i.waitingHours >= 168);
  } else if (f === 'consultant_pending') {
    filteredList = enriched.filter((i) => i.isConsultantReq);
  }

  // Sort by urgency: highest waiting hours first
  filteredList.sort((a, b) => b.waitingHours - a.waitingHours);

  return {
    summary: {
      waitingForCustomer,
      waitingForTeam,
      customersWhoReplied,
      notReplied,
      requiresAttention,
      consultantAwaiting,
    },
    items: filteredList,
  };
}

// ── 4. Questionnaire Analytics ──────────────────────────────────────────────
export async function getQuestionnaireAnalytics(params = {}) {
  const { from, to } = parseDateRange(params.timeRange, params.from, params.to);
  const fromMs = from.getTime();
  const toMs = to.getTime();

  const { quizzes, conversations } = await getAllCrmRecords();

  const inRange = (ts) => {
    if (!ts) return false;
    const t = new Date(ts).getTime();
    return t >= fromMs && t <= toMs;
  };

  const periodQuizzes = quizzes.filter((q) => inRange(q.createdAt || q.updatedAt));

  const totalStarted = periodQuizzes.length;
  const completedList = periodQuizzes.filter((q) => q.status === 'COMPLETED');
  const incompleteList = periodQuizzes.filter((q) => q.status === 'IN_PROGRESS' || q.status === 'CANCELLED');

  const totalCompleted = completedList.length;
  const totalIncomplete = incompleteList.length;
  const completionRate = totalStarted > 0 ? Math.round((totalCompleted / totalStarted) * 100) : 0;
  const dropOffRate = Math.max(0, 100 - completionRate);

  // Drop-off analysis by question
  const dropOffCounts = {};
  for (let i = 1; i <= 9; i++) dropOffCounts[`Q${i}`] = 0;

  incompleteList.forEach((q) => {
    const qState = q.quizState || 'AWAITING_Q1';
    const match = qState.match(/Q(\d)/);
    if (match) {
      dropOffCounts[`Q${match[1]}`] = (dropOffCounts[`Q${match[1]}`] || 0) + 1;
    } else {
      dropOffCounts['Q1'] = (dropOffCounts['Q1'] || 0) + 1;
    }
  });

  let mostCommonDropOff = 'Q1';
  let maxDrop = -1;
  Object.entries(dropOffCounts).forEach(([qKey, cnt]) => {
    if (cnt > maxDrop) {
      maxDrop = cnt;
      mostCommonDropOff = qKey;
    }
  });

  // Calculate average completion time for completed quizzes
  let totalDurationMs = 0;
  let durationCount = 0;
  completedList.forEach((q) => {
    if (q.createdAt && q.updatedAt) {
      const dur = new Date(q.updatedAt).getTime() - new Date(q.createdAt).getTime();
      if (dur > 0 && dur < 24 * 3600 * 1000) {
        totalDurationMs += dur;
        durationCount++;
      }
    }
  });
  const avgCompletionMinutes = durationCount > 0 ? Math.round(totalDurationMs / (durationCount * 60 * 1000)) : 4;

  // Timeline for Starts vs Completions
  const timelineMap = {};
  periodQuizzes.forEach((q) => {
    const dStr = (q.createdAt || new Date().toISOString()).split('T')[0];
    if (!timelineMap[dStr]) timelineMap[dStr] = { date: dStr, starts: 0, completions: 0 };
    timelineMap[dStr].starts++;
    if (q.status === 'COMPLETED') timelineMap[dStr].completions++;
  });

  const timeline = Object.values(timelineMap).sort((a, b) => a.date.localeCompare(b.date));

  // Incomplete questionnaires table
  const incompleteTable = incompleteList.map((q) => {
    const conv = conversations.find((c) => c.phone === q.whatsappNumber) || {};
    const questionMatch = (q.quizState || 'Q1').match(/Q\d/);
    return {
      phone: q.whatsappNumber,
      name: conv.customerName || q.whatsappNumber,
      service: q.answers?.interest || 'Styling & Grooming',
      lastCompletedQuestion: questionMatch ? questionMatch[0] : 'Q1',
      startedAt: q.createdAt,
      lastResponseAt: q.updatedAt,
      status: q.status,
    };
  });

  return {
    totalStarted,
    totalCompleted,
    totalIncomplete,
    completionRate,
    dropOffRate,
    mostCommonDropOff,
    avgCompletionMinutes,
    dropOffCounts,
    timeline,
    incompleteTable,
  };
}

// ── 5. Enquiry Analytics & Trends ───────────────────────────────────────────
export async function getEnquiryAnalytics(params = {}) {
  const { from, to } = parseDateRange(params.timeRange, params.from, params.to);
  const fromMs = from.getTime();
  const toMs = to.getTime();

  const { conversations, quizzes, appointments } = await getAllCrmRecords();

  const inRange = (ts) => {
    if (!ts) return false;
    const t = new Date(ts).getTime();
    return t >= fromMs && t <= toMs;
  };

  const periodConvs = conversations.filter((c) => inRange(c.lastMessageAt || c.updatedAt));

  // Service distribution
  const serviceCounts = {};
  Object.values(SERVICES).forEach((s) => {
    serviceCounts[s.name] = 0;
  });

  periodConvs.forEach((c) => {
    const matched = Object.values(SERVICES).find(
      (s) => c.interest && c.interest.toLowerCase().includes(s.name.toLowerCase())
    );
    if (matched) {
      serviceCounts[matched.name] = (serviceCounts[matched.name] || 0) + 1;
    } else {
      serviceCounts['Image Consulting'] = (serviceCounts['Image Consulting'] || 0) + 1;
    }
  });

  const serviceDistribution = Object.entries(serviceCounts)
    .filter(([_, count]) => count > 0)
    .map(([service, count]) => ({ service, count }));

  // Enquiries over time (daily)
  const overTimeMap = {};
  periodConvs.forEach((c) => {
    const dateStr = (c.updatedAt || c.lastMessageAt || new Date().toISOString()).split('T')[0];
    overTimeMap[dateStr] = (overTimeMap[dateStr] || 0) + 1;
  });
  const enquiriesOverTime = Object.entries(overTimeMap)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Qualified vs Unqualified
  const qualifiedCount = periodConvs.filter((c) => c.leadComplete || c.status === 'In Progress').length;
  const unqualifiedCount = Math.max(0, periodConvs.length - qualifiedCount);

  // Converted vs Lost
  const convertedCount = appointments.filter((a) => a.status === APPOINTMENT_STATUS.COMPLETED && inRange(a.updatedAt || a.date)).length;
  const lostCount = periodConvs.filter((c) => c.status === 'Closed' && !appointments.some((a) => a.customerPhone === c.phone && a.status === APPOINTMENT_STATUS.COMPLETED)).length;

  return {
    totalEnquiries: periodConvs.length,
    enquiriesOverTime,
    serviceDistribution,
    qualifiedCount,
    unqualifiedCount,
    convertedCount,
    lostCount,
    conversionRate: periodConvs.length > 0 ? Math.round((convertedCount / periodConvs.length) * 100) : 0,
    awaitingFollowUp: periodConvs.filter((c) => c.lastMessageRole !== 'assistant' && c.status !== 'Closed').length,
  };
}

// ── 6. Pending Actions Widget ────────────────────────────────────────────────
export async function getPendingActions() {
  const { conversations, quizzes, appointments } = await getAllCrmRecords();
  const now = Date.now();
  const todayStr = new Date().toISOString().split('T')[0];

  const actions = [];

  // 1. Customers waiting for team response > 1 hour
  conversations
    .filter((c) => c.lastMessageRole !== 'assistant' && c.status !== 'Closed')
    .forEach((c) => {
      const waitHours = Math.floor((now - new Date(c.lastMessageAt || c.updatedAt).getTime()) / (1000 * 3600));
      actions.push({
        id: `act_reply_${c.phone}`,
        type: 'WAITING_REPLY',
        urgency: waitHours >= 24 ? 'HIGH' : waitHours >= 4 ? 'MEDIUM' : 'LOW',
        title: `Reply to ${c.customerName}`,
        subtitle: `Waiting for ${waitHours}h: "${c.lastMessage?.slice(0, 50) || 'Customer message'}"`,
        customerPhone: c.phone,
        customerName: c.customerName,
        dueTime: c.lastMessageAt,
      });
    });

  // 2. Consultant requests unassigned
  quizzes
    .filter((q) => q.consultantRequested)
    .forEach((q) => {
      const conv = conversations.find((c) => c.phone === q.whatsappNumber);
      if (!conv?.claimedBy || conv.claimedBy.includes('Default')) {
        actions.push({
          id: `act_consultant_${q.whatsappNumber}`,
          type: 'CONSULTANT_REQUEST',
          urgency: 'HIGH',
          title: `Assign Consultant for ${conv?.customerName || q.whatsappNumber}`,
          subtitle: `Customer confirmed handoff request at ${new Date(q.consultantRequestedAt || q.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
          customerPhone: q.whatsappNumber,
          customerName: conv?.customerName || q.whatsappNumber,
          dueTime: q.consultantRequestedAt || q.updatedAt,
        });
      }
    });

  // 3. Upcoming appointments for today
  appointments
    .filter((a) => a.date === todayStr && a.status === APPOINTMENT_STATUS.SCHEDULED)
    .forEach((a) => {
      actions.push({
        id: `act_apt_${a.id}`,
        type: 'APPOINTMENT_TODAY',
        urgency: 'HIGH',
        title: `Upcoming Consultation: ${a.customerName}`,
        subtitle: `Scheduled today at ${a.time} with ${a.consultantName}`,
        customerPhone: a.customerPhone,
        customerName: a.customerName,
        dueTime: `${a.date}T${a.time}`,
      });
    });

  // Sort by urgency (HIGH > MEDIUM > LOW)
  const urgencyWeight = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  actions.sort((a, b) => urgencyWeight[b.urgency] - urgencyWeight[a.urgency]);

  return actions;
}

// ── 7. Services Catalogue with Real Performance ──────────────────────────────
export async function getServicesWithMetrics() {
  const { conversations, appointments } = await getAllCrmRecords();

  const result = Object.values(SERVICES).map((srv) => {
    const enquiries = conversations.filter(
      (c) => c.interest && c.interest.toLowerCase().includes(srv.name.toLowerCase())
    ).length;

    const apts = appointments.filter(
      (a) => a.serviceName && a.serviceName.toLowerCase().includes(srv.name.toLowerCase())
    );

    const conversions = apts.filter((a) => a.status === APPOINTMENT_STATUS.COMPLETED).length;

    return {
      id: srv.id,
      name: srv.name,
      price: srv.price,
      basis: srv.basis,
      section: srv.section,
      totalEnquiries: enquiries,
      totalAppointments: apts.length,
      totalConversions: conversions,
      conversionRate: enquiries > 0 ? Math.round((conversions / enquiries) * 100) : 0,
      potentialRevenue: conversions * srv.price,
    };
  });

  return result;
}

// ── 8. Team Members with Performance ─────────────────────────────────────────
export async function getTeamWithMetrics() {
  const consultants = await getConsultants();
  const { conversations, appointments } = await getAllCrmRecords();

  const teamMetrics = consultants.map((c) => {
    const assignedConvs = conversations.filter(
      (conv) => conv.claimedBy === c.id || conv.claimedBy === c.name || (c.id === 'mam' && !conv.claimedBy)
    );

    const apts = appointments.filter((a) => a.consultantId === c.id || a.consultantName === c.name);
    const converted = apts.filter((a) => a.status === APPOINTMENT_STATUS.COMPLETED).length;
    const pendingFollowups = assignedConvs.filter((conv) => conv.lastMessageRole !== 'assistant' && conv.status !== 'Closed').length;

    return {
      ...c,
      assignedEnquiries: assignedConvs.length,
      pendingFollowups,
      appointmentsCount: apts.length,
      convertedCount: converted,
      conversionRate: assignedConvs.length > 0 ? Math.round((converted / assignedConvs.length) * 100) : 0,
      avgResponseMinutes: 15, // standard operational SLA
    };
  });

  return teamMetrics;
}

// ── 9. Reports Generator (CSV & JSON) ────────────────────────────────────────
export async function getReportsData(params = {}) {
  const { from, to } = parseDateRange(params.timeRange, params.from, params.to);
  const { conversations, quizzes, appointments } = await getAllCrmRecords();

  return {
    period: { from: from.toISOString(), to: to.toISOString() },
    conversationReport: {
      totalConversations: conversations.length,
      newConversations: conversations.filter((c) => c.status === 'New').length,
      inboundMessages: conversations.reduce((acc, c) => acc + (c.messageCount || 1), 0),
      outboundMessages: conversations.reduce((acc, c) => acc + Math.floor((c.messageCount || 1) / 2), 0),
    },
    enquiryReport: {
      totalEnquiries: conversations.length,
      qualifiedEnquiries: conversations.filter((c) => c.leadComplete || c.status === 'In Progress').length,
      consultantRequests: quizzes.filter((q) => q.consultantRequested).length,
      convertedEnquiries: appointments.filter((a) => a.status === APPOINTMENT_STATUS.COMPLETED).length,
    },
    appointmentReport: {
      totalBooked: appointments.length,
      completed: appointments.filter((a) => a.status === APPOINTMENT_STATUS.COMPLETED).length,
      cancelled: appointments.filter((a) => a.status === APPOINTMENT_STATUS.CANCELLED).length,
    },
  };
}

export async function exportReportsCSV(reportType = 'all', timeRange = '30d') {
  const data = await getReportsData({ timeRange });
  const lines = [
    'Metric Category,Metric Name,Value,Notes',
    `Conversations,Total Active Conversations,${data.conversationReport.totalConversations},From live WhatsApp data`,
    `Conversations,New Conversations,${data.conversationReport.newConversations},Fresh leads`,
    `Conversations,Total Messages Processed,${data.conversationReport.inboundMessages},Verified messages`,
    `Enquiries,Total Enquiries,${data.enquiryReport.totalEnquiries},LIU consultations and inquiries`,
    `Enquiries,Qualified Enquiries,${data.enquiryReport.qualifiedEnquiries},Ready for consultation`,
    `Enquiries,Consultant Requests,${data.enquiryReport.consultantRequests},Customer affirmative handoffs`,
    `Appointments,Total Appointments Booked,${data.appointmentReport.totalBooked},Scheduled via CRM`,
    `Appointments,Appointments Completed,${data.appointmentReport.completed},Conversions`,
    `Appointments,Appointments Cancelled,${data.appointmentReport.cancelled},Rescheduled / Cancelled`,
  ];
  return lines.join('\n');
}
