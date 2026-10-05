// Actor accessor: resolves the BookingSessionActor namespace from env.
// Includes a test seam so tests can inject an in-memory mock actor without
// touching the Telnyx runtime.

import { env } from '@telnyx/edge-runtime';
import type { ActorNamespace } from '@telnyx/edge-runtime';
import type { BookingSessionActor, BookingSessionState } from './booking-session-actor.js';

// Minimal interface the handler needs from the actor stub.
export interface BookingSessionStub {
  getState(): Promise<BookingSessionState>;
  touch(): Promise<BookingSessionState>;
  recordBookingAttempt(update: {
    selectedService?: string;
    requestedDate?: string;
    selectedTime?: string;
    bookingStep?: string;
    lastIntent?: string;
  }): Promise<BookingSessionState>;
  updateState(patch: Partial<BookingSessionState>): Promise<BookingSessionState>;
}

// In production, env.SPA_ACTOR is the ActorNamespace. In tests, we inject
// a factory via __setActorFactoryForTests().
let _actorFactoryExplicit: ((phone: string) => BookingSessionStub) | undefined;

/** Test seam: override the actor factory. Production code never calls this. */
export function __setActorFactoryForTests(factory: (phone: string) => BookingSessionStub): void {
  _actorFactoryExplicit = factory;
}

/** Clear the test seam (for test isolation). */
export function __clearActorFactoryForTests(): void {
  _actorFactoryExplicit = undefined;
}

/**
 * Get the BookingSessionActor stub for the given normalized phone number.
 * The same phone always addresses the same actor instance.
 */
export function getBookingSessionActor(phone: string): BookingSessionStub {
  if (_actorFactoryExplicit) return _actorFactoryExplicit(phone);

  // Lazy: only touch env.SPA_ACTOR on first real use in production.
  const ns = env.SPA_ACTOR as unknown as ActorNamespace<BookingSessionActor>;
  const stub = ns.idFromName(phone);
  return stub as unknown as BookingSessionStub;
}

/**
 * Normalize a phone number for use as an actor key. Reuses the same
 * normalization logic from handlers.ts.
 */
export function normalizePhoneForKey(phone: string): string {
  let digits = phone.replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1);
  }
  return digits;
}
