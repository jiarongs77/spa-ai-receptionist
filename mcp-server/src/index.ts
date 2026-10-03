#!/usr/bin/env node
// Minimal MCP server for the fictional Spa House AI receptionist.
//
// Tools exposed:
//   1. get_service_info
//   2. check_availability
//   3. create_booking
//   4. get_appointment
//   5. reschedule_booking
//
// Transports:
//   - stdio (default): the standard MCP transport for local tool servers.
//   - http (Streamable HTTP): for remote access; enabled with --http or
//     MCP_TRANSPORT=http. Serves POST /mcp on PORT (default 3000).
//
// Data source: the JSON files under /data (read at call-time so changes
// are picked up without a restart).

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  loadServices, loadTherapists, loadCustomers, loadAppointments,
  saveAppointments, saveCustomers, nextAppointmentId,
  parseSpaInput, spaFormatISO,
  type Service, type Therapist, type Customer, type Appointment,
} from './types.js';
import { computeAvailability, isSlotFree } from './availability.js';

// ---------- Tool schemas ----------

const tools = [
  {
    name: 'get_service_info',
    description:
      'Look up a spa service by name or ID. Returns the service name, ' +
      'description, duration (minutes), and price (USD).',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description:
            'A service ID (e.g. "svc-swedish-massage") or a service name ' +
            '(e.g. "Swedish Massage"). Matching is case-insensitive and ' +
            'whitespace-trimming.',
        },
      },
      required: ['service'],
    },
  },
  {
    name: 'check_availability',
    description:
      'Find available appointment slots for a service on a given date. ' +
      'Optionally filter by a preferred therapist. Returns concrete ' +
      'start/end times per available therapist. Does not invent availability.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Service ID or service name.',
        },
        date: {
          type: 'string',
          description:
            'Requested date as an ISO date string, e.g. "2026-10-06". ' +
            'Time-of-day is ignored; the whole working day is considered.',
        },
        therapist_id: {
          type: 'string',
          description: 'Optional preferred therapist ID.',
        },
      },
      required: ['service', 'date'],
    },
  },
  {
    name: 'create_booking',
    description:
      'Book an appointment. Customer resolution: supply `customer_id` ' +
      '(UUID) OR `customer` (first_name + last_name + phone). For new ' +
      'customers all three are required. If an existing customer matches ' +
      'the full name + phone, reuses their UUID (no duplicate). ' +
      '`therapist_id` is optional (auto-selects).',
    inputSchema: {
      type: 'object',
      properties: {
        customer_id: {
          type: 'string',
          description: 'Existing customer UUID. Mutually exclusive with `customer`.',
        },
        customer: {
          type: 'object',
          description:
            'Customer details. Reuses an existing customer if full name + ' +
            'phone matches; otherwise creates a new customer. ' +
            'first_name, last_name, and phone are required for new ' +
            'customers. Mutually exclusive with `customer_id`.',
          properties: {
            first_name: { type: 'string', description: 'Required.' },
            last_name: { type: 'string', description: 'Required.' },
            phone: { type: 'string', description: 'Required. Formatting-insensitive matching (e.g. +1-213-555-1234 == 2135551234).' },
            email: { type: 'string', description: 'Optional.' },
            postcode: { type: 'string', description: 'Optional.' },
            date_of_birth: { type: 'string', description: 'Optional.' },
            notes: { type: 'string', description: 'Optional.' },
          },
          required: ['first_name', 'last_name', 'phone'],
        },
        service: { type: 'string', description: 'Service ID or name.' },
        therapist_id: {
          type: 'string',
          description: 'Optional therapist ID. If omitted, an available qualified therapist is selected automatically.',
        },
        start_time: {
          type: 'string',
          description: 'Start time. Accepts ISO ("2026-10-07T10:00:00-07:00") or natural ("October 10, 2026 5:30 PM").',
        },
      },
      required: ['service', 'start_time'],
    },
  },
  {
    name: 'get_appointment',
    description:
      'Look up appointments by customer phone number. Phone is the ' +
      'primary caller-facing lookup; callers do not need to know the ' +
      'internal customer_id or appointment_id. Normalizes phone so ' +
      'formatting differences match. Returns found:false if no customer ' +
      'matches. If multiple customers share the same phone, returns an ' +
      'ambiguity error. appointment_id and customer_id remain as optional ' +
      'internal lookup methods. Customer-sensitive fields ' +
      '(phone/email/DOB/notes) are not exposed in results.',
    inputSchema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          description:
            'Customer phone number (primary lookup). Formatting-insensitive: ' +
            '"+1-213-555-1234", "(213) 555-1234", and "2135551234" all match ' +
            'the same customer. Matches full normalized numbers only.',
        },
        appointment_id: {
          type: 'string',
          description: 'Optional. An appointment ID for direct lookup.',
        },
        customer_id: {
          type: 'string',
          description: 'Optional. A customer UUID for direct lookup.',
        },
      },
      required: ['phone'],
    },
  },
  {
    name: 'reschedule_booking',
    description:
      'Reschedule an existing confirmed appointment to a new start time. ' +
      'The caller identifies themselves with first_name + last_name + ' +
      'phone (all required); the server resolves the customer, finds ' +
      'their upcoming confirmed appointment, and reschedules it. If the ' +
      'customer has multiple upcoming appointments, returns them for the ' +
      'caller to disambiguate (does NOT modify any). Preserves the ' +
      'original service, customer, appointment ID, and "confirmed" ' +
      'status. `new_therapist_id` is OPTIONAL; if omitted, prefers the ' +
      'existing therapist when available, otherwise auto-selects another ' +
      'qualified available therapist.',
    inputSchema: {
      type: 'object',
      properties: {
        first_name: { type: 'string', description: 'Customer first name. Required.' },
        last_name: { type: 'string', description: 'Customer last name. Required.' },
        phone: {
          type: 'string',
          description: 'Customer phone. Required. Formatting-insensitive ' +
            'matching (e.g. +1-213-555-1234 == 2135551234).',
        },
        new_start_time: {
          type: 'string',
          description: 'New start time. Accepts ISO or natural forms.',
        },
        new_therapist_id: {
          type: 'string',
          description: 'Optional therapist ID. If omitted, auto-selects an available qualified therapist.',
        },
      },
      required: ['first_name', 'last_name', 'phone', 'new_start_time'],
    },
  },
] as const;

