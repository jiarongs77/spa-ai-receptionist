// Tests for /dynamic-context (Dynamic Webhook Variables) and the
// extractCallerPhone helper. Uses an in-memory KV mock injected via the
// kv.ts test seam so the tests run without the Telnyx runtime.
//
// Run: node dist/src/test/dynamic-context.js

import { handleDynamicContext, extractCallerPhone } from '../handlers.js';
import { __setKvForTests, type SpaKv } from '../kv.js';
import type { Customer, Appointment } from '../types.js';

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
}

class MemoryKv implements SpaKv {
  private store = new Map<string, string>();
  async get<T>(_key: string, _opts: { type: 'json' }): Promise<T | null> {
    const v = this.store.get(_key);
    return v === undefined ? null : JSON.parse(v) as T;
  }
  async put(_key: string, value: string): Promise<void> {
    this.store.set(_key, value);
  }
  set(key: string, value: unknown): void {
    this.store.set(key, JSON.stringify(value));
  }
}

const CUS_ELENA: Customer = {
  id: '11111111-1111-4111-8111-111111111111', name: 'Elena Marsh',
  phone: '+1-415-555-0142', email: 'elena.marsh@example.com',
  postcode: '94110', date_of_birth: '1988-03-12',
  notes: 'Prefers light pressure; allergic to nut oils.',
};
const CUS_DAVID: Customer = {
  id: '22222222-2222-4222-8222-222222222222', name: 'David Okonkwo',
  phone: '+1-415-555-0178', email: 'david.okonkwo@example.com',
  postcode: '94114', date_of_birth: '1975-11-25',
  notes: 'Recurring lower-back tightness; books deep tissue work.',
};

