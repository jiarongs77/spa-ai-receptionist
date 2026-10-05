import { SpaBookingSessionActor } from "./booking-session-actor.js";

export { SpaBookingSessionActor };

interface Env {
  SPA_ACTOR: {
    idFromName(name: string): {
      recordBookingAttempt(update: {
        selectedService?: string;
        selectedTime?: string;
        bookingStep?: string;
        lastIntent?: string;
      }): Promise<unknown>;
      getState(): Promise<unknown>;
    };
  };
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true });
    }

    if (
      request.method === "POST" &&
      url.pathname === "/record-booking-attempt"
    ) {
      const body = await request.json() as {
        phone?: string;
        selectedService?: string;
        selectedTime?: string;
        bookingStep?: string;
        lastIntent?: string;
      };

      const phone = normalizePhone(body.phone ?? "");

      if (!phone) {
        return Response.json(
          { error: "phone is required" },
          { status: 400 }
        );
      }

      // Same phone = same actor instance.
      const actor = env.SPA_ACTOR.idFromName(phone);

      const state = await actor.recordBookingAttempt({
        selectedService: body.selectedService,
        selectedTime: body.selectedTime,
        bookingStep: body.bookingStep,
        lastIntent: body.lastIntent,
      });

      console.log(JSON.stringify({
        event: "booking_session_actor_updated",
        actor_key: phone,
        state,
      }));

      return Response.json({
        success: true,
        actor_key: phone,
        state,
      });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const phone = normalizePhone(url.searchParams.get("phone") ?? "");

      if (!phone) {
        return Response.json(
          { error: "phone is required" },
          { status: 400 }
        );
      }

      const actor = env.SPA_ACTOR.idFromName(phone);
      const state = await actor.getState();

      return Response.json({
        actor_key: phone,
        state,
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
