// Telnyx KV helpers for mutable spa data (customers, appointments).
//
// KV keys:
//   'customers'    -> Customer[]
//   'appointments' -> Appointment[]
//
// Initialization: if a key does not exist, seed it from the bundled fixture
// snapshot (the current root data/*.json values). Existing KV data is never
// overwritten once present.

import { env } from '@telnyx/edge-runtime';
import type { Customer, Appointment } from './types.js';

// Bundled fixture snapshot for first-run seeding. Mirrors the current
// root data/customers.json and data/appointments.json.

/** Minimal KV interface used by the helpers (subset of Telnyx KvNamespace). */
export interface SpaKv {
  get<T>(key: string, opts: { type: 'json' }): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
}

// The KV instance used in production is env.SPA_DATA. We resolve it lazily
// on first use so that simply importing this module in a test (where the
// Telnyx runtime/proxy may not be functional) does not trigger a real
// `env.SPA_DATA` access. Tests override the instance via
// `__setKvForTests()` before any read/write.
let _kvExplicit: SpaKv | undefined;

/** Test seam: override the KV instance. Production code never calls this. */
export function __setKvForTests(kv: SpaKv): void {
  _kvExplicit = kv;
}

function kv(): SpaKv {
  if (_kvExplicit) return _kvExplicit;
  // Lazy: only touch env.SPA_DATA on first real read/write in production.
  _kvExplicit = env.SPA_DATA as unknown as SpaKv;
  return _kvExplicit;
}
const SEED_CUSTOMERS: Customer[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Elena Marsh',
    phone: '+1-415-555-0142',
    email: 'elena.marsh@example.com',
    postcode: '94110',
    date_of_birth: '1988-03-12',
    notes: 'Prefers light pressure; allergic to nut oils.',
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'David Okonkwo',
    phone: '+1-415-555-0178',
    email: 'david.okonkwo@example.com',
    postcode: '94114',
    date_of_birth: '1975-11-25',
    notes: 'Recurring lower-back tightness; books deep tissue work.',
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Sofia Reyes',
    phone: '+1-415-555-0199',
    email: 'sofia.reyes@example.com',
    postcode: '94112',
    date_of_birth: '1992-07-04',
    notes: 'Sensitive skin; requests fragrance-free facial products.',
  },
];

const SEED_APPOINTMENTS: Appointment[] = [
  {
    id: 'apt-1001',
    customer_id: '22222222-2222-4222-8222-222222222222',
    customer_name: 'David Okonkwo',
    therapist_id: 'thr-maya',
    service_id: 'svc-deep-tissue-massage',
    start_time: '2026-10-05T10:00:00-07:00',
    end_time: '2026-10-05T11:15:00-07:00',
    status: 'confirmed',
  },
  {
    id: 'apt-1002',
    customer_id: '33333333-3333-4333-8333-333333333333',
    customer_name: 'Sofia Reyes',
    therapist_id: 'thr-priya',
    service_id: 'svc-facial',
    start_time: '2026-10-06T14:00:00-07:00',
    end_time: '2026-10-06T14:50:00-07:00',
    status: 'confirmed',
  },
];

/**
 * Read customers from KV. If the key does not exist, seed it with the
 * bundled fixture snapshot first (one-time initialization), then return
 * the seeded data. Subsequent reads return whatever is in KV.
 */
export async function readCustomers(): Promise<Customer[]> {
  const existing = await kv().get<Customer[]>('customers', { type: 'json' });
  if (existing !== null) return existing;
  await kv().put('customers', JSON.stringify(SEED_CUSTOMERS));
  return SEED_CUSTOMERS;
}

/** Read appointments from KV (same initialization semantics as customers). */
export async function readAppointments(): Promise<Appointment[]> {
  const existing = await kv().get<Appointment[]>('appointments', { type: 'json' });
  if (existing !== null) return existing;
  await kv().put('appointments', JSON.stringify(SEED_APPOINTMENTS));
  return SEED_APPOINTMENTS;
}

/** Write customers to KV (overwrites the key). */
export async function writeCustomers(customers: Customer[]): Promise<void> {
  await kv().put('customers', JSON.stringify(customers));
}

/** Write appointments to KV (overwrites the key). */
export async function writeAppointments(appointments: Appointment[]): Promise<void> {
  await kv().put('appointments', JSON.stringify(appointments));
}

/**
 * Runtime feature flag for the optional after-call survey.
 * Missing flag defaults to false so the existing call flow is unchanged.
 */
export async function readAfterCallSurveyEnabled(): Promise<boolean> {
  const value = await kv().get<boolean>(
    'feature/after_call_survey',
    { type: 'json' },
  );

  return value === true;
}

export async function writeAfterCallSurveyEnabled(
  enabled: boolean,
): Promise<void> {
  await kv().put(
    'feature/after_call_survey',
    JSON.stringify(enabled),
  );
}