// ---------- Server ----------

const server = new Server(
  { name: 'spa-mcp-server', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'get_service_info':
        return handleGetServiceInfo(args);
      case 'check_availability':
        return handleCheckAvailability(args);
      case 'create_booking':
        return handleCreateBooking(args);
      case 'get_appointment':
        return handleGetAppointment(args);
      case 'reschedule_booking':
        return handleRescheduleBooking(args);
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(`Tool "${name}" failed: ${message}`);
  }
});

// ---------- Handlers ----------

function handleGetServiceInfo(args: Record<string, unknown>) {
  const query = str(args, 'service');
  if (!query) return toolError('`service` is required.');

  const services = loadServices();
  const match = findService(services, query);
  if (!match) {
    return toolResult({
      found: false,
      message: `No service matched "${query}".`,
    });
  }
  return toolResult({
    found: true,
    id: match.id,
    name: match.name,
    description: match.description,
    duration_minutes: match.duration_minutes,
    price_usd: match.price_usd,
  });
}

function handleCheckAvailability(args: Record<string, unknown>) {
  const serviceQuery = str(args, 'service');
  const dateStr = str(args, 'date');
  const therapistId = str(args, 'therapist_id'); // optional

  if (!serviceQuery || !dateStr) {
    return toolError('`service` and `date` are required.');
  }

  const services = loadServices();
  const service = findService(services, serviceQuery);
  if (!service) {
    return toolError(`No service matched "${serviceQuery}".`);
  }

  // Parse the requested date in spa-local time (America/Los_Angeles).
  // Accepts YYYY-MM-DD and common month-name formats (e.g. "October 10, 2026").
  let date: Date;
  try {
    date = parseSpaInput(dateStr, 'date');
  } catch (e) {
    return toolError(e instanceof Error ? e.message : `Invalid date: "${dateStr}".`);
  }

  const therapists = loadTherapists();
  const appointments = loadAppointments();

  const slots = computeAvailability(
    service, date, therapists, appointments, therapistId || undefined,
  );

  if (therapistId) {
    const t = therapists.find((x) => x.id === therapistId);
    if (!t) return toolError(`No therapist with id "${therapistId}".`);
    if (!t.service_ids.includes(service.id)) {
      return toolResult({
        service: { id: service.id, name: service.name },
        therapist: { id: t.id, name: t.name },
        available: false,
        message: `${t.name} does not offer ${service.name}.`,
        slots: [],
      });
    }
  }

  return toolResult({
    service: { id: service.id, name: service.name, duration_minutes: service.duration_minutes },
    date: dateStr,
    available: slots.length > 0,
    slots,
  });
}

