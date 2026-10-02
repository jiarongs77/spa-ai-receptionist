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
      '(UUID) OR `customer` (name + phone or email). If the customer ' +
      'exists, reuses their UUID (no duplicate). If not, creates a new ' +
      'customer. If multiple customers share the name, phone or email ' +
      'disambiguates. `therapist_id` is optional (auto-selects).',
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
            'Customer details. Reuses an existing customer if name+phone ' +
            'or name+email matches; otherwise creates a new customer. ' +
            'Mutually exclusive with `customer_id`.',
          properties: {
            name: { type: 'string', description: 'Required.' },
            phone: { type: 'string', description: 'Required for new customers; disambiguates duplicate names.' },
            email: { type: 'string', description: 'Optional; disambiguates duplicate names.' },
            postcode: { type: 'string', description: 'Optional.' },
            date_of_birth: { type: 'string', description: 'Optional.' },
            notes: { type: 'string', description: 'Optional.' },
          },
          required: ['name'],
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
      'Look up appointments by appointment ID, customer ID, or customer ' +
      'name. Returns the appointment(s) with human-readable service, ' +
      'therapist, and customer-name information. If the customer name ' +
      'matches multiple customers, returns the candidate customers and ' +
      'indicates additional verification is required (does NOT guess). ' +
      'Customer-sensitive fields (phone/email/DOB/notes) are not exposed.',
    inputSchema: {
      type: 'object',
      properties: {
        appointment_id: {
          type: 'string',
          description: 'An appointment ID, e.g. "apt-1001".',
        },
        customer_id: {
          type: 'string',
          description:
            'A customer ID (UUID). Returns all matching appointments for that customer.',
        },
        customer_name: {
          type: 'string',
          description:
            'A customer name (exact match). If unique, returns that ' +
            'customer\'s appointments. If multiple customers share the ' +
            'name, returns the candidates for disambiguation.',
        },
      },
      required: [],
    },
  },
  {
    name: 'reschedule_booking',
    description:
      'Move an existing confirmed appointment to a new start time. ' +
      'Preserves the original service, customer, appointment ID, and ' +
      '"confirmed" status. Re-validates working schedule and conflicts ' +
      'before mutating. Therapist selection: `new_therapist_id` is ' +
      'OPTIONAL. If provided, reschedule only with that therapist after ' +
      'validating service compatibility and availability. If omitted, ' +
      'prefer the existing therapist when they are available at the new ' +
      'time; otherwise automatically select another therapist qualified ' +
      'for the existing service who is available at the new time. If no ' +
      'qualified therapist is available, returns rescheduled:false. ' +
      'Returns the selected therapist in the result.',
    inputSchema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'string', description: 'Existing appointment ID.' },
        new_start_time: {
          type: 'string',
          description:
            'New start time as an ISO string with timezone, e.g. ' +
            '"2026-10-09T13:00:00-07:00".',
        },
        new_therapist_id: {
          type: 'string',
          description:
            'OPTIONAL. If provided, reschedule only with this therapist ' +
            '(must offer the appointment\'s service and be available). If ' +
            'omitted, the server prefers the existing therapist and ' +
            'otherwise auto-selects another qualified available therapist.',
        },
      },
      required: ['appointment_id', 'new_start_time'],
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
  // errors, before any persistence. `name` is always required when a
  // customer object is provided; `phone` is required only if no existing
  // customer matches (enforced later at resolution time).
  if (customerObjProvided) {
    const name = fieldStr(customerObj, 'name');
    if (!name) return toolError('`customer.name` is required.');
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
  //   2. customer object provided -> search by name + (phone OR email):
  //      - exactly one match -> reuse existing UUID (no duplicate)
  //      - multiple matches on name, with phone/email to disambiguate ->
  //        narrow to the one matching phone or email
  //      - multiple matches on name, no disambiguator -> error (never guess)
  //      - no match -> create new customer (requires phone)
  let customer: Customer;
  if (customerId) {
    const customers = loadCustomers();
    const found = customers.find((c) => c.id === customerId);
    if (!found) return toolError(`No customer with id "${customerId}".`);
    customer = found;
  } else {
    const customers = loadCustomers();
    const name = fieldStr(customerObj!, 'name');
    const phone = fieldStr(customerObj!, 'phone');
    const email = fieldStr(customerObj!, 'email');

    // Collect customers sharing this name.
    const byName = customers.filter((c) => c.name === name);

    if (byName.length === 0) {
      // No existing customer with this name -> create new (needs phone).
      if (!phone) {
        return toolError(
          `No existing customer named "${name}". ` +
          '`customer.phone` is required to create a new customer.',
        );
      }
      customer = buildNewCustomer(customerObj!, customers);
      customers.push(customer);
      saveCustomers(customers);
    } else if (byName.length === 1) {
      // Unique name match. If phone/email provided, verify they match the
      // existing record; if they don't, treat as a new customer (requires
      // phone) rather than silently reusing the wrong record.
      const existing = byName[0];
      const phoneOk = !phone || existing.phone === phone;
      const emailOk = !email || existing.email === email;
      if (phoneOk && emailOk) {
        customer = existing; // reuse existing UUID
      } else {
        // Caller provided phone/email that doesn't match the existing
        // record -> a genuinely different person. Create new (needs phone).
        if (!phone) {
          return toolError(
            `Customer "${name}" exists with different contact details. ` +
            '`customer.phone` is required to create a new customer.',
          );
        }
        customer = buildNewCustomer(customerObj!, customers);
        customers.push(customer);
        saveCustomers(customers);
      }
    } else {
      // Multiple customers share this name. Use phone or email to
      // disambiguate; never guess.
      if (!phone && !email) {
        return toolError(
          `Multiple customers named "${name}". Provide ` +
          '`customer.phone` or `customer.email` (or `customer_id`) to disambiguate.',
        );
      }
      const narrowed = byName.filter(
        (c) => (phone && c.phone === phone) || (email && c.email === email),
      );
      if (narrowed.length === 1) {
        customer = narrowed[0];
      } else if (narrowed.length === 0) {
        // No name+phone/email match -> new customer (needs phone).
        if (!phone) {
          return toolError(
            `No existing customer named "${name}" with that phone/email. ` +
            '`customer.phone` is required to create a new customer.',
          );
        }
        customer = buildNewCustomer(customerObj!, customers);
        customers.push(customer);
        saveCustomers(customers);
      } else {
        return toolError(
          `Multiple customers named "${name}" match the provided phone/email. ` +
          'Provide the specific `customer_id` to target one.',
        );
      }
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
  const appointmentId = str(args, 'appointment_id');
  const customerId = str(args, 'customer_id');
  const customerName = str(args, 'customer_name');

  if (!appointmentId && !customerId && !customerName) {
    return toolError(
      'Provide `appointment_id`, `customer_id`, or `customer_name`.',
    );
  }

  const appointments = loadAppointments();
  const services = loadServices();
  const therapists = loadTherapists();
  const customers = loadCustomers();

  // Build lookups once for resolving service/therapist names.
  const serviceById = new Map(services.map((s) => [s.id, s] as const));
  const therapistById = new Map(therapists.map((t) => [t.id, t] as const));

  // --- By appointment_id or customer_id: direct lookup --------------
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

  // --- By customer_name: needs disambiguation -----------------------
  // Find all customers matching the given name (case-sensitive exact
  // match; the AI assistant can normalize casing before calling).
  const nameMatches = customers.filter((c) => c.name === customerName);

  if (nameMatches.length === 0) {
    return toolResult({
      found: false,
      message: `No customer named "${customerName}".`,
    });
  }

  if (nameMatches.length === 1) {
    // Unique customer → return their appointments.
    const cus = nameMatches[0];
    const matches = appointments.filter((a) => a.customer_id === cus.id);
    if (matches.length === 0) {
      return toolResult({
        found: false,
        message: `No appointments found for "${customerName}".`,
      });
    }
    const projected = matches.map((a) =>
      projectAppointment(a, serviceById, therapistById),
    );
    return toolResult({ found: true, count: projected.length, appointments: projected });
  }

  // Multiple customers with the same name → return the candidate
  // customers (ID + name only, no sensitive fields) and indicate that
  // additional verification is required. Do NOT arbitrarily pick one.
  return toolResult({
    found: true,
    ambiguous: true,
    message:
      `Multiple customers named "${customerName}" were found. ` +
      'Provide `customer_id` or verify identity with the customer\'s phone ' +
      'number to select the right one.',
    matching_customers: nameMatches.map((c) => ({
      customer_id: c.id,
      name: c.name,
    })),
    count: nameMatches.length,
  });
}

function handleRescheduleBooking(args: Record<string, unknown>) {
  const appointmentId = str(args, 'appointment_id');
  const newStartStr = str(args, 'new_start_time');
  const newTherapistId = str(args, 'new_therapist_id'); // optional

  if (!appointmentId || !newStartStr) {
    return toolError('`appointment_id` and `new_start_time` are required.');
  }

  const appointments = loadAppointments();
  const idx = appointments.findIndex((a) => a.id === appointmentId);
  if (idx === -1) {
    return toolResult({
      rescheduled: false,
      message: `No appointment with id "${appointmentId}".`,
    });
  }
  const existing = appointments[idx];

  if (existing.status !== 'confirmed') {
    return toolError(
      `Appointment "${appointmentId}" has status "${existing.status}"; only confirmed appointments can be rescheduled.`,
    );
  }

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
  const name = fieldStr(obj, 'name');
  const phone = fieldStr(obj, 'phone');
  if (!name || !phone) {
    throw new Error('New customer requires at least `name` and `phone`.');
  }
  return buildNewCustomer(obj, []);
}

/** Build a new Customer from input, assigning a unique UUID-based ID. */
function buildNewCustomer(obj: Record<string, unknown>, existing: Customer[]): Customer {
  const name = fieldStr(obj, 'name');
  const phone = fieldStr(obj, 'phone');
  if (!name) throw new Error('New customer requires `name`.');
  if (!phone) throw new Error('New customer requires `phone`.');
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
