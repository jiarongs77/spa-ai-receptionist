import * as http from 'node:http';
import { createHash } from 'node:crypto';
import { env } from '@telnyx/edge-runtime';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleGetServiceInfo, handleCheckAvailability, handleCreateBooking,
  handleGetAppointment, handleRescheduleBooking,
  handleCaptureSurveyRating, handleGetFeatureFlags,
  envelopeToResponse, type ToolEnvelope,
  handleDynamicContext,
} from './handlers.js';

// Observability helpers.
// Hash caller identifiers before logging so raw phone numbers are never emitted.
function callerRef(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;

  return createHash('sha256')
    .update(value.trim())
    .digest('hex')
    .slice(0, 12);
}

function extractCallerRef(args: Record<string, unknown>): string | undefined {
  // Most tools accept phone directly.
  if (typeof args.phone === 'string') {
    return callerRef(args.phone);
  }

  // create-booking accepts new-customer details inside `customer`.
  const customer = args.customer;
  if (
    customer &&
    typeof customer === 'object' &&
    typeof (customer as Record<string, unknown>).phone === 'string'
  ) {
    return callerRef((customer as Record<string, unknown>).phone);
  }

  return undefined;
}

// ---------- REST route table ----------
// Each route maps to one async handler returning a ToolEnvelope. The server
// unwraps the envelope to a plain JSON HTTP response (200 / 400).

const ROUTES: Record<string, (args: Record<string, unknown>) => Promise<ToolEnvelope>> = {
  '/api/get-service-info': handleGetServiceInfo,
  '/api/check-availability': handleCheckAvailability,
  '/api/create-booking': handleCreateBooking,
  '/api/get-appointment': handleGetAppointment,
  '/api/reschedule-booking': handleRescheduleBooking,
  '/api/capture-survey-rating': handleCaptureSurveyRating,
  '/api/get-feature-flags': handleGetFeatureFlags,
};

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