function handleCreateBooking(args: Record<string, unknown>) {
  const customerId = str(args, 'customer_id'); // optional
  const customerObj = args.customer as Record<string, unknown> | undefined;
  const serviceQuery = str(args, 'service');
  const therapistId = str(args, 'therapist_id');
  const startTimeStr = str(args, 'start_time');

  if (!serviceQuery || !startTimeStr) {
    return toolError('`service` and `start_time` are required.');
  }

  // Input rule: exactly one customer identification method, where
  // "provided" means a non-empty customer_id OR a populated customer object.
  // We treat undefined, null, "", and {} as NOT provided, so e.g.
  // { customer_id: "cus-david", customer: {} } is valid (uses the id).
  const customerIdProvided = !!customerId;
  const customerObjProvided = isPopulatedCustomerObj(customerObj);

  if (customerIdProvided && customerObjProvided) {
    return toolError(
      'Supply exactly one of `customer_id` or `customer`, not both.',
    );
  }
  if (!customerIdProvided && !customerObjProvided) {
    return toolError(
      'Supply exactly one of `customer_id` (existing customer) or `customer` (new customer).',
    );
  }

  // Validate new-customer required fields early, with clear structured
  // errors, before any persistence. For a customer object, the caller
  // must provide first_name + last_name + phone (all three required for
  // new/guest bookings). The full name is built as
  // "<first_name> <last_name>".
  if (customerObjProvided) {
    const fn = fieldStr(customerObj, 'first_name');
    const ln = fieldStr(customerObj, 'last_name');
    if (!fn) return toolError('`customer.first_name` is required.');
    if (!ln) return toolError('`customer.last_name` is required.');
  }

  // Validate service.
  const services = loadServices();
  const service = findService(services, serviceQuery);
  if (!service) return toolError(`No service matched "${serviceQuery}".`);

  const therapists = loadTherapists();

  // Parse requested time (spa-local for naive inputs) and compute end from
  // service duration. The wall-clock hour/minute is preserved exactly.
  const start = parseSpaInput(startTimeStr, 'start_time');
  const end = new Date(start.getTime() + service.duration_minutes * 60_000);

  // Re-check availability against the live appointments file (shared engine).
  const appointments = loadAppointments();

  // --- Therapist selection ---------------------------------------------
  // If therapist_id is provided: validate + check that specific therapist.
  // If omitted: auto-select any therapist qualified for the service who is
  //   available at start_time, in deterministic (file) order.
  // A booking is never created unless the selected therapist is available.
  let selectedTherapist: Therapist | undefined;

  if (therapistId) {
    const t = therapists.find((x) => x.id === therapistId);
    if (!t) return toolError(`No therapist with id "${therapistId}".`);
    if (!t.service_ids.includes(service.id)) {
      return toolError(`${t.name} does not offer ${service.name}.`);
    }
    if (!isSlotFree(service, t, start, end, appointments)) {
      return toolResult({
        success: false,
        message:
          `The requested therapist (${t.name}) is not available at the ` +
          'requested time (outside working hours or conflicts with an ' +
          'existing confirmed appointment).',
      });
    }
    selectedTherapist = t;
  } else {
    // Deterministic order: therapists in data-file order.
    for (const t of therapists) {
      if (!t.service_ids.includes(service.id)) continue;
      if (isSlotFree(service, t, start, end, appointments)) {
        selectedTherapist = t;
        break;
      }
    }
    if (!selectedTherapist) {
      return toolResult({
        success: false,
        message:
          'No therapist qualified for this service is available at the ' +
          'requested time.',
      });
    }
  }

  // Resolve the customer ONLY after all booking validation has passed.
  // The UUID is the authoritative internal ID; the caller does NOT need
  // to know it. Resolution order:
  //   1. customer_id provided -> direct lookup (must exist)
  //   2. customer object provided -> build full name from first_name +
  //      last_name, normalize phone, then search by normalized phone:
  //      - exactly one match -> reuse existing UUID (no duplicate)
  //      - no match -> create new customer (first_name, last_name, phone
  //        were validated above; phone normalization is applied)
  //      - multiple matches on the same normalized phone -> error (never guess)
  let customer: Customer;
  if (customerId) {
    const customers = loadCustomers();
    const found = customers.find((c) => c.id === customerId);
    if (!found) return toolError(`No customer with id "${customerId}".`);
    customer = found;
  } else {
    const customers = loadCustomers();
    const firstName = fieldStr(customerObj!, 'first_name');
    const lastName = fieldStr(customerObj!, 'last_name');
    const fullName = `${firstName} ${lastName}`.trim();
    const phone = fieldStr(customerObj!, 'phone');
    const normalizedPhone = normalizePhone(phone);

    // Match existing customers by normalized phone (full number only).
    const matched = customers.filter(
      (c) => normalizePhone(c.phone) === normalizedPhone && normalizedPhone !== '',
    );

    if (matched.length === 1) {
      customer = matched[0]; // reuse existing UUID (no duplicate)
    } else if (matched.length > 1) {
      return toolError(
        `Multiple customers share phone "${phone}". Provide the specific ` +
        '`customer_id` to target one.',
      );
    } else {
      // No existing match -> create new customer. Phone is required for a
      // new booking; first_name and last_name were validated above.
      if (!phone) {
        return toolError(
          '`customer.phone` is required for a new customer booking.',
        );
      }
      customer = buildNewCustomer(customerObj!, customers);
      customers.push(customer);
      saveCustomers(customers);
    }
  }

  const newAppt: Appointment = {
    id: nextAppointmentId(appointments),
    customer_id: customer.id,
    customer_name: customer.name, // denormalized for readability
    therapist_id: selectedTherapist.id,
    service_id: service.id,
    start_time: spaFormatISO(start),
    end_time: spaFormatISO(end),
    status: 'confirmed',
  };

  appointments.push(newAppt);
  saveAppointments(appointments);

  return toolResult({
    success: true,
    appointment_id: newAppt.id,
    customer_id: customer.id,
    service: { id: service.id, name: service.name },
    therapist: { id: selectedTherapist.id, name: selectedTherapist.name },
    start_time: newAppt.start_time,
    end_time: newAppt.end_time,
    status: newAppt.status,
  });
}

