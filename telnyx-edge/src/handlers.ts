// REST handler implementations ported from mcp-server/src/index.ts.
// Behavior is identical; the only differences are:
//   - services/therapists come from bundled static data (not filesystem)
//   - customers/appointments are read from / written to Telnyx KV
//   - handlers are async (KV is async)
//
// All request/response contracts (JSON shapes, status codes, error
// messages) match the existing mcp-server REST adapter.

import { randomUUID } from 'node:crypto';
import {
  type Service, type Therapist, type Customer, type Appointment,
  parseSpaInput, spaFormatISO, nextAppointmentId,
} from './types.js';
import { computeAvailability, isSlotFree } from './availability.js';
import { SERVICES, THERAPISTS } from './static-data.js';
import { readCustomers, readAppointments, writeCustomers, writeAppointments, readAfterCallSurveyEnabled } from './kv.js';
import { normalizePhoneForKey } from './actor-access.js';

// ---------- Shared result helpers ----------

export type ToolEnvelope = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  // Optional discriminator for structured logging. Only set by handlers
  // that the server treats specially (currently create-booking).
  bookingOutcome?: 'booking_created' | 'booking_idempotent_replay' | 'booking_rejected';
  featureFlagValue?: boolean;
};

function result(data: unknown): ToolEnvelope {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolEnvelope {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

function unwrap(env: ToolEnvelope): { status: number; body: unknown } {
  const body = JSON.parse(env.content[0].text);
  return { status: env.isError ? 400 : 200, body };
}

export function envelopeToResponse(env: ToolEnvelope) {
  return unwrap(env);
}

// ---------- Shared helpers ----------

function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === 'string' ? v.trim() : '';
}

function fieldStr(obj: Record<string, unknown> | undefined, key: string): string {
  if (!obj) return '';
  const v = obj[key];
  return typeof v === 'string' ? v.trim() : '';
}

function isPopulatedCustomerObj(obj: unknown): obj is Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return false;
  return Object.keys(obj as Record<string, unknown>).length > 0;
}

function findService(services: Service[], query: string): Service | undefined {
  const q = query.trim().toLowerCase();
  return services.find((s) => s.id.toLowerCase() === q || s.name.toLowerCase() === q);
}

function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  return digits;
}

function buildNewCustomer(obj: Record<string, unknown>, existing: Customer[]): Customer {
  const firstName = fieldStr(obj, 'first_name');
  const lastName = fieldStr(obj, 'last_name');
  const phone = fieldStr(obj, 'phone');
  if (!firstName) throw new Error('New customer requires `first_name`.');
  if (!lastName) throw new Error('New customer requires `last_name`.');
  if (!phone) throw new Error('New customer requires `phone`.');
  return {
    id: generateUniqueCustomerId(existing),
    name: `${firstName} ${lastName}`.trim(),
    phone,
    email: fieldStr(obj, 'email'),
    postcode: fieldStr(obj, 'postcode'),
    date_of_birth: fieldStr(obj, 'date_of_birth'),
    notes: fieldStr(obj, 'notes'),
  };
}

function generateUniqueCustomerId(existing: Customer[]): string {
  const taken = new Set(existing.map((c) => c.id));
  for (let i = 0; i < 16; i++) {
    const id = randomUUID();
    if (!taken.has(id)) return id;
  }
  return randomUUID();
}

function projectAppointment(
  a: Appointment,
  serviceById: Map<string, Service>,
  therapistById: Map<string, Therapist>,
) {
  const service = serviceById.get(a.service_id);
  const therapist = therapistById.get(a.therapist_id);
  return {
    id: a.id,
    customer_id: a.customer_id,
    customer_name: a.customer_name,
    service_id: a.service_id,
    service_name: service?.name ?? a.service_id,
    therapist_id: a.therapist_id,
    therapist_name: therapist?.name ?? a.therapist_id,
    start_time: a.start_time,
    end_time: a.end_time,
    status: a.status,
  };
}

// ---------- Handlers ----------

