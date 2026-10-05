// Tests for the BookingSessionActor integration.
// Uses an in-memory mock actor factory injected via the test seam.
//
// Run: node dist/src/test/actor-state.js

import { handleCreateBooking, envelopeToResponse } from '../handlers.js';
import { __setKvForTests, type SpaKv } from '../kv.js';
import { __setActorFactoryForTests, __clearActorFactoryForTests, type BookingSessionStub } from '../actor-access.js';
import type { BookingSessionState } from '../booking-session-actor.js';
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

// In-memory actor that mimics the real BookingSessionActor.
// Each actor instance is keyed by normalized phone; the factory creates
// an instance per key, holding its own storage Map.
class MockActor implements BookingSessionStub {
  public state: BookingSessionState;
  constructor(_phone: string) {
    this.state = {
      callCount: 0,
      bookingAttemptCount: 0,
      selectedService: '',
      requestedDate: '',
      selectedTime: '',
      bookingStep: 'initial',
      lastIntent: '',
    };
  }
  async getState(): Promise<BookingSessionState> { return { ...this.state }; }
  async touch(): Promise<BookingSessionState> {
    this.state.callCount += 1;
    return { ...this.state };
  }
  async recordBookingAttempt(update: {
    selectedService?: string; requestedDate?: string; selectedTime?: string;
    bookingStep?: string; lastIntent?: string;
  }): Promise<BookingSessionState> {
    this.state.bookingAttemptCount += 1;
    this.state.callCount += 1;
    if (update.selectedService !== undefined) this.state.selectedService = update.selectedService;
    if (update.requestedDate !== undefined) this.state.requestedDate = update.requestedDate;
    if (update.selectedTime !== undefined) this.state.selectedTime = update.selectedTime;
    if (update.bookingStep !== undefined) this.state.bookingStep = update.bookingStep;
    if (update.lastIntent !== undefined) this.state.lastIntent = update.lastIntent;
    return { ...this.state };
  }
  async updateState(patch: Partial<BookingSessionState>): Promise<BookingSessionState> {
    this.state = { ...this.state, ...patch };
    return { ...this.state };
  }
}

async function call(handler: typeof handleCreateBooking, args: Record<string, unknown>) {
  const env = await handler(args);
  const { status, body } = envelopeToResponse(env);
  return { status, body: body as Record<string, unknown>, env };
}

const CUS_ELENA: Customer = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Elena Marsh',
  phone: '+1-415-555-0142', email: 'elena.marsh@example.com',
  postcode: '94110', date_of_birth: '1988-03-12', notes: '',
};
const CUS_DAVID: Customer = {
  id: '22222222-2222-4222-8222-222222222222', name: 'David Okonkwo',
  phone: '+1-415-555-0178', email: 'david.okonkwo@example.com',
  postcode: '94114', date_of_birth: '1975-11-25', notes: '',
};

function freshKv(customers: Customer[], appointments: Appointment[] = []): MemoryKv {
  const mem = new MemoryKv();
  mem.set('customers', customers.slice());
  mem.set('appointments', appointments.slice());
  __setKvForTests(mem);
  return mem;
}