// ---------- Client Services handlers ----------

function handleGetAppointment(args: Record<string, unknown>) {
  const phone = str(args, 'phone');
  const appointmentId = str(args, 'appointment_id');
  const customerId = str(args, 'customer_id');

  // `phone` is the primary caller-facing lookup. appointment_id and
  // customer_id remain as optional internal lookup methods. At least one
  // must be provided.
  if (!phone && !appointmentId && !customerId) {
    return toolError(
      'Provide `phone` (preferred), or `appointment_id`/`customer_id` for internal lookup.',
    );
  }

  const appointments = loadAppointments();
  const services = loadServices();
  const therapists = loadTherapists();
  const customers = loadCustomers();

  const serviceById = new Map(services.map((s) => [s.id, s] as const));
  const therapistById = new Map(therapists.map((t) => [t.id, t] as const));

  // --- By appointment_id or customer_id: direct internal lookup ----
  if (appointmentId || customerId) {
    const matches = appointments.filter((a) => {
      if (appointmentId) return a.id === appointmentId;
      return a.customer_id === customerId;
    });

    if (matches.length === 0) {
      return toolResult({
        found: false,
        message: appointmentId
          ? `No appointment with id "${appointmentId}".`
          : `No appointments found for customer_id "${customerId}".`,
      });
    }

    const projected = matches.map((a) =>
      projectAppointment(a, serviceById, therapistById),
    );
    return toolResult({ found: true, count: projected.length, appointments: projected });
  }

  // --- By phone (primary caller-facing lookup) ----------------------
  // Normalize before matching so formatting differences resolve to the
  // same customer. Match the FULL normalized number only (never partial).
  const normalized = normalizePhone(phone);
  const matched = customers.filter(
    (c) => normalizePhone(c.phone) === normalized && normalized !== '',
  );

  if (matched.length === 0) {
    return toolResult({
      found: false,
      message: `No customer with phone "${phone}".`,
    });
  }

  if (matched.length === 1) {
    const cus = matched[0];
    const appts = appointments.filter((a) => a.customer_id === cus.id);
    if (appts.length === 0) {
      return toolResult({
        found: false,
        message: `No appointments found for phone "${phone}".`,
      });
    }
    const projected = appts.map((a) =>
      projectAppointment(a, serviceById, therapistById),
    );
    return toolResult({ found: true, count: projected.length, appointments: projected });
  }

  // Multiple customers share the same normalized phone -> error (never
  // guess). Return candidate customer IDs (no sensitive fields) for the
  // caller to disambiguate via customer_id.
  return toolResult({
    found: true,
    ambiguous: true,
    message:
      `Multiple customers share phone "${phone}". Provide the specific ` +
    '`customer_id` to target one.',
    matching_customers: matched.map((c) => ({
      customer_id: c.id,
      name: c.name,
    })),
    count: matched.length,
  });
}