export async function handleGetFeatureFlags(
  _args: Record<string, unknown>,
): Promise<ToolEnvelope> {
  const afterCallSurveyEnabled = await readAfterCallSurveyEnabled();

  const env = result({
    success: true,
    after_call_survey_enabled: afterCallSurveyEnabled,
  });

  env.featureFlagValue = afterCallSurveyEnabled;
  return env;
}

export async function handleCaptureSurveyRating(
  args: Record<string, unknown>
): Promise<ToolEnvelope> {
  const raw = args.rating;

  const rating =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number(raw.trim())
        : NaN;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return err('`rating` must be an integer from 1 through 5.');
  }

  return result({
    success: true,
    survey_rating: rating,
  });
}

export async function handleGetServiceInfo(args: Record<string, unknown>): Promise<ToolEnvelope> {
  const query = str(args, 'service');
  if (!query) return err('`service` is required.');

  const match = findService(SERVICES, query);
  if (!match) {
    return result({ found: false, message: `No service matched "${query}".` });
  }
  return result({
    found: true,
    id: match.id,
    name: match.name,
    description: match.description,
    duration_minutes: match.duration_minutes,
    price_usd: match.price_usd,
  });
}

export async function handleCheckAvailability(args: Record<string, unknown>): Promise<ToolEnvelope> {
  const serviceQuery = str(args, 'service');
  const dateStr = str(args, 'date');
  const therapistId = str(args, 'therapist_id');

  if (!serviceQuery || !dateStr) return err('`service` and `date` are required.');

  const service = findService(SERVICES, serviceQuery);
  if (!service) return err(`No service matched "${serviceQuery}".`);

  let date: Date;
  try {
    date = parseSpaInput(dateStr, 'date');
  } catch (e) {
    return err(e instanceof Error ? e.message : `Invalid date: "${dateStr}".`);
  }

  const appointments = await readAppointments();
  const slots = computeAvailability(service, date, THERAPISTS, appointments, therapistId || undefined);

  if (therapistId) {
    const t = THERAPISTS.find((x) => x.id === therapistId);
    if (!t) return err(`No therapist with id "${therapistId}".`);
    if (!t.service_ids.includes(service.id)) {
      return result({
        service: { id: service.id, name: service.name },
        therapist: { id: t.id, name: t.name },
        available: false,
        message: `${t.name} does not offer ${service.name}.`,
        slots: [],
      });
    }
  }

  return result({
    service: { id: service.id, name: service.name, duration_minutes: service.duration_minutes },
    date: dateStr,
    available: slots.length > 0,
    slots,
  });
}