async function main() {
  // ---- extractCallerPhone ----
  console.log('\n[1] extractCallerPhone defensive field extraction');
  {
    ok(extractCallerPhone({ caller_phone_number: '+1-415-555-0178' }) === '+1-415-555-0178',
       'top-level caller_phone_number');
    ok(extractCallerPhone({ from_number: '+14155550178' }) === '+14155550178',
       'top-level from_number');
    ok(extractCallerPhone({ from: '+1-415-555-0178' }) === '+1-415-555-0178',
       'top-level from');
    ok(extractCallerPhone({ phone: '+1-415-555-0178' }) === '+1-415-555-0178',
       'top-level phone (parity with /api inputs)');
    ok(extractCallerPhone({ session: { caller_phone_number: '+1-415-555-0178' } }) === '+1-415-555-0178',
       'session.caller_phone_number');
    ok(extractCallerPhone({ session: { from_number: '+1-415-555-0178' } }) === '+1-415-555-0178',
       'session.from_number');
    ok(extractCallerPhone({ data: { from: '+1-415-555-0178' } }) === '+1-415-555-0178',
       'data.from');
    ok(extractCallerPhone({ customer: { phone: '+1-415-555-0178' } }) === '+1-415-555-0178',
       'customer.phone');
    ok(extractCallerPhone({ customer: { phone_number: '+1-415-555-0178' } }) === '+1-415-555-0178',
       'customer.phone_number');
    // Missing -> '' (never throws).
    ok(extractCallerPhone({}) === '', 'empty payload -> empty string');
    ok(extractCallerPhone({ session: {} }) === '', 'empty session -> empty string');
    ok(extractCallerPhone({ foo: 'bar' } as any) === '', 'unknown fields -> empty string');
    // Non-string values are skipped, not coerced.
    ok(extractCallerPhone({ caller_phone_number: 123 as any } as any) === '',
       'non-string value skipped');
  }

  // ---- handleDynamicContext ----
  console.log('\n[2] recognized caller with appointments');
  {
    const mem = new MemoryKv();
    mem.set('customers', [CUS_DAVID, CUS_ELENA]);
    // One past appt (still counts) + one future appt (nearest upcoming).
    const future = new Date(Date.now() + 86_400_000); // +1 day
    const futureISO = future.toISOString();
    const appts: Appointment[] = [
      {
        id: 'apt-9001', customer_id: CUS_DAVID.id, customer_name: CUS_DAVID.name,
        therapist_id: 'thr-maya', service_id: 'svc-deep-tissue-massage',
        start_time: '2020-01-01T10:00:00-08:00', end_time: '2020-01-01T11:15:00-08:00',
        status: 'confirmed',
      },
      {
        id: 'apt-9002', customer_id: CUS_DAVID.id, customer_name: CUS_DAVID.name,
        therapist_id: 'thr-priya', service_id: 'svc-facial',
        start_time: futureISO, end_time: new Date(future.getTime() + 50 * 60_000).toISOString(),
        status: 'confirmed',
      },
    ];
    mem.set('appointments', appts);
    __setKvForTests(mem);

    const { dynamic_variables: dv } = await handleDynamicContext({
      caller_phone_number: '(415) 555-0178', // 10-digit, normalizes to David's
    });
    ok(dv.returning_customer === true, 'returning_customer=true');
    ok(dv.customer_first_name === 'David', 'customer_first_name="David" (derived from full name)');
    ok(dv.has_appointments === true, 'has_appointments=true');
    ok(dv.appointment_count === 2, 'appointment_count=2 (both confirmed)');
    ok(dv.upcoming_service === 'Facial', 'upcoming_service="Facial" (nearest future)');
    ok(typeof dv.upcoming_appointment_time === 'string' && dv.upcoming_appointment_time !== '',
       'upcoming_appointment_time is a non-empty string');
    ok(dv.suggested_workflow === 'client_services', 'suggested_workflow="client_services" (has appts)');
  }

  console.log('\n[3] recognized caller with no appointments (past only cancelled)');
  {
    const mem = new MemoryKv();
    mem.set('customers', [CUS_ELENA]);
    mem.set('appointments', [
      {
        id: 'apt-9101', customer_id: CUS_ELENA.id, customer_name: CUS_ELENA.name,
        therapist_id: 'thr-maya', service_id: 'svc-swedish-massage',
        start_time: '2020-01-01T10:00:00-08:00', end_time: '2020-01-01T11:00:00-08:00',
        status: 'cancelled',
      },
    ]);
    __setKvForTests(mem);
    const { dynamic_variables: dv } = await handleDynamicContext({
      session: { from_number: '+1-415-555-0142' },
    });
    ok(dv.returning_customer === true, 'returning_customer=true (recognized)');
    ok(dv.customer_first_name === 'Elena', 'customer_first_name="Elena"');
    ok(dv.has_appointments === false, 'has_appointments=false (only cancelled)');
    ok(dv.appointment_count === 0, 'appointment_count=0');
    ok(dv.upcoming_service === '', 'upcoming_service="" (no confirmed)');
    ok(dv.upcoming_appointment_time === '', 'upcoming_appointment_time=""');
    ok(dv.suggested_workflow === 'booking', 'suggested_workflow="booking" (no appts)');
  }

  console.log('\n[4] unknown caller (no matching phone)');
  {
    const mem = new MemoryKv();
    mem.set('customers', [CUS_DAVID]);
    mem.set('appointments', []);
    __setKvForTests(mem);
    const { dynamic_variables: dv } = await handleDynamicContext({
      caller_phone_number: '+1-999-999-9999',
    });
    ok(dv.returning_customer === false, 'returning_customer=false');
    ok(dv.customer_first_name === '', 'customer_first_name=""');
    ok(dv.has_appointments === false, 'has_appointments=false');
    ok(dv.appointment_count === 0, 'appointment_count=0');
    ok(dv.upcoming_service === '', 'upcoming_service=""');
    ok(dv.upcoming_appointment_time === '', 'upcoming_appointment_time=""');
    ok(dv.suggested_workflow === 'booking', 'suggested_workflow="booking"');
  }

  console.log('\n[5] missing caller number (payload has no phone fields)');
  {
    const mem = new MemoryKv();
    mem.set('customers', [CUS_DAVID]);
    __setKvForTests(mem);
    const { dynamic_variables: dv } = await handleDynamicContext({
      session: { some_other_field: 'x' },
    });
    ok(dv.returning_customer === false, 'returning_customer=false (no phone)');
    ok(dv.customer_first_name === '', 'customer_first_name=""');
    ok(dv.has_appointments === false, 'has_appointments=false');
    ok(dv.appointment_count === 0, 'appointment_count=0');
    ok(dv.suggested_workflow === 'booking', 'suggested_workflow="booking"');
  }

  console.log('\n[6] response wrapped under top-level "dynamic_variables"');
  {
    const mem = new MemoryKv();
    mem.set('customers', [CUS_DAVID]);
    mem.set('appointments', []);
    __setKvForTests(mem);
    const out = await handleDynamicContext({ caller_phone_number: '+1-415-555-0178' });
    ok(Object.keys(out).length === 1 && Object.prototype.hasOwnProperty.call(out, 'dynamic_variables'),
       'top-level has exactly one key: "dynamic_variables"');
    ok(Object.prototype.hasOwnProperty.call(out.dynamic_variables, 'returning_customer') &&
       Object.prototype.hasOwnProperty.call(out.dynamic_variables, 'customer_first_name') &&
       Object.prototype.hasOwnProperty.call(out.dynamic_variables, 'has_appointments') &&
       Object.prototype.hasOwnProperty.call(out.dynamic_variables, 'appointment_count') &&
       Object.prototype.hasOwnProperty.call(out.dynamic_variables, 'upcoming_service') &&
       Object.prototype.hasOwnProperty.call(out.dynamic_variables, 'upcoming_appointment_time') &&
       Object.prototype.hasOwnProperty.call(out.dynamic_variables, 'suggested_workflow') &&
       Object.prototype.hasOwnProperty.call(out.dynamic_variables, 'after_call_survey_enabled'),
       'dynamic_variables contains all 8 expected fields');
  }

  console.log('\n[7] no PII beyond customer_first_name');
  {
    const mem = new MemoryKv();
    mem.set('customers', [CUS_ELENA]);
    mem.set('appointments', []);
    __setKvForTests(mem);
    const { dynamic_variables: dv } = await handleDynamicContext({
      caller_phone_number: '+1-415-555-0142',
    });
    const keys = Object.keys(dv);
    ok(!keys.includes('customer_id'), 'no customer_id exposed');
    ok(!keys.includes('appointment_id'), 'no appointment_id exposed');
    ok(!keys.includes('phone'), 'no phone field in response');
    ok(!keys.includes('email'), 'no email field');
    ok(!keys.includes('date_of_birth'), 'no DOB field');
    ok(!keys.includes('notes'), 'no notes field');
    const serialized = JSON.stringify(dv);
    ok(serialized.indexOf(CUS_ELENA.email) === -1, 'customer email not present in response body');
    ok(serialized.indexOf(CUS_ELENA.date_of_birth) === -1, 'customer DOB not present in response body');
    ok(serialized.indexOf(CUS_ELENA.phone) === -1, 'customer full phone not present in response body');
    ok(serialized.indexOf('elena.marsh') === -1, 'customer full name not present (only first_name)');
    ok(serialized.indexOf('Elena') !== -1 && serialized.indexOf('Marsh') === -1,
       'customer_first_name present, last name redacted');
  }

  console.log('\n[8] duplicate phone -> treated as unknown (no PII leak)');
  {
    const mem = new MemoryKv();
    const sharedPhone = '+1-415-555-0300';
    mem.set('customers', [
      { ...CUS_ELENA, phone: sharedPhone, name: 'Alice One' },
      { ...CUS_DAVID, phone: sharedPhone, name: 'Bob Two' },
    ]);
    mem.set('appointments', []);
    __setKvForTests(mem);
    const { dynamic_variables: dv } = await handleDynamicContext({
      caller_phone_number: sharedPhone,
    });
    ok(dv.returning_customer === false,
       'duplicate phone -> unknown (does not expose which customer)');
    ok(dv.customer_first_name === '', 'no first name leaked for ambiguous match');
  }

  console.log('\n[9] KV-based after-call survey feature flag');
  {
    const mem = new MemoryKv();
    mem.set('customers', [CUS_ELENA]);
    mem.set('appointments', []);
    __setKvForTests(mem);

    // Missing flag must fail closed so the existing workflow is unchanged.
    let { dynamic_variables: dv } = await handleDynamicContext({
      caller_phone_number: '+1-415-555-0142',
    });
    ok(dv.after_call_survey_enabled === false,
      'missing feature flag defaults to false');

    // Enable the feature entirely through KV.
    mem.set('feature/after_call_survey', true);
    ({ dynamic_variables: dv } = await handleDynamicContext({
      caller_phone_number: '+1-415-555-0142',
    }));
    ok(dv.after_call_survey_enabled === true,
      'KV flag true enables after-call survey');

    // Disable it again without changing application code.
    mem.set('feature/after_call_survey', false);
    ({ dynamic_variables: dv } = await handleDynamicContext({
      caller_phone_number: '+1-415-555-0142',
    }));
    ok(dv.after_call_survey_enabled === false,
      'KV flag false disables after-call survey');

    // Demonstrate a runtime false -> true toggle for the same caller.
    mem.set('feature/after_call_survey', true);
    ({ dynamic_variables: dv } = await handleDynamicContext({
      caller_phone_number: '+1-415-555-0142',
    }));
    ok(dv.after_call_survey_enabled === true,
      'same caller observes runtime KV toggle without redeployment');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
