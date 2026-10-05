// BookingSessionActor: a StatefulActor that owns transient per-caller
// booking session state. One actor instance per caller (keyed by normalized
// phone number). The actor's single-threaded execution model protects
// read-modify-write operations (e.g. incrementing bookingAttemptCount)
// from concurrent lost updates.
//
// Permanent appointment/customer records stay in KV. This actor only holds
// lightweight, transient tracking data.

import { StatefulActor } from '@telnyx/edge-runtime';

export interface BookingSessionState {
  callCount: number;
  bookingAttemptCount: number;
  selectedService: string;
  requestedDate: string;
  selectedTime: string;
  bookingStep: string;
  lastIntent: string;
}

const STORAGE_KEY = 'session';

const DEFAULT_STATE: BookingSessionState = {
  callCount: 0,
  bookingAttemptCount: 0,
  selectedService: '',
  requestedDate: '',
  selectedTime: '',
  bookingStep: 'initial',
  lastIntent: '',
};

/**
 * Read-modify-write: increment bookingAttemptCount. Relies on the actor's
 * single-threaded execution model — no external lock needed.
 */
export class BookingSessionActor extends StatefulActor {
  /** Get the full session state. */
  async getState(): Promise<BookingSessionState> {
    const s = (await this.ctx.storage.get<BookingSessionState>(STORAGE_KEY)) ?? { ...DEFAULT_STATE };
    return s;
  }

  /**
   * Increment `callCount` on every touch. This is the read-modify-write
   * operation that relies on single-threaded execution to avoid lost
   * updates from concurrent calls.
   */
  async touch(): Promise<BookingSessionState> {
    const s = await this.getState();
    s.callCount += 1;
    await this.ctx.storage.put(STORAGE_KEY, s);
    return s;
  }

  /**
   * Increment `bookingAttemptCount` and optionally set booking context
   * fields. This is the primary read-modify-write used by create-booking.
   */
  async recordBookingAttempt(update: {
    selectedService?: string;
    requestedDate?: string;
    selectedTime?: string;
    bookingStep?: string;
    lastIntent?: string;
  }): Promise<BookingSessionState> {
    const s = await this.getState();
    s.bookingAttemptCount += 1;
    s.callCount += 1;
    if (update.selectedService !== undefined) s.selectedService = update.selectedService;
    if (update.requestedDate !== undefined) s.requestedDate = update.requestedDate;
    if (update.selectedTime !== undefined) s.selectedTime = update.selectedTime;
    if (update.bookingStep !== undefined) s.bookingStep = update.bookingStep;
    if (update.lastIntent !== undefined) s.lastIntent = update.lastIntent;
    await this.ctx.storage.put(STORAGE_KEY, s);
    return s;
  }

  /** Overwrite the session state with a patch (no increment). */
  async updateState(patch: Partial<BookingSessionState>): Promise<BookingSessionState> {
    const s = await this.getState();
    const merged = { ...s, ...patch };
    await this.ctx.storage.put(STORAGE_KEY, merged);
    return merged;
  }
}