export async function handleCreateBooking(args: Record<string, unknown>): Promise<ToolEnvelope> {
  const customerId = str(args, 'customer_id');
  const customerObj = args.customer as Record<string, unknown> | undefined;
  const serviceQuery = str(args, 'service');
  const therapistId = str(args, 'therapist_id');
  const startTimeStr = str(args, 'start_time');

  if (!serviceQuery || !startTimeStr) return err('`service` and `start_time` are required.');

  const customerIdProvided = !!customerId;
  const customerObjProvided = isPopulatedCustomerObj(customerObj);

  if (customerIdProvided && customerObjProvided) {
    return err('Supply exactly one of `customer_id` or `customer`, not both.');
  }
  if (!customerIdProvided && !customerObjProvided) {
    return err('Supply exactly one of `customer_id` (existing customer) or `customer` (new customer).');
  }

  if (customerObjProvided) {
    const fn = fieldStr(customerObj, 'first_name');
    const ln = fieldStr(customerObj, 'last_name');
    if (!fn) return err('`customer.first_name` is required.');
    if (!ln) return err('`customer.last_name` is required.');
  }

  const service = findService(SERVICES, serviceQuery);
  if (!service) return err(`No service matched "${serviceQuery}".`);

  let start: Date;
  try {
    start = parseSpaInput(startTimeStr, 'start_time');
  } catch (e) {
    return err(e instanceof Error ? e.message : `Invalid start_time: "${startTimeStr}".`);
  }
  const end = new Date(start.getTime() + service.duration_minutes * 60_000);
  const startInstantMs = start.getTime();

  // --- Resolve customer ---
  // Resolve the customer first (before therapist selection / conflict check)
  // so we can detect an idempotent replay of the SAME booking request.
  let customer: Customer;
  if (customerId) {
    const customers = await readCustomers();
    const found = customers.find((c) => c.id === customerId);
    if (!found) return err(`No customer with id "${customerId}".`);
    customer = found;
  } else {
    const customers = await readCustomers();
    const phone = fieldStr(customerObj!, 'phone');
    const normalizedPhone = normalizePhone(phone);
    const matched = customers.filter(
      (c) => normalizePhone(c.phone) === normalizedPhone && normalizedPhone !== '',
    );
    if (matched.length === 1) {
      customer = matched[0];
    } else if (matched.length > 1) {
      return err(`Multiple customers share phone "${phone}". Provide the specific \`customer_id\` to target one.`);
    } else {
      if (!phone) return err('`customer.phone` is required for a new customer booking.');
      customer = buildNewCustomer(customerObj!, customers);
      customers.push(customer);
      await writeCustomers(customers);
    }
  }

  // --- Update SpaBookingSessionActor (transient per-caller state) ---
  // The dedicated sibling Edge Function owns the Stateful Actor.
  // Same normalized phone = same actor instance. The actor performs the
  // read-modify-write increment under its single-threaded execution model.
  // Best-effort: actor failures never block the booking flow.
  const phoneForActor = customer.phone;
  const actorKey = normalizePhoneForKey(phoneForActor);
  if (actorKey) {
    try {
      const actorResponse = await fetch(
        'https://spa-booking-actor-b4eb31db-1.telnyxcompute.com/record-booking-attempt',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone: actorKey,
            selectedService: service.name,
            selectedTime: spaFormatISO(start),
            bookingStep: 'create_booking',
            lastIntent: 'book_appointment',
          }),
        },
      );

      if (!actorResponse.ok) {
        throw new Error(`Actor HTTP ${actorResponse.status}: ${await actorResponse.text()}`);
      }

      const actorResult = await actorResponse.json() as {
        state?: {
          callCount?: number;
          bookingAttemptCount?: number;
          selectedService?: string;
          bookingStep?: string;
        };
      };

      console.info(JSON.stringify({
        event: 'booking_session_actor_updated',
        actor_key: actorKey,
        call_count: actorResult.state?.callCount,
        booking_attempt_count: actorResult.state?.bookingAttemptCount,
        selected_service: actorResult.state?.selectedService,
        booking_step: actorResult.state?.bookingStep,
      }));
    } catch (err) {
      console.error(JSON.stringify({
        event: 'booking_session_actor_error',
        actor_key: actorKey,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  const appointments = await readAppointments();

  // --- Idempotency check ---
  // Before normal slot-conflict rejection, check whether an existing
  // confirmed appointment already represents THIS booking request (same
  // resolved customer, same service, same requested start instant). The
  // customer's own first successful booking is what makes a retry appear
  // "unavailable", so we detect and short-circuit that case here.
  const replay = appointments.find(
    (a) =>
      a.status === 'confirmed' &&
      a.customer_id === customer.id &&
      a.service_id === service.id &&
      parseSpaInput(a.start_time, 'appointment start_time').getTime() === startInstantMs,
  );
  if (replay) {
    const t = THERAPISTS.find((x) => x.id === replay.therapist_id);
    return {
      content: [{ type: 'text', text: JSON.stringify({
        success: true,
        appointment_id: replay.id,
        customer_id: customer.id,
        service: { id: service.id, name: service.name },
        therapist: { id: replay.therapist_id, name: t?.name ?? replay.therapist_id },
        start_time: replay.start_time,
        end_time: replay.end_time,
        status: replay.status,
        already_existed: true,
      }, null, 2) }],
      bookingOutcome: 'booking_idempotent_replay',
    };
  }

  // --- Therapist selection ---
  // Genuine new booking: validate availability and select a therapist.
  let selectedTherapist: Therapist | undefined;
  if (therapistId) {
    const t = THERAPISTS.find((x) => x.id === therapistId);
    if (!t) return err(`No therapist with id "${therapistId}".`);
    if (!t.service_ids.includes(service.id)) {
      return err(`${t.name} does not offer ${service.name}.`);
    }
    if (!isSlotFree(service, t, start, end, appointments)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: false,
          message: `The requested therapist (${t.name}) is not available at the requested time (outside working hours or conflicts with an existing confirmed appointment).`,
        }, null, 2) }],
        bookingOutcome: 'booking_rejected',
      };
    }
    selectedTherapist = t;
  } else {
    for (const t of THERAPISTS) {
      if (!t.service_ids.includes(service.id)) continue;
      if (isSlotFree(service, t, start, end, appointments)) {
        selectedTherapist = t;
        break;
      }
    }
    if (!selectedTherapist) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          success: false,
          message: 'No therapist qualified for this service is available at the requested time.',
        }, null, 2) }],
        bookingOutcome: 'booking_rejected',
      };
    }
  }

  const newAppt: Appointment = {
    id: nextAppointmentId(appointments),
    customer_id: customer.id,
    customer_name: customer.name,
    therapist_id: selectedTherapist.id,
    service_id: service.id,
    start_time: spaFormatISO(start),
    end_time: spaFormatISO(end),
    status: 'confirmed',
  };

  appointments.push(newAppt);
  await writeAppointments(appointments);

  return {
    content: [{ type: 'text', text: JSON.stringify({
      success: true,
      appointment_id: newAppt.id,
      customer_id: customer.id,
      service: { id: service.id, name: service.name },
      therapist: { id: selectedTherapist.id, name: selectedTherapist.name },
      start_time: newAppt.start_time,
      end_time: newAppt.end_time,
      status: newAppt.status,
      already_existed: false,
    }, null, 2) }],
    bookingOutcome: 'booking_created',
  };
}

