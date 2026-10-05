# Spa AI Receptionist

A production-style voice receptionist built with the Telnyx AI Assistant platform and Telnyx Edge Compute.

The assistant handles real spa workflows over the phone: answering service questions, checking availability, creating bookings, retrieving existing appointments, and rescheduling appointments. The backend uses Telnyx Edge Functions, KV, Stateful Actors, dynamic webhook variables, structured observability, and a custom MCP integration.

---

## What It Does

A caller can naturally ask to:

- Learn about services, pricing, duration, or therapists
- Check appointment availability
- Book a new appointment
- Retrieve existing appointments
- Reschedule an appointment
- Complete an optional after-call satisfaction survey

The assistant uses workflow nodes and tool results as the source of truth rather than inventing business information.

---

# Architecture

```text
                         ┌───────────────────────┐
                         │   Caller / Telnyx #   │
                         └───────────┬───────────┘
                                     │
                                     ▼
                         ┌───────────────────────┐
                         │  Telnyx AI Assistant  │
                         │ Conversation Workflow │
                         └───────────┬───────────┘
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                          │
          ▼                          ▼                          ▼
   General Inquiry               Booking               Client Services
   Prompt Node                  Prompt Node              Prompt Node
          │                          │                          │
          └──────────────────────────┼──────────────────────────┘
                                     │
                                     ▼
                           Telnyx Edge Function
                                     │
                 ┌───────────────────┼────────────────────┐
                 │                   │                    │
                 ▼                   ▼                    ▼
             Telnyx KV         Stateful Actor        MCP / Tools
          business/config      per-caller state     business actions
                 │                   │                    │
                 └───────────────────┼────────────────────┘
                                     │
                                     ▼
                           Structured logs + latency
```

---

# 1. Conversation Workflow

The assistant uses a multi-node Telnyx Conversation Workflow rather than a single system prompt.

### Main workflow

```text
Greeting / Start
      │
      ▼
Identify Intent
      │
      ├── General Inquiry
      │      └── service information / pricing / availability
      │
      ├── Booking
      │      └── availability → customer details → create booking
      │
      └── Client Services
             └── retrieve appointment → reschedule
```

The workflow combines:

- **Prompt nodes** for LLM-driven interaction
- **Speak nodes** for deterministic scripted messages
- **LLM conditional edges** for conversational intent and completion
- **Variable-comparison edges** for deterministic routing such as feature-flag-controlled survey behavior

The assistant is connected to a Telnyx phone number and supports multi-turn voice conversations.

---

# 2. Business Tools / MCP Integration

The assistant has access to business operations used during calls.

Core tools include:

```text
get_service_info
check_availability
create_booking
get_appointment
reschedule_booking
```

These provide structured business data rather than relying on the LLM to infer prices, appointments, or availability.

Example:

```text
Caller:
"How much is a facial?"

Assistant
   ↓
get_service_info
   ↓
Edge / business data
   ↓
$95, 50 minutes
```

The MCP server exposes meaningful business operations to the assistant and is designed to be publicly reachable for Telnyx tool invocation.

---

# 3. Dynamic Webhook Variables

A Telnyx Edge Function provides dynamic conversation context at runtime.

Example dynamic variables include:

```text
returning_customer
customer_first_name
has_appointments
appointment_count
upcoming_service
upcoming_appointment_time
suggested_workflow
```

This allows the assistant to personalize conversations without placing customer data directly into prompts.

Example:

```text
Incoming phone number
        ↓
Dynamic webhook
        ↓
KV lookup
        ↓
returning_customer = true
customer_first_name = "Sofia"
has_appointments = true
        ↓
Assistant receives contextual routing data
```

Dynamic context intentionally exposes only the minimum information needed by the workflow.

---

# 4. Telnyx Edge Compute

The backend is deployed entirely on **Telnyx Edge Compute**.

### Public Edge Function

```text
https://telnyx-edge-8a749e5c-8.telnyxcompute.com
```

