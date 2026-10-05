import { StatefulActor } from "@telnyx/edge-runtime";

export interface BookingSessionState {
  callCount: number;
  bookingAttemptCount: number;
  selectedService: string;
  selectedTime: string;
  bookingStep: string;
  lastIntent: string;
}

const STORAGE_KEY = "booking-session";

const DEFAULT_STATE: BookingSessionState = {
  callCount: 0,
  bookingAttemptCount: 0,
  selectedService: "",
  selectedTime: "",
  bookingStep: "",
  lastIntent: "",
};

export class SpaBookingSessionActor extends StatefulActor {
  async getState(): Promise<BookingSessionState> {
    return (
      (await this.ctx.storage.get<BookingSessionState>(STORAGE_KEY)) ??
      { ...DEFAULT_STATE }
    );
  }

  async recordBookingAttempt(update: {
    selectedService?: string;
    selectedTime?: string;
    bookingStep?: string;
    lastIntent?: string;
  }): Promise<BookingSessionState> {
    // READ
    const state = await this.getState();

    // MODIFY
    state.callCount += 1;
    state.bookingAttemptCount += 1;

    if (update.selectedService !== undefined) {
      state.selectedService = update.selectedService;
    }

    if (update.selectedTime !== undefined) {
      state.selectedTime = update.selectedTime;
    }

    if (update.bookingStep !== undefined) {
      state.bookingStep = update.bookingStep;
    }

    if (update.lastIntent !== undefined) {
      state.lastIntent = update.lastIntent;
    }

    // WRITE
    await this.ctx.storage.put(STORAGE_KEY, state);

    return state;
  }
}