export async function handleGetAppointment(args: Record<string, unknown>): Promise<ToolEnvelope> {
  const phone = str(args, 'phone');
  const appointmentId = str(args, 'appointment_id');
  const customerId = str(args, 'customer_id');

  if (!phone && !appointmentId && !customerId) {
    return err('Provide `phone` (preferred), or `appointment_id`/`customer_id` for internal lookup.');
  }

  const appointments = await readAppointments();
  const customers = await readCustomers();
  const serviceById = new Map(SERVICES.map((s) => [s.id, s] as const));
  const therapistById = new Map(THERAPISTS.map((t) => [t.id, t] as const));

  if (appointmentId || customerId) {
    const matches = appointments.filter((a) => {
      if (appointmentId) return a.id === appointmentId;
      return a.customer_id === customerId;
    });
    if (matches.length === 0) {
      return result({
        found: false,
        message: appointmentId
          ? `No appointment with id "${appointmentId}".`
          : `No appointments found for customer_id "${customerId}".`,
      });
    }
    const projected = matches.map((a) => projectAppointment(a, serviceById, therapistById));
    return result({ found: true, count: projected.length, appointments: projected });
  }

  // By phone (primary caller-facing lookup).
  const normalized = normalizePhone(phone);
  const matched = customers.filter(
    (c) => normalizePhone(c.phone) === normalized && normalized !== '',
  );

  if (matched.length === 0) {
    return result({ found: false, message: `No customer with phone "${phone}".` });
  }
  if (matched.length === 1) {
    const cus = matched[0];
    const appts = appointments.filter((a) => a.customer_id === cus.id);
    if (appts.length === 0) {
      return result({ found: false, message: `No appointments found for phone "${phone}".` });
    }
    const projected = appts.map((a) => projectAppointment(a, serviceById, therapistById));
    return result({ found: true, count: projected.length, appointments: projected });
  }
  return result({
    found: true,
    ambiguous: true,
    message: `Multiple customers share phone "${phone}". Provide the specific \`customer_id\` to target one.`,
    matching_customers: matched.map((c) => ({ customer_id: c.id, name: c.name })),
    count: matched.length,
  });
}