Deployment:

```bash
telnyx-edge ship
```

Representative endpoints:

```text
POST /dynamic-context

POST /api/get-service-info
POST /api/check-availability
POST /api/create-booking
POST /api/get-appointment
POST /api/reschedule-booking

POST /api/get-feature-flags
POST /api/capture-survey-rating
```

---

## Telnyx KV

Telnyx KV stores lightweight business/configuration data including:

- Customers
- Appointments
- Service data
- Runtime feature configuration

A KV-backed feature flag controls whether the optional survey is enabled:

```text
feature/after_call_survey
```

This allows behavior to be changed at runtime without redeploying the application.

```text
KV flag = false
→ normal workflow ends

KV flag = true
→ route to after-call survey
```

This is intentionally stored in KV because a Boolean configuration value does not require per-entity synchronization.

---

# 5. Stateful Actor

The project uses a `BookingSessionActor` for **transient per-caller booking state**.

One normalized caller phone number maps to one actor instance.

The actor tracks:

```text
callCount
bookingAttemptCount
selectedService
requestedDate
selectedTime
bookingStep
lastIntent
```

Permanent customer and appointment records remain in KV. The actor is used only for state where single-threaded per-entity execution is valuable.

### Why an Actor?

A booking attempt performs a true read-modify-write operation:

```ts
const state = await this.getState();

state.bookingAttemptCount += 1;
state.callCount += 1;

await this.ctx.storage.put("state", state);
```

Without serialization, concurrent requests could read the same value and overwrite one another.

The Stateful Actor guarantees operations for one caller are processed serially, removing the need for an external lock.

### Verified behavior

The actor tests demonstrate:

```text
same caller:
1 → 2 → 3 → 4

different caller:
independent state

10 concurrent operations:
bookingAttemptCount = 10
```

This deliberately follows the **right primitive** principle:

```text
KV
→ shared lookup/configuration data

Stateful Actor
→ concurrency-sensitive per-caller state
```

---

# 6. Feature-Flagged After-Call Survey

The survey is controlled through a KV-backed runtime feature flag.

```text
Main request complete
        ↓
get_feature_flags
        ↓
after_call_survey_enabled
        ↓
variable comparison
      /       \
   true       false
    │           │
    ▼           ▼
 Survey         End
```

If enabled, the assistant asks the caller to rate the experience from 1–5.

The rating is captured through:

```text
POST /api/capture-survey-rating
```

This demonstrates deterministic workflow routing using dynamic variables rather than relying exclusively on LLM decisions.

---

# 7. Observability

The Edge Function emits structured JSON logs for business operations.

Example:

```json
{
  "event": "booking_created",
  "node": "create_booking",
  "path": "/api/create-booking",
  "caller_ref": "62f50c8ca1c5",
  "outcome": "booking_created",
  "success": true,
  "duration_ms": 6164
}
```

Actor state can also be observed during development:

```json
{
  "event": "booking_session_actor_updated",
  "actor_key": "4155550142",
  "call_count": 3,
  "booking_attempt_count": 3,
  "selected_service": "Swedish Massage",
  "booking_step": "create_booking"
}
```

### Signals beyond logs

Every request records latency:

```text
duration_ms
```

This makes it possible to distinguish:

```text
tool/API latency
vs.
workflow / LLM routing latency
```

For example, during development I observed a workflow transition taking roughly 25–30 seconds while the feature-flag webhook itself completed in approximately one second. Structured logs made it possible to isolate the delay to the workflow transition rather than the backend API.

### How I would know the assistant is broken within one minute

First:

```bash
telnyx-edge logs telnyx-edge --tail
```

I would check:

1. Did the expected tool execute?
2. Was the HTTP request successful?
3. What was `duration_ms`?
4. Was the failure in the Edge Function, KV/Actor access, or assistant workflow?
5. Did the expected next workflow node execute?

Because tool invocation, outcome, caller reference, path, and latency are structured, a failed call can be reconstructed quickly.

