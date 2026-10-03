// Tests for /api/create-booking idempotency behavior.
// Uses an in-memory KV mock injected via the kv.ts test seam.
//
// Run: node dist/src/test/create-booking-idempotency.js

import { handleCreateBooking, envelopeToResponse } from '../handlers.js';
import { __setKvForTests, type SpaKv } from '../kv.js';
import type { Customer, Appointment } from '../types.js';

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
}

class MemoryKv implements SpaKv {
  private store = new Map<string, string>();
  async get<T>(key: string, _opts: { type: 'json' }): Promise<T | null> {
    const v = this.store.get(key);
    return v === undefined ? null : JSON.parse(v) as T;
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  set(key: string, value: unknown): void {
    this.store.set(key, JSON.stringify(value));
  }
}

const CUS_ELENA: Customer = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Elena Marsh',
  phone: '+1-415-555-0142', email: 'elena.marsh@example.com',
  postcode: '94110', date_of_birth: '1988-03-12',
  notes: 'Prefers light pressure.',
};
const CUS_DAVID: Customer = {
  id: '22222222-2222-4222-8222-222222222222', name: 'David Okonkwo',
  phone: '+1-415-555-0178', email: 'david.okonkwo@example.com',
  postcode: '94114', date_of_birth: '1975-11-25',
  notes: 'Recurring lower-back tightness.',
};

async function getAppts(mem: MemoryKv): Promise<Appointment[]> {
  return (await mem.get('appointments', { type: 'json' })) as Appointment[] ?? [];
}
async function getCusts(mem: MemoryKv): Promise<Customer[]> {
  return (await mem.get('customers', { type: 'json' })) as Customer[] ?? [];
}

function freshKv(customers: Customer[], appointments: Appointment[] = []): MemoryKv {
  const mem = new MemoryKv();
  mem.set('customers', customers.slice());
  mem.set('appointments', appointments.slice());
  __setKvForTests(mem);
  return mem;
}

async function call(handler: typeof handleCreateBooking, args: Record<string, unknown>) {
  const env = await handler(args);
  const { status, body } = envelopeToResponse(env);
  return { status, body: body as Record<string, unknown>, env };
}