// Structured JSON logging. NEVER log PII (phone, name, email, DOB, notes).
function logApi(
  path: string,
  success: boolean,
  durationMs: number,
  args?: Record<string, unknown>,
): void {
  console.log(JSON.stringify({
    event: 'api_request',
    node: path.replace('/api/', '').replace(/-/g, '_'),
    path,
    ...(args ? { caller_ref: extractCallerRef(args) } : {}),
    outcome: success ? 'success' : 'error',
    success,
    duration_ms: durationMs,
  }));
}

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
  // Preserve /health.
  if (req.url === '/health' || req.url?.startsWith('/health/')) {
    res.writeHead(200);
    res.end();
    return;
  }

  // Preserve /kv-test.
  if (req.url === '/kv-test' && req.method === 'POST') {
    const startedAt = Date.now();
    try {
      await env.SPA_DATA.put(
        'edge-test',
        JSON.stringify({ message: 'Spa House KV is working', timestamp: new Date().toISOString() }),
      );
      const value = await env.SPA_DATA.get<{ message: string; timestamp: string }>('edge-test', { type: 'json' });
      const durationMs = Date.now() - startedAt;
      console.log(JSON.stringify({ event: 'kv_test', success: true, duration_ms: durationMs }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, value, duration_ms: durationMs }));
      return;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const msg = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ event: 'kv_test', success: false, duration_ms: durationMs, error: msg }));
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: msg }));
      return;
    }
  }

  // Dynamic Webhook Variables (/dynamic-context).
  // Telnyx AI Assistant calls this at conversation initialization with the
  // caller's phone. We return dynamic_variables for the assistant; never PII
  // other than customer_first_name. Logs contain no PII.
  if (req.method === 'POST' && req.url === '/dynamic-context') {
    const startedAt = Date.now();
    let payload: Record<string, unknown>;
    try {
      payload = await readJsonObject(req);
    } catch {
      // Invalid/empty body -> safe defaults, logged as success (200).
      const durationMs = Date.now() - startedAt;
      console.log(JSON.stringify({
        event: 'dynamic_context',
        node: 'conversation_initialization',
        outcome: 'invalid_or_empty_payload',
        success: true,
        returning_customer: false,
        has_appointments: false,
        duration_ms: durationMs,
      }));
      sendJson(res, 200, { dynamic_variables: {
        returning_customer: false,
        customer_first_name: '',
        has_appointments: false,
        appointment_count: 0,
        upcoming_service: '',
        upcoming_appointment_time: '',
        suggested_workflow: 'booking',
      }});
      return;
    }

    try {
      const { dynamic_variables } = await handleDynamicContext(payload);
      const durationMs = Date.now() - startedAt;
      console.log(JSON.stringify({
        event: 'dynamic_context',
        node: 'conversation_initialization',
        caller_ref: extractCallerRef(payload),
        outcome: dynamic_variables.returning_customer === true
          ? 'returning_customer'
          : 'new_or_unknown_customer',
        success: true,
        returning_customer: dynamic_variables.returning_customer === true,
        has_appointments: dynamic_variables.has_appointments === true,
        duration_ms: durationMs,
      }));
      sendJson(res, 200, { dynamic_variables });
      return;
    } catch (e) {
      // Never fail the webhook; return safe defaults.
      const durationMs = Date.now() - startedAt;
      console.log(JSON.stringify({
        event: 'dynamic_context',
        node: 'conversation_initialization',
        caller_ref: extractCallerRef(payload),
        outcome: 'fallback_after_error',
        success: false,
        returning_customer: false,
        has_appointments: false,
        duration_ms: durationMs,
      }));
      sendJson(res, 200, { dynamic_variables: {
        returning_customer: false,
        customer_first_name: '',
        has_appointments: false,
        appointment_count: 0,
        upcoming_service: '',
        upcoming_appointment_time: '',
        suggested_workflow: 'booking',
      }});
      return;
    }
  }

  // REST /api/* routes.
  if (req.method === 'POST' && req.url && req.url.startsWith('/api/')) {
    const path = req.url;
    const handler = ROUTES[path];
    const startedAt = Date.now();

    if (!handler) {
      logApi(path, false, Date.now() - startedAt);
      sendJson(res, 404, { error: `Unknown API endpoint: ${path}` });
      return;
    }

    let args: Record<string, unknown>;
    try {
      args = await readJsonObject(req);
    } catch (e) {
      const durationMs = Date.now() - startedAt;
      logApi(path, false, durationMs);
      sendJson(res, 400, { error: e instanceof Error ? e.message : 'Invalid request body.' });
      return;
    }

    try {
      const env = await handler(args);
      const { status, body } = envelopeToResponse(env);
      const durationMs = Date.now() - startedAt;

      // Structured logging. For create-booking, use the discriminator set
      // by the handler so we can distinguish created / idempotent replay /
      // rejected. No PII is logged (status/path/outcome/duration only).
      if (path === '/api/create-booking' && env.bookingOutcome) {
        console.log(JSON.stringify({
          event: env.bookingOutcome,
          node: 'create_booking',
          path,
          caller_ref: extractCallerRef(args),
          outcome: env.bookingOutcome,
          success: env.bookingOutcome !== 'booking_rejected',
          duration_ms: durationMs,
        }));
      } else if (
        path === '/api/get-feature-flags' &&
        typeof env.featureFlagValue === 'boolean'
      ) {
        console.log(JSON.stringify({
          event: 'feature_flag_evaluated',
          node: 'get_feature_flags',
          path,
          after_call_survey_enabled: env.featureFlagValue,
          success: status < 400,
          duration_ms: durationMs,
        }));
      } else {
        logApi(path, status < 400, durationMs, args);
      }

      sendJson(res, status, body);
      return;
    } catch (e) {
      const durationMs = Date.now() - startedAt;
      // Unexpected throw on create-booking -> logged as booking_rejected.
      if (path === '/api/create-booking') {
        console.log(JSON.stringify({
          event: 'booking_rejected',
          path,
          success: false,
          duration_ms: durationMs,
        }));
      } else {
        logApi(path, false, durationMs);
      }
      // Unexpected throw -> 500 with a clean message; PII is never logged.
      sendJson(res, 500, { error: e instanceof Error ? e.message : 'Request failed.' });
      return;
    }
  }

  // Default.
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Spa House Telnyx Edge' }));
});

const port = process.env.PORT || 8080;
server.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