---

# 8. Development with Telnyx Inference + OpenCode

Development uses the `@telnyx/opencode` plugin and Telnyx-hosted inference.

Install:

```bash
opencode plugin @telnyx/opencode
```

Authenticate:

```bash
opencode auth login --provider telnyx --method "API Key"
```

Available Telnyx-hosted models can be viewed with:

```text
/telnyx
```

Example:

```bash
opencode run \
  --model 'telnyx/moonshotai/Kimi-K3' \
  'Say hello in one sentence.'
```

Telnyx inference was used as the coding-assistant model while developing and testing the solution.

---

# Setup

## Install dependencies

```bash
cd telnyx-edge
npm install
```

## Build

```bash
npm run build
```

## Run tests

```bash
npm test
```

Current test suite:

```text
147 passed
0 failed
```

Coverage includes:

```text
58 dynamic-context tests
39 create-booking / idempotency tests
25 Stateful Actor tests
25 survey-rating tests
```

The actor suite can also be run directly:

```bash
node dist/src/test/actor-state.js
```

---

# Deploy

Authenticate/configure the Telnyx Edge CLI, then:

```bash
telnyx-edge ship
```

Tail production logs:

```bash
telnyx-edge logs telnyx-edge --tail
```

---

# Example API Test

### Service information

```bash
curl -s -X POST \
  "https://telnyx-edge-8a749e5c-8.telnyxcompute.com/api/get-service-info" \
  -H "Content-Type: application/json" \
  -d '{"service":"Facial"}' | python3 -m json.tool
```

Example response:

```json
{
  "found": true,
  "id": "svc-facial",
  "name": "Facial",
  "description": "Customized cleansing, exfoliation, and hydration for the face.",
  "duration_minutes": 50,
  "price_usd": 95
}
```

---

# Key Engineering Decisions

### KV vs. Stateful Actors

I intentionally use different primitives for different consistency requirements.

**KV** is appropriate for:

```text
feature flags
services
customer lookup data
appointment persistence
```

**Stateful Actors** are appropriate for:

```text
per-caller transient booking state
serialized counters
read-modify-write operations
```

This avoids using a Stateful Actor where a simple KV value is sufficient while still taking advantage of actor serialization where concurrency matters.

### Deterministic vs. LLM Routing

The workflow also distinguishes between:

```text
LLM edge
→ nuanced conversational decisions

Variable comparison edge
→ deterministic system state
```

For example, conversational completion can require an LLM decision, while a Boolean feature flag should use deterministic routing.

---

# Stretch Goals

Implemented:

- **Variable-comparison edges** for deterministic routing
- **KV-backed feature flags** that change behavior without redeployment
- **Custom dynamic webhook variables** that personalize and influence workflow behavior
- **Request correlation / structured observability** across assistant-triggered Edge operations
- **Stateful per-caller session tracking**
- **Latency instrumentation** for distinguishing workflow latency from backend latency

---

# Public Demo

### AI Receptionist

```text
Phone:
+1 (213) 664-3473
```

### Edge Function

```text
https://telnyx-edge-8a749e5c-8.telnyxcompute.com
```

### MCP Server

```text
https://spa-ai-receptionist.up.railway.app/mcp
```

Suggested demo prompts:

```text
"How much is a facial?"

"Do you have any facial appointments available on October 6?"

"I'd like to book a facial."

"Can you check my existing appointments?"

"I need to reschedule my appointment."
```

---

# Summary

This project demonstrates an end-to-end Telnyx-native voice application rather than a single LLM prompt:

```text
Conversation Workflow
+ Voice
+ MCP tools
+ Dynamic Webhook Variables
+ Edge Functions
+ KV
+ Stateful Actors
+ Feature Flags
+ Structured Observability
+ Telnyx Inference
```

The architecture deliberately separates conversational reasoning, deterministic workflow control, shared KV data, and concurrency-sensitive per-caller state so each Telnyx primitive is used for the problem it is best suited to solve.