export async function handleRescheduleBooking(args: Record<string, unknown>): Promise<ToolEnvelope> {
  const firstName = str(args, 'first_name');
  const lastName = str(args, 'last_name');
  const phone = str(args, 'phone');
  const newStartStr = str(args, 'new_start_time');
  const newTherapistId = str(args, 'new_therapist_id');
  const serviceSelector = str(args, 'service');
  const currentStartStr = str(args, 'current_start_time');

  if (!firstName || !lastName || !phone || !newStartStr) {
    return err('`first_name`, `last_name`, `phone`, and `new_start_time` are required.');
  }

  const fullName = `${firstName} ${lastName}`.trim();
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return result({ rescheduled: false, message: `No customer found for phone "${phone}".` });
  }

  const customers = await readCustomers();
  const matchedCustomers = customers.filter(
    (c) => c.name === fullName && normalizePhone(c.phone) === normalizedPhone,
  );
  if (matchedCustomers.length === 0) {
    return result({ rescheduled: false, message: `No customer found for "${fullName}" with phone "${phone}".` });
  }
  if (matchedCustomers.length > 1) {
    return result({
      rescheduled: false,
      ambiguous: true,
      message: `Multiple customer records match "${fullName}" + phone "${phone}". This should not happen with unique phone numbers; please contact support.`,
      matching_customers: matchedCustomers.map((c) => ({ customer_id: c.id, name: c.name })),
      count: matchedCustomers.length,
    });
  }
  const customer = matchedCustomers[0];

  const appointments = await readAppointments();
  const serviceById = new Map(SERVICES.map((s) => [s.id, s] as const));
  const therapistById = new Map(THERAPISTS.map((t) => [t.id, t] as const));

  let upcoming = appointments.filter(
    (a) => a.customer_id === customer.id && a.status === 'confirmed',
  );

  if (upcoming.length === 0) {
    return result({ rescheduled: false, message: `No upcoming confirmed appointments found for "${fullName}".` });
  }

  // --- Narrow by optional selectors ---
  if (upcoming.length > 1 && (serviceSelector || currentStartStr)) {
    if (serviceSelector) {
      const svc = findService(SERVICES, serviceSelector);
      if (!svc) return result({ rescheduled: false, message: `No service matched "${serviceSelector}".` });
      upcoming = upcoming.filter((a) => a.service_id === svc.id);
    }
    if (currentStartStr) {
      let target: Date;
      try {
        target = parseSpaInput(currentStartStr, 'current_start_time');
      } catch {
        return result({ rescheduled: false, message: `Invalid current_start_time: "${currentStartStr}".` });
      }
      upcoming = upcoming.filter(
        (a) => parseSpaInput(a.start_time, 'appointment start_time').getTime() === target.getTime(),
      );
    }
    if (upcoming.length === 0) {
      return result({
        rescheduled: false,
        message: `No upcoming appointment found for "${fullName}" matching the provided service/current_start_time selectors.`,
      });
    }
    if (upcoming.length > 1) {
      return result({
        rescheduled: false,
        ambiguous: true,
        message: `Multiple upcoming appointments for "${fullName}" match the provided selectors. Please clarify which appointment to reschedule.`,
        matching_appointments: upcoming.map((a) => projectAppointment(a, serviceById, therapistById)),
        count: upcoming.length,
      });
    }
  } else if (upcoming.length > 1) {
    return result({
      rescheduled: false,
      ambiguous: true,
      message: `Multiple upcoming appointments found for "${fullName}". Please specify \`service\` and/or \`current_start_time\` to identify which appointment to reschedule.`,
      matching_appointments: upcoming.map((a) => projectAppointment(a, serviceById, therapistById)),
      count: upcoming.length,
    });
  }

  const existing = upcoming[0];
  const idx = appointments.findIndex((a) => a.id === existing.id);

  const service = SERVICES.find((s) => s.id === existing.service_id);
  if (!service) return err(`Service "${existing.service_id}" no longer exists.`);

  let start: Date;
  try {
    start = parseSpaInput(newStartStr, 'new_start_time');
  } catch (e) {
    return err(e instanceof Error ? e.message : `Invalid new_start_time: "${newStartStr}".`);
  }
  const end = new Date(start.getTime() + service.duration_minutes * 60_000);

  // --- Therapist selection ---
  let selected: Therapist | undefined;
  if (newTherapistId) {
    const t = THERAPISTS.find((x) => x.id === newTherapistId);
    if (!t) return err(`No therapist with id "${newTherapistId}".`);
    if (!t.service_ids.includes(service.id)) return err(`${t.name} does not offer ${service.name}.`);
    if (!isSlotFree(service, t, start, end, appointments, existing.id)) {
      return result({
        rescheduled: false,
        message: `The requested therapist (${t.name}) is not available at the requested time (outside working hours or conflicts with another confirmed appointment).`,
      });
    }
    selected = t;
  } else {
    const candidates = [
      ...THERAPISTS.filter((t) => t.id === existing.therapist_id),
      ...THERAPISTS.filter((t) => t.id !== existing.therapist_id && t.service_ids.includes(service.id)),
    ];
    for (const t of candidates) {
      if (!t.service_ids.includes(service.id)) continue;
      if (isSlotFree(service, t, start, end, appointments, existing.id)) {
        selected = t;
        break;
      }
    }
    if (!selected) {
      return result({
        rescheduled: false,
        message: 'No therapist qualified for this service is available at the requested time (existing therapist unavailable and no other qualified therapist free).',
      });
    }
  }

  const updated: Appointment = {
    id: existing.id,
    customer_id: existing.customer_id,
    customer_name: existing.customer_name,
    service_id: existing.service_id,
    therapist_id: selected.id,
    start_time: spaFormatISO(start),
    end_time: spaFormatISO(end),
    status: 'confirmed',
  };

  appointments[idx] = updated;
  await writeAppointments(appointments);

  return result({
    rescheduled: true,
    appointment: updated,
    service: { id: service.id, name: service.name },
    therapist: { id: selected.id, name: selected.name },
  });
}

