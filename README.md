# Spa House AI Receptionist

An AI-powered spa receptionist built with Telnyx AI Assistants, Conversation Workflows, MCP tools, Dynamic Webhook Variables, Telnyx Edge Functions, KV, and Stateful Actors.

## Observability

The production Edge Function uses structured JSON logging to make assistant behavior traceable without logging raw customer PII.

Each relevant request records:

- `event` — operation or booking result
- `node` — logical workflow/backend step
- `caller_ref` — truncated SHA-256 reference derived from the caller identifier; raw phone numbers are not logged
- `outcome` — result of the operation
- `success` — whether the operation succeeded
- `duration_ms` — request latency in milliseconds

For example, a returning caller followed by an idempotent booking retry produces logs such as:

```json
{
  "event": "dynamic_context",
  "node": "conversation_initialization",
  "caller_ref": "b85d4c099d28",
  "outcome": "returning_customer",
  "success": true,
  "returning_customer": true,
  "has_appointments": true,
  "duration_ms": 2359
}


```

A booking retry from the same caller can be correlated through the same `caller_ref`:

```json
{
  "event": "booking_idempotent_replay",
  "node": "create_booking",
  "path": "/api/create-booking",
  "caller_ref": "b85d4c099d28",
  "outcome": "booking_idempotent_replay",
  "success": true,
  "duration_ms": 2527
}
```

The shared `caller_ref` makes it possible to correlate related operations while avoiding raw phone numbers in logs.

### Latency Signal

`duration_ms` provides a meaningful signal beyond operation status. It allows slow dynamic-context, booking, availability, and appointment requests to be identified directly from production logs.

Production logs can be inspected with:

```bash
telnyx-edge logs telnyx-edge --last 50
```

### How I Would Detect a Broken Assistant Within a Minute

If the assistant appeared broken during a call, I would first inspect the live Edge Function logs:

```bash
telnyx-edge logs telnyx-edge --last 50
```

I would look for:

1. `success:false` or error/fallback outcomes.
2. Missing expected workflow/API events after the caller's request.
3. Unexpected booking outcomes such as `booking_rejected`.
4. Abnormally high `duration_ms`, indicating a slow backend/KV operation.
5. Repeated events for the same `caller_ref`, which can reveal retries or duplicate tool invocations.

I would then isolate the failing endpoint with a direct `curl` request. This separates an Edge Function/backend failure from an Assistant or Conversation Workflow routing problem.

### Development Incident: Duplicate Booking Invocation

During development, a phone-call booking test behaved unexpectedly: after a slot had been selected, the assistant reported that the slot was no longer available.

The Edge Function logs showed multiple `/api/create-booking` requests occurring within seconds. The first request successfully created the appointment, while subsequent attempts encountered the now-occupied slot.

The booking handler was changed to make identical booking requests idempotent. After resolving the customer, service, and requested start time, it checks for an existing confirmed appointment matching the same customer, service, and start instant.

An identical retry now returns the existing appointment successfully with:

```json
{
  "success": true,
  "already_existed": true
}
```

and emits the structured event:

```text
booking_idempotent_replay
```

rather than creating a duplicate or incorrectly telling the caller that their newly booked slot is unavailable.

Regression tests cover new bookings, identical retries, repeated retries, real conflicts, different appointment times, and new-customer retries. The current suite passes 93 tests.