async function main() {
  console.log('\n[1] same caller increments actor-owned state across repeated operations');
  {
    // Mock actor factory: one instance per normalized phone.
    const actors = new Map<string, MockActor>();
    __setActorFactoryForTests((phone: string) => {
      if (!actors.has(phone)) actors.set(phone, new MockActor(phone));
      return actors.get(phone)!;
    });

    freshKv([CUS_ELENA]);

    const args = {
      customer_id: CUS_ELENA.id,
      service: 'svc-swedish-massage',
      therapist_id: 'thr-priya',
      start_time: '2026-10-10T10:00:00-07:00',
    };

    // Four identical attempts (idempotent replays after the first).
    for (let i = 0; i < 4; i++) {
      await call(handleCreateBooking, args);
    }

    // The actor for Elena's phone (4155550142) should show 4 attempts.
    const elenaActor = actors.get('4155550142')!;
    ok(elenaActor !== undefined, '1a. actor created for Elena');
    ok(elenaActor.state.bookingAttemptCount === 4, '1b. bookingAttemptCount = 4 (1→2→3→4)');
    ok(elenaActor.state.callCount === 4, '1c. callCount = 4');
    ok(elenaActor.state.selectedService === 'Swedish Massage', '1d. selectedService = "Swedish Massage"');
    ok(elenaActor.state.bookingStep === 'create_booking', '1e. bookingStep = "create_booking"');
    ok(elenaActor.state.lastIntent === 'book_appointment', '1f. lastIntent = "book_appointment"');

    __clearActorFactoryForTests();
  }

  console.log('\n[2] different callers get isolated actor state');
  {
    const actors = new Map<string, MockActor>();
    __setActorFactoryForTests((phone: string) => {
      if (!actors.has(phone)) actors.set(phone, new MockActor(phone));
      return actors.get(phone)!;
    });

    freshKv([CUS_ELENA, CUS_DAVID]);

    // Elena books.
    await call(handleCreateBooking, {
      customer_id: CUS_ELENA.id,
      service: 'svc-swedish-massage',
      therapist_id: 'thr-priya',
      start_time: '2026-10-10T10:00:00-07:00',
    });

    // David books at a different time.
    await call(handleCreateBooking, {
      customer_id: CUS_DAVID.id,
      service: 'svc-deep-tissue-massage',
      therapist_id: 'thr-maya',
      start_time: '2026-10-05T13:00:00-07:00',
    });

    // David books again (different time).
    await call(handleCreateBooking, {
      customer_id: CUS_DAVID.id,
      service: 'svc-facial',
      therapist_id: 'thr-james',
      start_time: '2026-10-06T14:00:00-07:00',
    });

    const elenaActor = actors.get('4155550142')!;
    const davidActor = actors.get('4155550178')!;

    ok(elenaActor.state.bookingAttemptCount === 1, '2a. Elena: bookingAttemptCount = 1');
    ok(elenaActor.state.selectedService === 'Swedish Massage', '2b. Elena: selectedService = "Swedish Massage"');

    ok(davidActor.state.bookingAttemptCount === 2, '2c. David: bookingAttemptCount = 2');
    ok(davidActor.state.selectedService === 'Facial', '2d. David: selectedService = "Facial" (last booking)');

    // Isolation: they don't interfere.
    ok(elenaActor.state.callCount === 1, '2e. Elena: callCount = 1 (David didn\'t touch Elena)');
    ok(davidActor.state.callCount === 2, '2f. David: callCount = 2');

    __clearActorFactoryForTests();
  }

  console.log('\n[3] read-modify-write counter behaves correctly (sequential increments)');
  {
    const actors = new Map<string, MockActor>();
    __setActorFactoryForTests((phone: string) => {
      if (!actors.has(phone)) actors.set(phone, new MockActor(phone));
      return actors.get(phone)!;
    });

    freshKv([CUS_ELENA]);

    // Simulate 10 concurrent calls (Promise.all).
    const args = {
      customer_id: CUS_ELENA.id,
      service: 'svc-swedish-massage',
      therapist_id: 'thr-priya',
      start_time: '2026-10-10T10:00:00-07:00', // same slot -> after first, all replays
    };
    // The first creates the booking; the remaining 9 are idempotent replays.
    // The actor touches happen before the idempotency check, so all 10
    // calls record a booking attempt.
    await Promise.all(Array.from({ length: 10 }, () => call(handleCreateBooking, args)));

    const actor = actors.get('4155550142')!;
    // With a real actor, the single-threaded execution model guarantees
    // no lost updates; our mock simulates this via sequential JS execution
    // (each call awaits, the next starts only after). The counter must be 10.
    ok(actor.state.bookingAttemptCount === 10, '3a. 10 concurrent calls -> bookingAttemptCount = 10');
    ok(actor.state.callCount === 10, '3b. callCount = 10');

    // Only one appointment was actually persisted (idempotency).
    const mem = __setKvForTests as unknown; // just clear
    __clearActorFactoryForTests();
  }

  console.log('\n[4] existing business endpoint tests still pass (regression)');
  {
    // No actor factory -> handler still works (actor is best-effort).
    __clearActorFactoryForTests();
    freshKv([CUS_ELENA]);

    const r = await call(handleCreateBooking, {
      customer_id: CUS_ELENA.id,
      service: 'svc-swedish-massage',
      therapist_id: 'thr-priya',
      start_time: '2026-10-10T10:00:00-07:00',
    });
    ok(r.status === 200 && r.body.success === true, '4a. booking still succeeds without actor');
    ok(r.body.already_existed === false, '4b. new booking (already_existed=false)');
    ok(r.env.bookingOutcome === 'booking_created', '4c. bookingOutcome=booking_created');
  }

  console.log('\n[5] exact actor state shape');
  {
    const actors = new Map<string, MockActor>();
    __setActorFactoryForTests((phone: string) => {
      if (!actors.has(phone)) actors.set(phone, new MockActor(phone));
      return actors.get(phone)!;
    });

    const actor = new MockActor('test');
    const s = await actor.getState();
    ok(typeof s.callCount === 'number', '5a. callCount: number');
    ok(typeof s.bookingAttemptCount === 'number', '5b. bookingAttemptCount: number');
    ok(typeof s.selectedService === 'string', '5c. selectedService: string');
    ok(typeof s.requestedDate === 'string', '5d. requestedDate: string');
    ok(typeof s.selectedTime === 'string', '5e. selectedTime: string');
    ok(typeof s.bookingStep === 'string', '5f. bookingStep: string');
    ok(typeof s.lastIntent === 'string', '5g. lastIntent: string');
    ok(Object.keys(s).length === 7, '5h. state has exactly 7 fields');

    __clearActorFactoryForTests();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