// ---------- Dynamic Webhook Variables (/dynamic-context) ----------
//
// Used by the Telnyx AI Assistant dynamic_variables_webhook_url. Telnyx
// calls this at conversation initialization. We defensively extract the
// caller's phone number, normalize it, and look up whether they are a
// returning customer with upcoming appointments. The response is wrapped
// under a top-level "dynamic_variables" object and never exposes PII other
// than the customer's first name.

/**
 * Defensive extraction of the caller phone number from a Telnyx AI
 * initialization webhook payload. The exact Telnyx payload shape can vary,
 * so we check a set of reasonable nested fields and return the first
 * string we find. Never throws; returns '' when no number is present.
 *
 * Fields checked, in order:
 *   - payload.caller_phone_number
 *   - payload.from_number
 *   - payload.from
 *   - payload.phone_number
 *   - payload.customer.phone            (customer sub-object)
 *   - payload.session.from_number
 *   - payload.session.caller_phone_number
 *   - payload.session.from
 *   - payload.data.caller_phone_number
 *   - payload.data.from_number
 *   - top-level caller_phone_number / from_number / from / phone_number
 *
 * Also accepts the same fields under snake_case variants used elsewhere in
 * our API (e.g. `phone` at the top level for parity with get_appointment).
 */
export function extractCallerPhone(payload: Record<string, unknown>): string {
  const candidates: unknown[] = [];

  // Top-level fields (parity with our /api inputs + common Telnyx shapes).
  candidates.push(
    payload.caller_phone_number,
    payload.from_number,
    payload.from,
    payload.phone_number,
    payload.phone,
  );

  // Nested `payload.session.*` (Telnyx AI Assistant session object).
  const session = payload.session as Record<string, unknown> | undefined;
  if (session && typeof session === 'object') {
    candidates.push(
      session.caller_phone_number,
      session.from_number,
      session.from,
      session.phone_number,
      session.phone,
    );
  }

  // Nested `payload.data.*` (alternate Telnyx webhook envelope).
  const data = payload.data as Record<string, unknown> | undefined;
  if (data && typeof data === 'object') {
    candidates.push(
      data.caller_phone_number,
      data.from_number,
      data.from,
      data.phone_number,
      data.phone,
    );
  }

  // Nested `payload.customer.phone` (Telnyx caller profile).
  const customer = payload.customer as Record<string, unknown> | undefined;
  if (customer && typeof customer === 'object') {
    candidates.push(customer.phone, customer.phone_number);
  }

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') {
      return c.trim();
    }
  }
  return '';
}