function handleRescheduleBooking(args: Record<string, unknown>) {
  const firstName = str(args, 'first_name');
  const lastName = str(args, 'last_name');
  const phone = str(args, 'phone');
  const newStartStr = str(args, 'new_start_time');
  const newTherapistId = str(args, 'new_therapist_id'); // optional

  // All three customer-identification fields are required. Name alone is
  // never sufficient.
  if (!firstName || !lastName || !phone || !newStartStr) {
    return toolError(
      '`first_name`, `last_name`, `phone`, and `new_start_time` are required.',
    );
  }

  // Resolve the customer by full name + normalized phone. Never identify
  // by name alone.
  const fullName = `${firstName} ${lastName}`.trim();
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return toolResult({
      rescheduled: false,
      message: `No customer found for phone "${phone}".`,
    });
  }

  const customers = loadCustomers();
  const matchedCustomers = customers.filter(
    (c) => c.name === fullName && normalizePhone(c.phone) === normalizedPhone,
  );

  if (matchedCustomers.length === 0) {
    return toolResult({
      rescheduled: false,
      message: `No customer found for "${fullName}" with phone "${phone}".`,
    });
  }
  if (matchedCustomers.length > 1) {
    return toolResult({
      rescheduled: false,
      ambiguous: true,
      message:
        `Multiple customer records match "${fullName}" + phone "${phone}". ` +
        'This should not happen with unique phone numbers; please contact support.',
      matching_customers: matchedCustomers.map((c) => ({
        customer_id: c.id,
        name: c.name,
      })),
      count: matchedCustomers.length,
    });
  }
  const customer = matchedCustomers[0];

  // Find this customer's upcoming confirmed appointments.
  const appointments = loadAppointments();
  const serviceById = new Map(loadServices().map((s) => [s.id, s] as const));
  const therapistById = new Map(loadTherapists().map((t) => [t.id, t] as const));

  const upcoming = appointments.filter(
    (a) => a.customer_id === customer.id && a.status === 'confirmed',
  );

  if (upcoming.length === 0) {
    return toolResult({
      rescheduled: false,
      message: `No upcoming confirmed appointments found for "${fullName}".`,
    });
  }

  if (upcoming.length > 1) {
    // Do NOT arbitrarily reschedule one. Return the matching appointments
    // with non-sensitive details so the caller can identify the intended
    // appointment. Do not modify any appointment.
    return toolResult({
      rescheduled: false,
      ambiguous: true,
      message:
        `Multiple upcoming appointments found for "${fullName}". Please ` +
        'specify which appointment to reschedule.',
      matching_appointments: upcoming.map((a) =>
        projectAppointment(a, serviceById, therapistById),
      ),
      count: upcoming.length,
    });
  }

  const existing = upcoming[0];
  const idx = appointments.findIndex((a) => a.id === existing.id);

  const services = loadServices();
  const service = services.find((s) => s.id === existing.service_id);
  if (!service) {
    return toolError(`Service "${existing.service_id}" no longer exists.`);
  }

  const start = parseSpaInput(newStartStr, 'new_start_time');
  const end = new Date(start.getTime() + service.duration_minutes * 60_000);

  const therapists = loadTherapists();

  // --- Therapist selection ---------------------------------------------
  // If new_therapist_id is provided: validate that specific therapist.
  // If omitted: prefer the existing therapist when available, otherwise
  //   auto-select another qualified available therapist (file order).
  let selected: Therapist | undefined;

  if (newTherapistId) {
    const t = therapists.find((x) => x.id === newTherapistId);
    if (!t) return toolError(`No therapist with id "${newTherapistId}".`);
    if (!t.service_ids.includes(service.id)) {
      return toolError(`${t.name} does not offer ${service.name}.`);
    }
    if (!isSlotFree(service, t, start, end, appointments, existing.id)) {
      return toolResult({
        rescheduled: false,
        message:
          `The requested therapist (${t.name}) is not available at the ` +
          'requested time (outside working hours or conflicts with another ' +
          'confirmed appointment).',
      });
    }
    selected = t;
  } else {
    // Prefer existing therapist, then any other qualified therapist.
    const candidates = [
      ...therapists.filter((t) => t.id === existing.therapist_id),
      ...therapists.filter(
        (t) => t.id !== existing.therapist_id && t.service_ids.includes(service.id),
      ),
    ];
    for (const t of candidates) {
      if (!t.service_ids.includes(service.id)) continue;
      if (isSlotFree(service, t, start, end, appointments, existing.id)) {
        selected = t;
        break;
      }
    }
    if (!selected) {
      return toolResult({
        rescheduled: false,
        message:
          'No therapist qualified for this service is available at the ' +
          'requested time (existing therapist unavailable and no other ' +
          'qualified therapist free).',
      });
    }
  }

  const updated: Appointment = {
    id: existing.id, // keep same ID
    customer_id: existing.customer_id, // preserve customer
    customer_name: existing.customer_name, // preserve denormalized name
    service_id: existing.service_id, // preserve service
    therapist_id: selected.id,
    start_time: spaFormatISO(start),
    end_time: spaFormatISO(end),
    status: 'confirmed',
  };

  appointments[idx] = updated;
  saveAppointments(appointments);

  return toolResult({
    rescheduled: true,
    appointment: updated,
    service: { id: service.id, name: service.name },
    therapist: { id: selected.id, name: selected.name },
  });
}