async function main() {
  console.log('\n[1] first booking creates exactly one appointment');
  {
    const mem = freshKv([CUS_ELENA]);
    // Elena books a Swedish massage on a Saturday (Priya works Sat 09-17).
    const args = {
      customer_id: CUS_ELENA.id,
      service: 'svc-swedish-massage',
      therapist_id: 'thr-priya',
      start_time: '2026-10-10T10:00:00-07:00', // Saturday
    };
    const { status, body, env } = await call(handleCreateBooking, args);
    ok(status === 200, '1a. 200 OK');
    ok(body.success === true, '1b. success=true');
    ok(body.already_existed === false, '1c. already_existed=false (new booking)');
    ok(env.bookingOutcome === 'booking_created', '1d. bookingOutcome=booking_created');
    ok(typeof body.appointment_id === 'string' && body.appointment_id.startsWith('apt-'),
       '1e. appointment_id returned');
    // Exactly one appointment persisted.
    const appts = await getAppts(mem);
    ok(appts.length === 1, '1f. exactly one appointment in KV');
    ok(appts[0].customer_id === CUS_ELENA.id, '1g. appt belongs to Elena');
  }

  console.log('\n[2] identical retry returns success, no duplicate');
  {
    const mem = freshKv([CUS_ELENA]);
    const args = {
      customer_id: CUS_ELENA.id,
      service: 'svc-swedish-massage',
      therapist_id: 'thr-priya',
      start_time: '2026-10-10T10:00:00-07:00',
    };
    // First booking.
    const first = await call(handleCreateBooking, args);
    ok(first.body.success === true && first.body.already_existed === false,
       '2a. first booking created');
    // Identical retry.
    const retry = await call(handleCreateBooking, args);
    ok(retry.status === 200, '2b. retry returns 200 (not rejected)');
    ok(retry.body.success === true, '2c. retry returns success=true');
    ok(retry.body.already_existed === true, '2d. retry already_existed=true');
    ok(retry.env.bookingOutcome === 'booking_idempotent_replay',
       '2e. retry bookingOutcome=booking_idempotent_replay');
    ok(retry.body.appointment_id === first.body.appointment_id,
       '2f. retry returns the same appointment_id');
    // Still only one appointment.
    const appts = await getAppts(mem);
    ok(appts.length === 1, '2g. still exactly one appointment (no duplicate)');
  }

  console.log('\n[3] three identical retries still result in exactly one appointment');
  {
    const mem = freshKv([CUS_ELENA]);
    const args = {
      customer_id: CUS_ELENA.id,
      service: 'svc-swedish-massage',
      therapist_id: 'thr-priya',
      start_time: '2026-10-10T10:00:00-07:00',
    };
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await call(handleCreateBooking, args);
      ok(r.body.success === true, `3a.${i}. attempt ${i + 1} succeeds`);
      ids.push(r.body.appointment_id as string);
    }
    // All 4 attempts returned the same appointment_id.
    ok(new Set(ids).size === 1, '3b. all 4 attempts return the same appointment_id');
    // Only the first should have already_existed=false; rest true.
    // (we'll count via KV)
    const appts = await getAppts(mem);
    ok(appts.length === 1, '3c. exactly one appointment after 4 attempts');
  }

  console.log('\n[4] conflicting booking from another customer remains rejected');
  {
    // Seed an existing confirmed appointment for Elena at Sat 10:00 (Priya).
    const existing: Appointment = {
      id: 'apt-9999', customer_id: CUS_ELENA.id, customer_name: CUS_ELENA.name,
      therapist_id: 'thr-priya', service_id: 'svc-swedish-massage',
      start_time: '2026-10-10T10:00:00-07:00', end_time: '2026-10-10T11:00:00-07:00',
      status: 'confirmed',
    };
    const mem = freshKv([CUS_ELENA, CUS_DAVID], [existing]);

    // David tries to book the SAME slot/service/therapist -> conflict.
    const r = await call(handleCreateBooking, {
      customer_id: CUS_DAVID.id,
      service: 'svc-swedish-massage',
      therapist_id: 'thr-priya',
      start_time: '2026-10-10T10:00:00-07:00',
    });
    ok(r.status === 200, '4a. status 200 (structured success:false response)');
    ok(r.body.success === false, '4b. success=false (rejected)');
    ok(/not available/.test(JSON.stringify(r.body.message)),
       '4c. message says not available');
    ok(r.env.bookingOutcome === 'booking_rejected',
       '4d. bookingOutcome=booking_rejected');
    // No new appointment persisted.
    const appts = await getAppts(mem);
    ok(appts.length === 1, '4e. no new appointment created');
  }

  console.log('\n[5] same customer requesting a different time is NOT an idempotent replay');
  {
    const mem = freshKv([CUS_ELENA]);
    const slot1 = {
      customer_id: CUS_ELENA.id,
      service: 'svc-swedish-massage',
      therapist_id: 'thr-priya',
      start_time: '2026-10-10T10:00:00-07:00',
    };
    // First booking.
    const first = await call(handleCreateBooking, slot1);
    ok(first.body.already_existed === false && first.env.bookingOutcome === 'booking_created',
       '5a. first booking created');

    // Same customer, different time -> genuinely new (different slot).
    const slot2 = {
      customer_id: CUS_ELENA.id,
      service: 'svc-swedish-massage',
      therapist_id: 'thr-priya',
      start_time: '2026-10-10T11:00:00-07:00', // different time
    };
    const second = await call(handleCreateBooking, slot2);
    ok(second.body.success === true, '5b. second different-time booking succeeds');
    ok(second.body.already_existed === false, '5c. already_existed=false (genuine new)');
    ok(second.env.bookingOutcome === 'booking_created', '5d. bookingOutcome=booking_created');
    ok(second.body.appointment_id !== first.body.appointment_id,
       '5e. different appointment_id (not a replay)');
    // Two appointments now.
    const appts = await getAppts(mem);
    ok(appts.length === 2, '5f. two appointments persisted');
  }

  console.log('\n[6] new customer creation is also idempotent on retry');
  {
    const mem = freshKv([]); // no customers yet
    const args = {
      customer: {
        first_name: 'Emily', last_name: 'Chen', phone: '+1-310-555-0126',
      },
      service: 'svc-swedish-massage',
      therapist_id: 'thr-priya',
      start_time: '2026-10-10T10:00:00-07:00',
    };
    // First booking creates the customer.
    const first = await call(handleCreateBooking, args);
    ok(first.body.success === true && first.body.already_existed === false,
       '6a. first booking creates new customer');
    const custs1 = await getCusts(mem);
    ok(custs1.length === 1, '6b. one customer created');

    // Identical retry -> idempotent replay.
    const retry = await call(handleCreateBooking, args);
    ok(retry.body.success === true, '6c. retry succeeds (idempotent)');
    ok(retry.body.already_existed === true, '6d. retry already_existed=true');
    ok(retry.env.bookingOutcome === 'booking_idempotent_replay',
       '6e. retry bookingOutcome=booking_idempotent_replay');
    // No duplicate customer, no duplicate appointment.
    const custs2 = await getCusts(mem);
    ok(custs2.length === 1, '6f. still one customer (no duplicate)');
    const appts = await getAppts(mem);
    ok(appts.length === 1, '6g. still one appointment (no duplicate)');
    ok(retry.body.customer_id === first.body.customer_id,
       '6h. retry references the same customer_id');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