/** Default dynamic_variables for an unknown / unresolvable caller. */
function unknownDynamicVariables(
  afterCallSurveyEnabled = false,
): Record<string, unknown> {
  return {
    returning_customer: false,
    customer_first_name: '',
    has_appointments: false,
    appointment_count: 0,
    upcoming_service: '',
    upcoming_appointment_time: '',
    suggested_workflow: 'booking',
    after_call_survey_enabled: afterCallSurveyEnabled,
  };
}

/**
 * Build the /dynamic-context response. Returns the inner
 * "dynamic_variables" object (the caller wraps it). Performs KV reads;
 * async. Never throws — on any failure returns the unknown-caller defaults.
 *
 * PII policy: only customer_first_name is exposed. No customer_id,
 * appointment_id, DOB, email, notes, or full phone number is returned.
 */
export async function handleDynamicContext(
  payload: Record<string, unknown>,
): Promise<{ dynamic_variables: Record<string, unknown> }> {
  try {
    const afterCallSurveyEnabled = await readAfterCallSurveyEnabled();

    const rawPhone = extractCallerPhone(payload);
    const normalized = normalizePhone(rawPhone);

    if (!normalized) {
      return { dynamic_variables: unknownDynamicVariables(afterCallSurveyEnabled) };
    }

    const customers = await readCustomers();
    const matched = customers.filter(
      (c) => normalizePhone(c.phone) === normalized,
    );

    if (matched.length === 0) {
      return { dynamic_variables: unknownDynamicVariables(afterCallSurveyEnabled) };
    }

    // Unique phone match is expected; if multiple share a phone, conservatively
    // treat as unknown (do not expose which customer).
    if (matched.length > 1) {
      return { dynamic_variables: unknownDynamicVariables(afterCallSurveyEnabled) };
    }
    const customer = matched[0];

    const appointments = await readAppointments();
    const confirmed = appointments.filter(
      (a) => a.customer_id === customer.id && a.status === 'confirmed',
    );

    const appointmentCount = confirmed.length;
    const hasAppointments = appointmentCount > 0;

    // First name = first whitespace-separated token of the stored full name.
    const firstName = (customer.name.trim().split(/\s+/)[0]) ?? '';

    // Nearest future confirmed appointment (by start_time ascending). We
    // compare instants; "future" is relative to now in spa time.
    const now = Date.now();
    let upcoming: Appointment | undefined;
    let upcomingInstant = Infinity;
    for (const a of confirmed) {
      const inst = parseSpaInput(a.start_time, 'appointment start_time').getTime();
      if (inst >= now && inst < upcomingInstant) {
        upcomingInstant = inst;
        upcoming = a;
      }
    }

    // If none in the future, fall back to the soonest of all confirmed
    // (so a caller with a past appointment still sees context). This keeps
    // has_appointments consistent with appointment_count.
    if (!upcoming && confirmed.length > 0) {
      let soonestInstant = -Infinity;
      for (const a of confirmed) {
        const inst = parseSpaInput(a.start_time, 'appointment start_time').getTime();
        if (inst > soonestInstant) {
          soonestInstant = inst;
          upcoming = a;
        }
      }
    }

    // Resolve the upcoming service display name from bundled static data.
    let upcomingService = '';
    if (upcoming) {
      const svc = SERVICES.find((s) => s.id === upcoming!.service_id);
      upcomingService = svc?.name ?? upcoming.service_id;
    }

    return {
      dynamic_variables: {
        returning_customer: true,
        customer_first_name: firstName,
        has_appointments: hasAppointments,
        appointment_count: appointmentCount,
        upcoming_service: upcoming ? upcomingService : '',
        upcoming_appointment_time: upcoming ? upcoming.start_time : '',
        suggested_workflow: hasAppointments ? 'client_services' : 'booking',
        after_call_survey_enabled: afterCallSurveyEnabled,
      },
    };
  } catch {
    // Never fail the webhook — return safe defaults.
    return { dynamic_variables: unknownDynamicVariables() };
  }
}