/** Project an appointment to a safe, human-readable shape. */
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

// ---------- Helpers ----------

function findService(services: Service[], query: string): Service | undefined {
  const q = query.trim().toLowerCase();
  return services.find(
    (s) => s.id.toLowerCase() === q || s.name.toLowerCase() === q,
  );
}

function mintCustomer(obj: Record<string, unknown>): Customer {
  // Kept for backward compatibility with any internal callers; new
  // booking flow uses buildNewCustomer (which assigns a unique ID).
  const firstName = fieldStr(obj, 'first_name') || fieldStr(obj, 'name');
  const lastName = fieldStr(obj, 'last_name');
  const phone = fieldStr(obj, 'phone');
  if (!firstName || !lastName || !phone) {
    throw new Error('New customer requires `first_name`, `last_name`, and `phone`.');
  }
  return buildNewCustomer(obj, []);
}

/** Build a new Customer from input, assigning a unique UUID-based ID. */
function buildNewCustomer(obj: Record<string, unknown>, existing: Customer[]): Customer {
  const firstName = fieldStr(obj, 'first_name');
  const lastName = fieldStr(obj, 'last_name');
  const phone = fieldStr(obj, 'phone');
  if (!firstName) throw new Error('New customer requires `first_name`.');
  if (!lastName) throw new Error('New customer requires `last_name`.');
  if (!phone) throw new Error('New customer requires `phone`.');
  // Full name stored consistently from first_name + last_name.
  const name = `${firstName} ${lastName}`.trim();
  return {
    id: generateUniqueCustomerId(existing),
    name,
    phone,
    email: fieldStr(obj, 'email'),
    postcode: fieldStr(obj, 'postcode'),
    date_of_birth: fieldStr(obj, 'date_of_birth'),
    notes: fieldStr(obj, 'notes'),
  };
}

/**
 * Generate a unique customer ID using crypto.randomUUID(). Collisions are
 * astronomically unlikely but we check existing IDs for safety. Existing
 * customer IDs (including fixtures, which are now UUIDs) are never
 * overwritten — a retry loop resolves any hypothetical collision.
 */
function generateUniqueCustomerId(existing: Customer[]): string {
  const taken = new Set(existing.map((c) => c.id));
  for (let i = 0; i < 16; i++) {
    const id = randomUUID();
    if (!taken.has(id)) return id;
  }
  return randomUUID();
}

/** Read a string field from a record, trimmed; '' if missing/non-string. */
function fieldStr(obj: Record<string, unknown> | undefined, key: string): string {
  if (!obj) return '';
  const v = obj[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * True if `obj` is a populated customer object (not undefined/null and has
 * at least one own property). Used to treat undefined, null, and {} as
 * "not provided" while still accepting a customer_id alongside an empty
 * customer object. We deliberately do NOT inspect property values here
 * (that validation happens in the new-customer field check); this only
 * decides whether `customer` was supplied at all.
 */
function isPopulatedCustomerObj(obj: unknown): obj is Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return false;
  // Reject {} (no own keys); accept anything with at least one own prop.
  return Object.keys(obj as Record<string, unknown>).length > 0;
}

function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Normalize a phone number for matching so equivalent US formats compare
 * equal, e.g. "+1-415-555-0126", "1-415-555-0126", "(415) 555-0126",
 * "415-555-0126", and "4155550126" all normalize to "4155550126".
 *
 * Rules:
 *   - Strip all non-digits.
 *   - For US numbers, strip a single leading "1" country code so 10-digit
 *     forms and 11-digit "1+area" forms collapse to the same 10 digits.
 *   - Non-US / non-10-or-11-digit inputs keep their full digit string.
 *
 * Matching is on the FULL normalized number only (never partial). Returns
 * the empty string when the input contains no digits.
 */
function normalizePhone(phone: string): string {
  let digits = phone.replace(/\D+/g, '');
  if (!digits) return '';
  // Strip a leading US country code "1" when the remaining number is
  // exactly 10 digits (US NANP form).
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  return digits;
}

function toolResult(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function toolError(message: string) {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

// ---------- REST webhook adapter (Telnyx AI Assistant) ----------
//
// Thin REST wrappers around the SAME handler functions used by the MCP
// tools (handleGetServiceInfo, etc.). The handlers return MCP-shaped
// envelopes ({ content: [{ type: 'text', text }] }, optionally isError).
// `unwrapForRest` converts those to plain JSON for HTTP responses, and
// `sendJson` writes them. No business logic is duplicated: every REST
// endpoint calls exactly one existing handler.

type McpEnvelope = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

function unwrapForRest(mcpResult: McpEnvelope): { status: number; body: unknown } {
  const body = JSON.parse(mcpResult.content[0].text);
  return { status: mcpResult.isError ? 400 : 200, body };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return reject(new Error('Request body must be a JSON object.'));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

const REST_ROUTES: Record<string, (args: Record<string, unknown>) => McpEnvelope> = {
  '/api/get-service-info': handleGetServiceInfo,
  '/api/check-availability': handleCheckAvailability,
  '/api/create-booking': handleCreateBooking,
  '/api/get-appointment': handleGetAppointment,
  '/api/reschedule-booking': handleRescheduleBooking,
};

async function handleRestRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = req.url ?? '';
  const handler = REST_ROUTES[path];
  if (!handler) {
    sendJson(res, 404, { error: `Unknown API endpoint: ${path}` });
    return;
  }
  let args: Record<string, unknown>;
  try {
    args = await readJsonObject(req);
  } catch (e) {
    sendJson(res, 400, { error: e instanceof Error ? e.message : 'Invalid request body.' });
    return;
  }
  try {
    const mcpResult = handler(args);
    const { status, body } = unwrapForRest(mcpResult);
    sendJson(res, status, body);
  } catch (e) {
    // Handler threw (e.g. invalid date/time parse). Return a clear 400.
    sendJson(res, 400, { error: e instanceof Error ? e.message : 'Request failed.' });
  }
}

// ---------- Boot ----------
//
// Select transport: stdio (default) or http (Streamable HTTP on PORT).
// HTTP mode is enabled with the `--http` CLI flag or `MCP_TRANSPORT=http`.
// The 5 tools and their handlers are identical across transports.

const useHttp = process.argv.includes('--http') ||
  process.env.MCP_TRANSPORT?.toLowerCase() === 'http';

if (useHttp) {
  const port = Number(process.env.PORT ?? 3000);

  // Stateful single-session transport (server mints a session id). This is
  // the simplest configuration that the MCP Inspector's "Streamable HTTP"
  // mode supports. No auth is enforced yet.
  const httpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  const httpServer = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/mcp') {
      await httpTransport.handleRequest(req, res);
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/api/')) {
      await handleRestRequest(req, res);
      return;
    }
    // Everything else -> 404 (minimal server; no UI/static routes).
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found. Use POST /mcp (MCP) or POST /api/* (REST).');
  });

  await server.connect(httpTransport);
  httpServer.listen(port, () => {
    console.log(`Spa MCP server (HTTP) listening on http://localhost:${port}/mcp`);
    console.log(`REST webhook endpoints on http://localhost:${port}/api/*`);
  });
} else {
  // Default: stdio transport (local MCP Inspector / CLI clients).
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
