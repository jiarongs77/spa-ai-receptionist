// Lightweight test harness: invokes the MCP server's tool logic over stdio
// using the real MCP client/server, then prints results. Ke dependency-free
// aside from the MCP SDK.
//
// Run: npm test

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  loadAppointments, saveAppointments, loadCustomers, saveCustomers,
  parseSpaInput, parseSpaDate, parseSpaDateTime, spaFormatISO, spaDayKey, spaAddMinutes, spaHoursMinutes,
} from '../types.js';

// Fixture customer IDs (now UUIDs). These are valid UUIDv4-format strings
// used as stable fixture IDs so tests can reference them by constant.
const CUS_ELENA = '11111111-1111-4111-8111-111111111111';
const CUS_DAVID = '22222222-2222-4222-8222-222222222222';
const CUS_SOFIA = '33333333-3333-4333-8333-333333333333';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(here, '..', 'index.js');

let pass = 0, fail = 0;

function ok(cond: boolean, label: string) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}`); }
}

async function main() {
  // Snapshot the appointments and customers on disk before tests run so we
  // can restore them after, keeping the mock data stable across repeated
  // test runs. New-customer bookings mutate customers.json, so it must be
  // snapshotted and restored just like appointments.json.
  const apptSnapshot = loadAppointments();
  const custSnapshot = loadCustomers();
  const transport = new StdioClientTransport({
    command: 'node',
    args: [serverPath],
  });
  const client = new Client({ name: 'test-client', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);

  console.log('\n[1] get_service_info');
  {
    const r = await client.callTool({ name: 'get_service_info', arguments: { service: 'Swedish Massage' } });
    const text = (r.content as Array<{ type: string; text: string }>)[0].text;
    const data = JSON.parse(text);
    ok(data.found === true && data.id === 'svc-swedish-massage', 'find by name -> svc-swedish-massage');
    ok(data.duration_minutes === 60 && data.price_usd === 110, 'duration/price correct');
  }
  {
    const r = await client.callTool({ name: 'get_service_info', arguments: { service: 'svc-facial' } });
    const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
    ok(data.found === true && data.name === 'Facial', 'find by ID -> Facial');
  }
  {
    const r = await client.callTool({ name: 'get_service_info', arguments: { service: 'Hot Stone' } });
    const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
    ok(data.found === false, 'unknown service -> found:false');
  }

  console.log('\n[2] check_availability');
  {
    // 2026-10-05 is a Monday. Maya works Mon 09-17 and has an existing
    // deep-tissue appt 10:00-11:15. James does not work Mondays.
    const r = await client.callTool({
      name: 'check_availability',
      arguments: { service: 'svc-deep-tissue-massage', date: '2026-10-05' },
    });
    const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
    ok(data.available === true, 'availability found for deep tissue on Mon');
    const mayaSlots = data.slots.filter((s: any) => s.therapist_id === 'thr-maya');
    ok(mayaSlots.length > 0, 'Maya has available slots');
    // 10:00 and 10:30 starts should be excluded (conflict 10:00-11:15).
    // Slot times are emitted in spa time (with offset), so match the wall clock.
    ok(!mayaSlots.some((s: any) => /T10:00:00/.test(s.start_time)),
       '10:00 slot excluded (conflict)');
  }
  {
    // Sunday: nobody works.
    const r = await client.callTool({
      name: 'check_availability',
      arguments: { service: 'Swedish Massage', date: '2026-10-04' },
    });
    const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
    ok(data.available === false && data.slots.length === 0, 'Sunday -> no slots');
  }
  {
    // Preferred therapist who doesn't offer the service.
    const r = await client.callTool({
      name: 'check_availability',
      arguments: { service: 'svc-facial', date: '2026-10-06', therapist_id: 'thr-maya' },
    });
    const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
    ok(data.available === false && /does not offer/.test(data.message), 'Maya != facial -> not offered');
  }

  console.log('\n[3] create_booking');
  {
    // Capture appointments before so we can detect the new one and clean up.
    const beforeRes = await client.callTool({
      name: 'check_availability',
      arguments: { service: 'svc-swedish-massage', date: '2026-10-07' },
    });
    const beforeData = JSON.parse((beforeRes.content as Array<{ type: string; text: string }>)[0].text);
    ok(beforeData.available === true, 'Wed 2026-10-07 has swedish availability');

    // Book the first available Swedish slot on 2026-10-07.
    const slot = beforeData.slots[0];
    const r = await client.callTool({
      name: 'create_booking',
      arguments: {
        customer_id: CUS_ELENA,
        service: 'svc-swedish-massage',
        therapist_id: slot.therapist_id,
        start_time: slot.start_time,
      },
    });
    const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
    ok(data.success === true, 'booking succeeded');
    ok(typeof data.appointment_id === 'string' && data.appointment_id.startsWith('apt-'),
       'new appointment has stable ID');
    ok(data.status === 'confirmed', 'status is confirmed');
    ok(data.customer_id === CUS_ELENA, 'customer_id echoed for existing customer');

    // Re-booking the same slot must fail.
    const r2 = await client.callTool({
      name: 'create_booking',
      arguments: {
        customer_id: CUS_DAVID,
        service: 'svc-swedish-massage',
        therapist_id: slot.therapist_id,
        start_time: slot.start_time,
      },
    });
    const data2 = JSON.parse((r2.content as Array<{ type: string; text: string }>)[0].text);
    ok(data2.success === false, 'double-booking rejected');

    // Therapist mismatch.
    const r3 = await client.callTool({
      name: 'create_booking',
      arguments: {
        customer_id: CUS_ELENA,
        service: 'svc-facial',
        therapist_id: 'thr-maya',
        start_time: '2026-10-07T11:00:00-07:00',
      },
    });
    const data3 = JSON.parse((r3.content as Array<{ type: string; text: string }>)[0].text);
    ok(/error/i.test(JSON.stringify(data3)) && /does not offer/.test(JSON.stringify(data3)),
       'therapist/service mismatch rejected');
  }

  // Reset both fixtures to the snapshot so the new tests start from the
  // clean baseline (blocks above appended a test booking/customer). The
  // final restore at the bottom keeps the whole suite idempotent.
  saveAppointments(apptSnapshot);
  saveCustomers(custSnapshot);

  console.log('\n[4] get_appointment');
  {
    // By appointment ID.
    const r = await client.callTool({
      name: 'get_appointment',
      arguments: { appointment_id: 'apt-1001' },
    });
    const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
    ok(data.found === true && data.count === 1, 'apt-1001 found by ID');
    const a = data.appointments[0];
    ok(a.id === 'apt-1001', 'returns the requested ID');
    ok(a.service_name === 'Deep Tissue Massage', 'resolves service name');
    ok(a.therapist_name === 'Maya Lindqvist', 'resolves therapist name');
    ok(a.customer_id === CUS_DAVID, 'includes customer_id (lookup/booking context)');
    // Must NOT expose sensitive customer info.
    ok(
      !Object.prototype.hasOwnProperty.call(a, 'phone') &&
      !Object.prototype.hasOwnProperty.call(a, 'email') &&
      !Object.prototype.hasOwnProperty.call(a, 'date_of_birth') &&
      !Object.prototype.hasOwnProperty.call(a, 'notes'),
      'no sensitive customer fields in result',
    );
  }
  {
    // By customer ID.
    const r = await client.callTool({
      name: 'get_appointment',
      arguments: { customer_id: CUS_SOFIA },
    });
    const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
    ok(data.found === true && data.count === 1, 'Sofia has 1 appointment');
    ok(data.appointments[0].id === 'apt-1002', 'returns apt-1002');
  }
  {
    // Unknown appointment ID.
    const r = await client.callTool({
      name: 'get_appointment',
      arguments: { appointment_id: 'apt-9999' },
    });
    const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
    ok(data.found === false, 'unknown appointment ID -> found:false');
  }
  {
    // Unknown customer ID.
    const r = await client.callTool({
      name: 'get_appointment',
      arguments: { customer_id: '00000000-0000-4000-8000-000000000000' },
    });
    const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
    ok(data.found === false, 'unknown customer -> found:false');
  }
  {
    // Missing both keys -> clear error.
    const r = await client.callTool({ name: 'get_appointment', arguments: {} });
    ok((r as any).isError === true, 'missing both lookup keys -> error');
  }

  console.log('\n[5] reschedule_booking');
  {
    // Reset again so reschedule tests start cleanly from the baseline.
    saveAppointments(apptSnapshot);
    saveCustomers(custSnapshot);

    // Set up a confirmed booking on Wed 2026-10-07 (Maya, Swedish 09:00)
    // so we can test conflict logic against it.
    const avRes = await client.callTool({
      name: 'check_availability',
      arguments: { service: 'svc-swedish-massage', date: '2026-10-07' },
    });
    const avData = JSON.parse((avRes.content as Array<{ type: string; text: string }>)[0].text);
    ok(avData.available === true, 'Wed 2026-10-07 swedish availability for setup');
    const setupSlot = avData.slots.find((s: any) => s.therapist_id === 'thr-maya');
    ok(!!setupSlot, 'Maya has a Wed slot for setup');
    const bookRes = await client.callTool({
      name: 'create_booking',
      arguments: {
        customer_id: CUS_ELENA,
        service: 'svc-swedish-massage',
        therapist_id: 'thr-maya',
        start_time: setupSlot.start_time,
      },
    });
    const bookData = JSON.parse((bookRes.content as Array<{ type: string; text: string }>)[0].text);
    ok(bookData.success === true, 'setup booking created');
    const setupId = bookData.appointment_id;
    const setupStart = bookData.start_time; // 09:00 Wed

    // 1. Successful reschedule: apt-1001 (Maya, deep-tissue, Mon 10:00) -> Mon 13:00.
    const okRes = await client.callTool({
      name: 'reschedule_booking',
      arguments: {
        appointment_id: 'apt-1001',
        new_start_time: '2026-10-05T13:00:00-07:00',
      },
    });
    const okData = JSON.parse((okRes.content as Array<{ type: string; text: string }>)[0].text);
    ok(okData.rescheduled === true, 'reschedule apt-1001 to Mon 13:00 succeeds');
    ok(okData.appointment.id === 'apt-1001', 'same appointment ID preserved');
    ok(okData.appointment.customer_id === CUS_DAVID, 'customer preserved');
    ok(okData.appointment.service_id === 'svc-deep-tissue-massage', 'service preserved');
    ok(okData.appointment.therapist_id === 'thr-maya', 'therapist preserved (no new requested)');
    ok(okData.appointment.status === 'confirmed', 'status still confirmed');
    ok(
      okData.appointment.start_time.startsWith('2026-10-05T13:00') &&
      okData.appointment.end_time.startsWith('2026-10-05T14:15'),
      'start/end recalculated in spa time; 13:00 + 75 min = 14:15 (same wall clock, -07:00 offset)',
    );

    // 2. Conflict: reschedule apt-1001 (Maya) to overlap the setup booking.
    //    setupStart ≈ 2026-10-07T09:00 PDT. 09:30 deep-tissue = 09:30-10:45 overlaps 09:00-10:00.
    const conflictStart = new Date(new Date(setupStart).getTime() + 30 * 60_000)
      .toISOString();
    const conflictRes = await client.callTool({
      name: 'reschedule_booking',
      arguments: {
        appointment_id: 'apt-1001',
        new_start_time: conflictStart,
      },
    });
    const conflictData = JSON.parse((conflictRes.content as Array<{ type: string; text: string }>)[0].text);
    ok(conflictData.rescheduled === false, 'reschedule to conflicting slot rejected');

    // 3. Outside working hours: apt-1001 (Maya works Mon 09-17) -> Mon 18:30.
    const oohRes = await client.callTool({
      name: 'reschedule_booking',
      arguments: {
        appointment_id: 'apt-1001',
        new_start_time: '2026-10-05T18:30:00-07:00',
      },
    });
    const oohData = JSON.parse((oohRes.content as Array<{ type: string; text: string }>)[0].text);
    ok(oohData.rescheduled === false, 'reschedule outside working hours rejected');

    // 4. New therapist who doesn't offer the service: apt-1001 is deep-tissue,
    //    Priya does not offer deep-tissue.
    const mismatchRes = await client.callTool({
      name: 'reschedule_booking',
      arguments: {
        appointment_id: 'apt-1001',
        new_start_time: '2026-10-06T11:00:00-07:00',
        new_therapist_id: 'thr-priya',
      },
    });
    const mismatchData = JSON.parse((mismatchRes.content as Array<{ type: string; text: string }>)[0].text);
    ok(
      (mismatchRes as any).isError === true && /does not offer/.test(JSON.stringify(mismatchData)),
      'new therapist lacking service -> error',
    );

    // 5. New therapist who DOES offer the service: apt-1001 (deep-tissue) -> James on Tue.
    const swapRes = await client.callTool({
      name: 'reschedule_booking',
      arguments: {
        appointment_id: 'apt-1001',
        new_start_time: '2026-10-06T11:00:00-07:00',
        new_therapist_id: 'thr-james',
      },
    });
    const swapData = JSON.parse((swapRes.content as Array<{ type: string; text: string }>)[0].text);
    ok(swapData.rescheduled === true, 'swap to James (offers deep-tissue) succeeds');
    ok(swapData.appointment.therapist_id === 'thr-james', 'therapist updated to James');
    ok(swapData.appointment.id === 'apt-1001', 'ID still preserved after therapist swap');
    ok(swapData.appointment.service_id === 'svc-deep-tissue-massage', 'service preserved after swap');

    // 6. Unknown appointment id -> not-found result.
    const nfRes = await client.callTool({
      name: 'reschedule_booking',
      arguments: {
        appointment_id: 'apt-9999',
        new_start_time: '2026-10-08T10:00:00-07:00',
      },
    });
    const nfData = JSON.parse((nfRes.content as Array<{ type: string; text: string }>)[0].text);
    ok(nfData.rescheduled === false, 'unknown appointment id -> rescheduled:false');

    // 7. Self-exclusion sanity check: reschedule the setup booking to its own
    //    current start time should succeed (it excludes itself).
    const selfRes = await client.callTool({
      name: 'reschedule_booking',
      arguments: {
        appointment_id: setupId,
        new_start_time: setupStart,
      },
    });
    const selfData = JSON.parse((selfRes.content as Array<{ type: string; text: string }>)[0].text);
    ok(selfData.rescheduled === true, 'reschedule to own current time succeeds (self-excluded)');
  }

  console.log('\n[6] create_booking: new-customer path');
  {
    // Reset both fixtures so this block starts cleanly from baseline.
    saveAppointments(apptSnapshot);
    saveCustomers(custSnapshot);

    const avRes = await client.callTool({
      name: 'check_availability',
      arguments: { service: 'svc-swedish-massage', date: '2026-10-07' },
    });
    const avData = JSON.parse((avRes.content as Array<{ type: string; text: string }>)[0].text);
    ok(avData.available === true, 'Wed 2026-10-07 swedish availability for new-customer tests');
    const mayaSlot = avData.slots.find((s: any) => s.therapist_id === 'thr-maya');
    ok(!!mayaSlot, 'Maya has a Wed slot for new-customer tests');

    const fixtureCustomerCount = loadCustomers().length;
    const fixtureAppointmentCount = loadAppointments().length;

    // A. Existing customer booking still succeeds (regression).
    {
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-07T09:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, 'A. existing customer booking succeeds');
      ok(data.customer_id === CUS_ELENA, 'A. existing customer echoes customer_id');
      ok((r as any).isError !== true, 'A. not an error response');
    }

    // B/C/D/E. New customer booking succeeds; unique ID; persisted; appointment references it.
    let newCustomerId: string;
    let newAppointmentId: string;
    {
      // Reset appointments so the Wed 09:00 slot used above is free again
      // for the new-customer booking. Customers unchanged (existing path).
      saveAppointments(apptSnapshot);

      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: {
            name: 'Alex Chen',
            phone: '+1-310-555-0123',
            email: 'alex.chen@example.com',
          },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-07T09:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, 'B. new customer booking succeeds');
      ok(typeof data.customer_id === 'string' && UUID_RE.test(data.customer_id),
         'C. generated customer_id is a valid UUID');
      newCustomerId = data.customer_id;
      ok(![CUS_ELENA, CUS_DAVID, CUS_SOFIA].includes(newCustomerId),
         'C. new ID differs from fixture IDs');

      newAppointmentId = data.appointment_id;
      ok(data.status === 'confirmed', 'B. status confirmed');
      ok(data.service.name === 'Swedish Massage' && data.therapist.name === 'Maya Lindqvist',
         'B. service/therapist display names returned');

      // D. New customer is actually persisted.
      const persisted = loadCustomers().find((c) => c.id === newCustomerId);
      ok(!!persisted, 'D. new customer persisted to customers.json');
      ok(Boolean(persisted && persisted.name === 'Alex Chen'), 'D. persisted name correct');
      ok(Boolean(persisted && persisted.phone === '+1-310-555-0123'), 'D. persisted phone correct');

      // E. Appointment references the generated customer ID.
      const appt = loadAppointments().find((a) => a.id === newAppointmentId);
      ok(Boolean(!!appt && appt && appt.customer_id === newCustomerId),
         'E. appointment references the generated customer_id');
    }

    // F. Unknown existing customer ID is rejected.
    {
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: '00000000-0000-4000-8000-000000000000',
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-07T15:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok((r as any).isError === true && /No customer with id/.test(JSON.stringify(data)),
         'F. unknown customer_id -> structured error');
    }

    // G. New customer without name is rejected.
    {
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { phone: '+1-310-555-0999' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-07T15:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok((r as any).isError === true && /name.*required/i.test(JSON.stringify(data)),
         'G. new customer without name rejected');
    }

    // H. New customer without phone is rejected (no existing match -> needs phone).
    {
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Pat NoPhone' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-07T15:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok((r as any).isError === true && /phone.*required/i.test(JSON.stringify(data)),
         'H. new customer without phone rejected');
    }

    // I. Supplying neither customer_id nor customer is rejected.
    {
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-07T15:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok((r as any).isError === true && /exactly one/.test(JSON.stringify(data)),
         'I. neither customer_id nor customer rejected');
    }

    // J. Supplying both customer_id and customer is rejected.
    {
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          customer: { name: 'Alex Chen', phone: '+1-310-555-0123' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-07T15:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok((r as any).isError === true && /not both/.test(JSON.stringify(data)),
         'J. both customer_id and customer rejected');
    }

    // K. Unavailable/conflicting appointment rejected for a new customer.
    {
      // The new-customer booking at 09:00 Wed (Alex Chen) is the only
      // confirmed appointment right now (we reset to apptSnapshot then
      // made that one booking). Try another new customer at the same slot.
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Sam Smith', phone: '+1-415-555-0888' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-07T09:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === false, 'K. conflicting slot rejected for new customer');
    }

    // L. Failed appointment creation does not leave an orphan customer.
    {
      const beforeCount = loadCustomers().length;
      // Trigger a failure via therapist mismatch (therapist doesn't offer service).
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Orphan Check', phone: '+1-415-555-0777' },
          service: 'svc-facial', // Maya does not offer facial
          therapist_id: 'thr-maya',
          start_time: '2026-10-08T10:00:00-07:00',
        },
      });
      ok((r as any).isError === true, 'L. therapist-mismatch booking fails');
      const afterCount = loadCustomers().length;
      ok(afterCount === beforeCount, 'L. no orphan customer left after failed booking');

      // Also trigger a failure via conflict (Maya Swedish at the Alex Chen
      // 09:00 slot) and ensure no new customer is added.
      const beforeCount2 = loadCustomers().length;
      const r2 = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Orphan Two', phone: '+1-415-555-0666' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-07T09:00:00-07:00',
        },
      });
      const data2 = JSON.parse((r2.content as Array<{ type: string; text: string }>)[0].text);
      ok(data2.success === false, 'L. conflict booking fails');
      const afterCount2 = loadCustomers().length;
      ok(afterCount2 === beforeCount2, 'L. no orphan customer left after conflict booking');
    }

    // M. Existing fixture customers remain unchanged.
    {
      const current = loadCustomers();
      ok(current.length === fixtureCustomerCount + 1,
         'M. exactly one new customer (Alex Chen) was added during this block');
      const elena = current.find((c) => c.id === CUS_ELENA);
      ok(Boolean(elena && elena.name === 'Elena Marsh' && elena.phone === '+1-415-555-0142'),
         'M. Elena fixture unchanged');
      const david = current.find((c) => c.id === CUS_DAVID);
      ok(Boolean(david && david.name === 'David Okonkwo' && david.phone === '+1-415-555-0178'),
         'M. David fixture unchanged');
      const sofia = current.find((c) => c.id === CUS_SOFIA);
      ok(Boolean(sofia && sofia.name === 'Sofia Reyes' && sofia.phone === '+1-415-555-0199'),
         'M. Sofia fixture unchanged');
    }

    // N. Existing double-booking and therapist/service validation still work.
    {
      // Reset appointments to baseline so we can re-test double-booking
      // against a fresh existing-customer booking.
      saveAppointments(apptSnapshot);
      const bookRes = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-07T10:00:00-07:00',
        },
      });
      const bookData = JSON.parse((bookRes.content as Array<{ type: string; text: string }>)[0].text);
      ok(bookData.success === true, 'N. setup existing-customer booking succeeds');

      // Double-booking the same slot.
      const dupRes = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_DAVID,
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-07T10:00:00-07:00',
        },
      });
      const dupData = JSON.parse((dupRes.content as Array<{ type: string; text: string }>)[0].text);
      ok(dupData.success === false, 'N. double-booking still rejected');

      // Therapist/service mismatch via new-customer path too.
      const misRes = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Mismatch Mary', phone: '+1-415-555-0555' },
          service: 'svc-facial',
          therapist_id: 'thr-maya', // Maya != facial
          start_time: '2026-10-08T11:00:00-07:00',
        },
      });
      const misData = JSON.parse((misRes.content as Array<{ type: string; text: string }>)[0].text);
      ok((misRes as any).isError === true && /does not offer/.test(JSON.stringify(misData)),
         'N. therapist/service mismatch rejected for new-customer path');
    }
  }

  console.log('\n[7] reschedule_booking: optional therapist / auto-select');
  {
    // apt-1001 baseline: Maya, deep-tissue, Mon 2026-10-05 10:00-11:15.
    // Qualified deep-tissue therapists: Maya, James.
    // Tue 2026-10-06: Maya 09-17, James 10-18. Sun 2026-10-04: nobody works.

    // 1. Existing therapist available (no new_therapist_id) -> stays with Maya.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'reschedule_booking',
        arguments: {
          appointment_id: 'apt-1001',
          new_start_time: '2026-10-06T12:00:00-07:00', // Tue 12:00, Maya free
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.rescheduled === true, '1. existing therapist available -> rescheduled');
      ok(data.therapist.id === 'thr-maya', '1. preferred existing therapist (Maya) selected');
      ok(data.appointment.id === 'apt-1001', '1. same appointment ID');
      ok(data.appointment.service_id === 'svc-deep-tissue-massage', '1. service preserved');
      ok(data.appointment.customer_id === CUS_DAVID, '1. customer preserved');
    }

    // 2. Existing therapist unavailable, another qualified therapist available.
    //    Block Maya at Tue 13:00 with a setup booking, then reschedule apt-1001
    //    to Tue 13:00 -> Maya busy, James free -> auto-select James.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const setup = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T13:00:00-07:00', // Maya Tue 13:00-14:00
        },
      });
      const setupData = JSON.parse((setup.content as Array<{ type: string; text: string }>)[0].text);
      ok(setupData.success === true, '2. setup: Maya blocked at Tue 13:00');

      const r = await client.callTool({
        name: 'reschedule_booking',
        arguments: {
          appointment_id: 'apt-1001',
          new_start_time: '2026-10-06T13:00:00-07:00', // deep-tissue 13:00-14:15
          // no new_therapist_id -> auto-select
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.rescheduled === true, '2. existing unavailable, other qualified available -> rescheduled');
      ok(data.therapist.id === 'thr-james',
         '2. auto-selected James (qualified + available), not the busy Maya');
      ok(data.appointment.therapist_id === 'thr-james', '2. appointment therapist updated to James');
      ok(data.appointment.id === 'apt-1001', '2. same appointment ID');
      ok(data.appointment.service_id === 'svc-deep-tissue-massage',
         '2. service never changed (deep-tissue)');
      ok(data.appointment.customer_id === CUS_DAVID, '2. customer never changed');
    }

    // 3. Explicit therapist requested -> overrides existing-therapist preference.
    //    apt-1001's existing therapist is Maya. Both Maya and James are free at
    //    Tue 15:00. Explicitly request James -> must get James (not Maya).
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'reschedule_booking',
        arguments: {
          appointment_id: 'apt-1001',
          new_start_time: '2026-10-06T15:00:00-07:00',
          new_therapist_id: 'thr-james',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.rescheduled === true, '3. explicit therapist requested -> rescheduled');
      ok(data.therapist.id === 'thr-james',
         '3. explicit James selected even though Maya (existing) is also free');
      ok(data.appointment.id === 'apt-1001', '3. same appointment ID');
      ok(data.appointment.service_id === 'svc-deep-tissue-massage', '3. service preserved');
    }

    // 3b. Explicit therapist who doesn't offer the service -> error.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'reschedule_booking',
        arguments: {
          appointment_id: 'apt-1001',
          new_start_time: '2026-10-06T15:00:00-07:00',
          new_therapist_id: 'thr-priya', // Priya does not offer deep-tissue
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok((r as any).isError === true && /does not offer/.test(JSON.stringify(data)),
         '3b. explicit therapist lacking service -> error');
    }

    // 3c. Explicit therapist not available at requested time -> rescheduled:false.
    //     Block James at Tue 14:00, then explicitly request James for Tue 14:00.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const setup = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          service: 'svc-facial',
          therapist_id: 'thr-james',
          start_time: '2026-10-06T14:00:00-07:00', // James Tue 14:00-14:50
        },
      });
      const setupData = JSON.parse((setup.content as Array<{ type: string; text: string }>)[0].text);
      ok(setupData.success === true, '3c. setup: James blocked at Tue 14:00');

      const r = await client.callTool({
        name: 'reschedule_booking',
        arguments: {
          appointment_id: 'apt-1001',
          new_start_time: '2026-10-06T14:00:00-07:00', // deep-tissue 14:00-15:15 overlaps James 14:00-14:50
          new_therapist_id: 'thr-james',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.rescheduled === false,
         '3c. explicit therapist not available -> rescheduled:false (not an error)');
      ok(/not available/.test(JSON.stringify(data)),
         '3c. clear "not available" message for explicit unavailable therapist');
    }

    // 4. Nobody available (no new_therapist_id, no qualified therapist free).
    //    Sunday: nobody works -> no qualified therapist available.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'reschedule_booking',
        arguments: {
          appointment_id: 'apt-1001',
          new_start_time: '2026-10-04T11:00:00-07:00', // Sunday
          // no new_therapist_id
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.rescheduled === false, '4. nobody available -> rescheduled:false');
      ok(
        /No therapist qualified/.test(JSON.stringify(data)) || /available/.test(JSON.stringify(data)),
        '4. clear message that no qualified therapist is available',
      );
    }

    // 4b. Nobody available, but with an explicit therapist that doesn't work that day.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'reschedule_booking',
        arguments: {
          appointment_id: 'apt-1001',
          new_start_time: '2026-10-04T11:00:00-07:00', // Sunday
          new_therapist_id: 'thr-maya', // Maya doesn't work Sundays
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.rescheduled === false, '4b. explicit therapist outside working hours -> rescheduled:false');
    }
  }

  console.log('\n[8] create_booking: optional therapist_id / auto-select');
  {
    // Deep-tissue on Tue 2026-10-06: Maya (09-17) and James (10-18) both
    // qualified. Swedish on Tue: Maya and Priya. Sunday 2026-10-04: nobody
    // works.

    // 1. No therapist specified -> auto-select a qualified available therapist.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          service: 'svc-deep-tissue-massage',
          start_time: '2026-10-06T12:00:00-07:00', // Tue 12:00
          // no therapist_id
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '1. no therapist specified -> booking succeeds');
      ok(typeof data.therapist.id === 'string' && /^thr-/.test(data.therapist.id),
         '1. selected therapist returned with a thr- id');
      ok(['thr-maya', 'thr-james'].includes(data.therapist.id),
         '1. selected therapist is qualified for deep-tissue (Maya or James)');
      // Deterministic: file order -> Maya comes before James, and Maya is free.
      ok(data.therapist.id === 'thr-maya',
         '1. deterministic auto-select picks first qualified+available (Maya)');
      ok(data.appointment_id && data.status === 'confirmed',
         '1. appointment_id + confirmed status returned');
    }

    // 2. Specific therapist requested -> uses that therapist when available.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          service: 'svc-deep-tissue-massage',
          therapist_id: 'thr-james',
          start_time: '2026-10-06T12:00:00-07:00', // Tue 12:00, James free
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '2. specific therapist requested -> booking succeeds');
      ok(data.therapist.id === 'thr-james',
         '2. uses the explicitly requested therapist (James), not auto-picked Maya');
    }

    // 3. Requested therapist unavailable -> success:false with clear message.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      // Block James at Tue 14:00-14:50 with a facial booking.
      const setup = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          service: 'svc-facial',
          therapist_id: 'thr-james',
          start_time: '2026-10-06T14:00:00-07:00',
        },
      });
      const setupData = JSON.parse((setup.content as Array<{ type: string; text: string }>)[0].text);
      ok(setupData.success === true, '3. setup: James blocked at Tue 14:00');

      // Explicitly request James for a deep-tissue overlapping 14:00-15:15.
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_DAVID,
          service: 'svc-deep-tissue-massage',
          therapist_id: 'thr-james',
          start_time: '2026-10-06T14:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === false,
         '3. requested therapist unavailable -> success:false (NOT an error)');
      ok((r as any).isError !== true,
         '3. unavailable therapist is a structured success:false, not isError');
      ok(/not available/.test(JSON.stringify(data)),
         '3. clear "not available" message');

      // No appointment should have been created for David at that slot.
      // Stored times use spa offset; match the wall-clock 14:00 the booking
      // attempted, not the UTC instant.
      const appts = loadAppointments();
      const conflict = appts.find(
        (a) => a.customer_id === CUS_DAVID && a.start_time.includes('2026-10-06T14:00'),
      );
      ok(!conflict, '3. no appointment persisted for the failed booking');
    }

    // 4. No qualified therapist available (no therapist_id) -> success:false.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          service: 'svc-deep-tissue-massage',
          start_time: '2026-10-04T11:00:00-07:00', // Sunday, nobody works
          // no therapist_id
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === false, '4. no qualified therapist available -> success:false');
      ok(
        /No therapist qualified/.test(JSON.stringify(data)) || /available/.test(JSON.stringify(data)),
        '4. clear message that no qualified therapist is available',
      );
      ok((r as any).isError !== true, '4. structured success:false, not isError');
    }

    // 5. Sanity: new-customer path also supports omitted therapist_id.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Auto Select', phone: '+1-415-555-0444' },
          service: 'svc-swedish-massage',
          start_time: '2026-10-06T12:00:00-07:00', // Tue 12:00
          // no therapist_id
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '5. new-customer auto-select succeeds');
      ok(['thr-maya', 'thr-priya'].includes(data.therapist.id),
         '5. selected therapist qualified for swedish (Maya or Priya)');
      ok(UUID_RE.test(data.customer_id) && ![CUS_ELENA, CUS_DAVID, CUS_SOFIA].includes(data.customer_id),
         '5. new customer ID generated');
    }
  }

  console.log('\n[9] create_booking: customer input "meaningful" semantics');
  {
    // Treat undefined, null, "", and {} as NOT provided.
    // Valid: customer_id + empty {} -> uses the id (existing customer).
    // Reject: both genuinely populated, or both genuinely absent.

    // A. customer_id + empty customer {} is valid (uses the id).
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          customer: {},
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00', // Tue 12:00, Maya free
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, 'A. customer_id + empty {} -> success (uses the id)');
      ok(data.customer_id === CUS_ELENA, 'A. booking used the existing customer_id');
      ok((r as any).isError !== true, 'A. not an error');
    }

    // B. customer_id with customer: null is valid (uses the id).
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          customer: null,
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, 'B. customer_id + customer:null -> success');
      ok(data.customer_id === CUS_ELENA, 'B. booking used the existing customer_id');
    }

    // C. customer_id "" (empty string) + populated customer -> uses customer obj.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: '',
          customer: { name: 'Empty Id', phone: '+1-415-555-0666' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, 'C. empty customer_id + populated customer -> success (new customer)');
      ok(UUID_RE.test(data.customer_id) && ![CUS_ELENA, CUS_DAVID, CUS_SOFIA].includes(data.customer_id),
         'C. new customer created from populated customer object');
    }

    // D. Both genuinely populated -> rejected.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          customer: { name: 'Alex Chen', phone: '+1-310-555-0123' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok((r as any).isError === true && /not both/.test(JSON.stringify(data)),
         'D. both populated -> rejected with "not both"');
    }

    // E. Both absent (no customer_id, no customer) -> rejected.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok((r as any).isError === true && /exactly one/.test(JSON.stringify(data)),
         'E. both absent -> rejected with "exactly one"');
    }

    // F. customer: {} alone (no customer_id) -> rejected as absent new-customer
    //    input (no name/phone). Validates that {} is treated as not-provided
    //    and falls through to the "absent" branch.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: {},
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok((r as any).isError === true && /exactly one/.test(JSON.stringify(data)),
         'F. customer:{} alone -> rejected as "exactly one" ({} is not provided)');
    }
  }

  console.log('\n[10] datetime handling (America/Los_Angeles)');
  {
    // 1. parseSpaDateTime: naive "2026-10-06T17:30" -> 2026-10-07T00:30:00.000Z
    //    (17:30 PDT is 00:30 UTC the next day).
    {
      const d = parseSpaDateTime('2026-10-06T17:30');
      ok(d.toISOString() === '2026-10-07T00:30:00.000Z',
         '1. naive 17:30 parses to 2026-10-07T00:30:00.000Z (PDT)');
    }

    // 2. spaFormatISO of that instant round-trips back to 17:30-07:00.
    {
      const d = parseSpaDateTime('2026-10-06T17:30');
      const out = spaFormatISO(d);
      ok(out === '2026-10-06T17:30:00.000-07:00',
         '2. spaFormatISO emits 17:30 wall-clock with -07:00 (PDT offset)');
    }

    // 3. Date-only input is spa-local midnight, not UTC.
    {
      const d = parseSpaDateTime('2026-10-06');
      ok(d.toISOString() === '2026-10-06T07:00:00.000Z',
         '3. date-only "2026-10-06" is spa midnight -> 07:00Z (PDT)');
    }

    // 4. Explicit offset is preserved (not reinterpreted as spa).
    {
      const d = parseSpaDateTime('2026-10-06T17:30:00-05:00');
      ok(d.toISOString() === '2026-10-06T22:30:00.000Z',
         '4. explicit -05:00 offset preserved (22:30 UTC)');
      // spaFormatISO projects to spa wall-clock regardless of input offset.
      ok(spaFormatISO(d) === '2026-10-06T15:30:00.000-07:00',
         '4. spaFormatISO projects the same instant to 15:30 PDT');
    }

    // 5. spaDayKey/spaHoursMinutes read in spa time, not server time.
    {
      const d = parseSpaDateTime('2026-10-06T17:30'); // Tue 17:30 PDT
      ok(spaDayKey(d) === 'tue', '5. spaDayKey says Tue for 2026-10-06 17:30 PDT');
      ok(spaHoursMinutes(d) === 17 * 60 + 30, '5. spaHoursMinutes = 1050 (17:30)');
      // 2026-10-07T00:30Z is the same instant -> still Tue 17:30 spa.
      const d2 = new Date('2026-10-07T00:30:00.000Z');
      ok(spaDayKey(d2) === 'tue' && spaHoursMinutes(d2) === 1050,
         '5. same instant via UTC Z gives same spa day/hour');
    }

    // 6. spaAddMinutes preserves the spa wall-clock minute exactly.
    {
      const day = parseSpaDateTime('2026-10-06'); // spa midnight Tue
      const slot = spaAddMinutes(day, 17 * 60 + 30); // 17:30 spa
      ok(spaHoursMinutes(slot) === 1050, '6. spaAddMinutes(day, 1050) -> 17:30 spa');
      ok(slot.toISOString() === '2026-10-07T00:30:00.000Z',
         '6. spaAddMinutes yields the exact expected instant');
    }

    // 7. check_availability emits slots in spa-offset format, and the
    //    17:30 slot for a Tuesday massage equals 00:30Z (true instant).
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'check_availability',
        arguments: { service: 'svc-swedish-massage', date: '2026-10-06' },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.available === true, '7. Tue swedish availability present');
      // First Maya slot at 09:00 spa should format with -07:00.
      const maya0900 = data.slots.find(
        (s: any) => s.therapist_id === 'thr-maya' && /T09:00:00/.test(s.start_time),
      );
      ok(!!maya0900 && maya0900.start_time === '2026-10-06T09:00:00.000-07:00',
         '7. 09:00 PDT slot emitted as 2026-10-06T09:00:00.000-07:00');
      // Verify the 16:00 slot (last feasible for 60-min Swedish in 09-17)
      // exists and is emitted with the spa offset.
      const maya1600 = data.slots.find(
        (s: any) => s.therapist_id === 'thr-maya' && /T16:00:00/.test(s.start_time),
      );
      ok(!!maya1600 && maya1600.start_time === '2026-10-06T16:00:00.000-07:00' &&
         maya1600.end_time === '2026-10-06T17:00:00.000-07:00',
         '7. 16:00 PDT slot exists, ends 17:00, both emitted with -07:00');
      // And confirm no 16:30 slot (would end 17:30, exceeding the 17:00 close).
      ok(!data.slots.some((s: any) => s.therapist_id === 'thr-maya' && /T16:30:00/.test(s.start_time)),
         '7. no 16:30 slot (16:30+60=17:30 exceeds Maya\'s 17:00 close)');
    }

    // 8. create_booking with naive "2026-10-06T17:00" stores the exact instant.
    //    Maya Swedish 17:00-18:00 fits Mon 09-17? No, 17+60=18>17 -> not fit.
    //    Use Priya on Tue (11-19) for 17:00 Swedish; the stored start should be
    //    2026-10-07T00:00:00.000Z and the appointment reflects that exact instant.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          service: 'svc-swedish-massage',
          therapist_id: 'thr-priya', // Priya Tue 11-19
          start_time: '2026-10-06T17:00', // naive -> 17:00 PDT = 00:00Z Oct 7
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '8. naive 17:00 booking succeeds with Priya Tue');
      ok(data.start_time === '2026-10-06T17:00:00.000-07:00',
         '8. response start_time preserves 17:00 wall-clock with -07:00');
      ok(data.end_time === '2026-10-06T18:00:00.000-07:00',
         '8. response end_time preserves 18:00 (60-min Swedish)');
      // Persisted appointment stores the EXACT SAME instant in spa-offset form.
      const appt = loadAppointments().find((a) => a.id === data.appointment_id);
      ok(!!appt && appt.start_time === '2026-10-06T17:00:00.000-07:00',
         '8. persisted appointment start_time matches the response (same instant)');
      ok(
        new Date(appt!.start_time).toISOString() === '2026-10-07T00:00:00.000Z',
        '8. stored start_time is the exact requested instant (00:00Z Oct 7)',
      );
    }

    // 9. Server-timezone independence: simulate by parsing a naive input and
    //    confirming the result is the same regardless of the host's TZ.
    //    parseSpaDateTime must use Intl (America/Los_Angeles), not the host.
    {
      // Force a different host TZ for this check only.
      const prev = process.env.TZ;
      process.env.TZ = 'Asia/Kolkata';
      try {
        // Reschedule parse the same naive string; expect the SAME instant
        // as test 1 (17:30 PDT = 00:30Z), NOT shifted by IST.
        const d = parseSpaDateTime('2026-10-06T17:30');
        ok(d.toISOString() === '2026-10-07T00:30:00.000Z',
            '9. naive 17:30 still = 00:30Z even with host TZ=Asia/Kolkata');
      } finally {
        if (prev === undefined) delete process.env.TZ;
        else process.env.TZ = prev;
      }
    }
  }

  console.log('\n[11] check_availability date parsing (human-friendly formats)');
  {
    // 1. All four accepted formats normalize to the same spa-local instant.
    {
      const expected = '2026-10-10T07:00:00.000Z'; // Oct 10 2026, PDT midnight
      ok(parseSpaDate('2026-10-10').toISOString() === expected,
         '1a. "2026-10-10" -> 2026-10-10T07:00:00.000Z (spa midnight PDT)');
      ok(parseSpaDate('October 10, 2026').toISOString() === expected,
         '1b. "October 10, 2026" -> same instant');
      ok(parseSpaDate('Oct 10, 2026').toISOString() === expected,
         '1c. "Oct 10, 2026" -> same instant');
      ok(parseSpaDate('October 10 2026').toISOString() === expected,
         '1d. "October 10 2026" (no comma) -> same instant');
    }

    // 2. Case-insensitive, trimmed, extra whitespace tolerant.
    {
      ok(parseSpaDate('  oct 10  2026 ').toISOString() === '2026-10-10T07:00:00.000Z',
         '2. lowercase + extra whitespace accepted');
    }

    // 3. "sept" abbreviation accepted.
    {
      ok(parseSpaDate('Sept 1, 2026').toISOString() === '2026-09-01T07:00:00.000Z',
         '3. "Sept 1, 2026" accepted (4-letter abbrev)');
    }

    // 4. Invalid calendar dates rejected with a clear, structured error.
    {
      const cases: Array<[string, RegExp]> = [
        ['Feb 30 2026', /not a valid calendar date/],
        ['2026-13-01', /not a valid calendar date/],
        ['2026-02-31', /not a valid calendar date/],
        ['2026-04-31', /not a valid calendar date/], // April has 30 days
      ];
      for (const [input, pattern] of cases) {
        let thrown: string | null = null;
        try { parseSpaDate(input); } catch (e) { thrown = (e as Error).message; }
        ok(thrown !== null && pattern.test(thrown!),
           `4. invalid "${input}" rejected (${thrown})`);
      }
    }

    // 5. Unrecognized month name rejected.
    {
      let thrown: string | null = null;
      try { parseSpaDate('Foo 10 2026'); } catch (e) { thrown = (e as Error).message; }
      ok(thrown !== null && /unrecognized month "Foo"/.test(thrown!),
         '5. unrecognized month name rejected');
    }

    // 6. Ambiguous numeric formats (slash/dot) rejected.
    {
      const cases = ['10/10/2026', '10.10.2026', '2026/10/10'];
      for (const input of cases) {
        let thrown: string | null = null;
        try { parseSpaDate(input); } catch (e) { thrown = (e as Error).message; }
        ok(thrown !== null && /ambiguous/.test(thrown!),
           `6. ambiguous "${input}" rejected with "ambiguous"`);
      }
    }

    // 7. End-to-end: check_availability accepts each format and returns
    //    equivalent results. Oct 10 2026 is a Saturday: Priya works Sat
    //    09-17 and offers Swedish; Maya doesn't work Saturdays.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const iso = await client.callTool({
        name: 'check_availability',
        arguments: { service: 'svc-swedish-massage', date: '2026-10-10' },
      });
      const name = await client.callTool({
        name: 'check_availability',
        arguments: { service: 'svc-swedish-massage', date: 'October 10, 2026' },
      });
      const abbrev = await client.callTool({
        name: 'check_availability',
        arguments: { service: 'svc-swedish-massage', date: 'Oct 10, 2026' },
      });
      const noComma = await client.callTool({
        name: 'check_availability',
        arguments: { service: 'svc-swedish-massage', date: 'October 10 2026' },
      });
      const isoData = JSON.parse((iso.content as Array<{ type: string; text: string }>)[0].text);
      const nameData = JSON.parse((name.content as Array<{ type: string; text: string }>)[0].text);
      const abbrevData = JSON.parse((abbrev.content as Array<{ type: string; text: string }>)[0].text);
      const noCommaData = JSON.parse((noComma.content as Array<{ type: string; text: string }>)[0].text);
      ok((iso as any).isError !== true && isoData.available === true,
         '7a. ISO date accepted by check_availability');
      ok((name as any).isError !== true && nameData.available === true,
         '7b. "October 10, 2026" accepted by check_availability');
      // All four produce the same slot set (same Saturday -> only Priya).
      const sig = (d: any) => d.slots.map((s: any) => `${s.therapist_id}@${s.start_time}`).sort().join('|');
      ok(sig(isoData) === sig(nameData),
         '7c. ISO and month-name formats produce identical slot sets');
      ok(sig(abbrevData) === sig(noCommaData) && sig(isoData) === sig(abbrevData),
         '7d. all four formats produce identical slot sets');
      // On Saturday only Priya offers Swedish.
      ok(isoData.slots.every((s: any) => s.therapist_id === 'thr-priya'),
         '7e. Saturday Swedish slots are all with Priya');
      ok(isoData.slots.length > 0, '7f. Saturday Swedish slots present (Priya)');
    }

    // 8. Invalid date to check_availability returns a structured toolError,
    //    not a thrown exception.
    {
      const r = await client.callTool({
        name: 'check_availability',
        arguments: { service: 'svc-swedish-massage', date: 'Feb 30 2026' },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok((r as any).isError === true && /not a valid calendar date/.test(JSON.stringify(data)),
         '8. invalid calendar date -> structured error, not thrown');

      const r2 = await client.callTool({
        name: 'check_availability',
        arguments: { service: 'svc-swedish-massage', date: '10/10/2026' },
      });
      const data2 = JSON.parse((r2.content as Array<{ type: string; text: string }>)[0].text);
      ok((r2 as any).isError === true && /ambiguous/.test(JSON.stringify(data2)),
         '8. ambiguous numeric date -> structured error');
    }

    // 9. Regression: existing YYYY-MM-DD behavior unchanged.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'check_availability',
        arguments: { service: 'svc-deep-tissue-massage', date: '2026-10-05' },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.available === true, '9. YYYY-MM-DD still works (Mon deep-tissue)');
      const maya = data.slots.filter((s: any) => s.therapist_id === 'thr-maya');
      ok(maya.length > 0 && !maya.some((s: any) => /T10:00:00/.test(s.start_time)),
         '9. Maya 10:00 still excluded (existing conflict with apt-1001)');
    }
  }

  console.log('\n[12] unified parsing: natural datetimes + cross-tool consistency');
  {
    // Reference instant: "5:30 PM" on Oct 10, 2026 in PDT = 2026-10-11T00:30:00.000Z
    const ref = '2026-10-11T00:30:00.000Z';

    // 1. Natural datetime: "October 10, 2026 5:30 PM" -> exact instant.
    {
      const d = parseSpaInput('October 10, 2026 5:30 PM');
      ok(d.toISOString() === ref,
         '1. "October 10, 2026 5:30 PM" -> 2026-10-11T00:30:00.000Z (PDT)');
    }

    // 2. With "at": "Oct 10, 2026 at 5:30 PM" -> same instant.
    {
      const d = parseSpaInput('Oct 10, 2026 at 5:30 PM');
      ok(d.toISOString() === ref,
         '2. "Oct 10, 2026 at 5:30 PM" -> same instant');
    }

    // 3. Abbreviated month + no comma: "Oct 10 2026 5:30 PM" -> same instant.
    {
      const d = parseSpaInput('Oct 10 2026 5:30 PM');
      ok(d.toISOString() === ref,
         '3. "Oct 10 2026 5:30 PM" -> same instant');
    }

    // 4. ISO naive: "2026-10-10T17:30" -> same instant (24-hour).
    {
      const d = parseSpaInput('2026-10-10T17:30');
      ok(d.toISOString() === ref,
         '4. "2026-10-10T17:30" (naive ISO) -> same instant');
    }

    // 5. ISO space-sep 24-hour: "2026-10-10 17:30" -> same instant.
    {
      const d = parseSpaInput('2026-10-10 17:30');
      ok(d.toISOString() === ref,
         '5. "2026-10-10 17:30" (space, 24h) -> same instant');
    }

    // 6. AM/PM conversion edge cases.
    {
      ok(parseSpaInput('2026-10-10 12:00 PM').toISOString() === '2026-10-10T19:00:00.000Z',
         '6a. 12:00 PM -> noon (12:00 PDT = 19:00Z)');
      ok(parseSpaInput('2026-10-10 12:00 AM').toISOString() === '2026-10-10T07:00:00.000Z',
         '6b. 12:00 AM -> midnight (00:00 PDT = 07:00Z)');
      ok(parseSpaInput('2026-10-10 1:30 PM').toISOString() === '2026-10-10T20:30:00.000Z',
         '6c. 1:30 PM -> 13:30 (20:30Z)');
      ok(parseSpaInput('2026-10-10 1:30 AM').toISOString() === '2026-10-10T08:30:00.000Z',
         '6d. 1:30 AM -> 01:30 (08:30Z)');
    }

    // 7. Invalid times rejected with clear errors.
    {
      const cases: Array<[string, RegExp]> = [
        ['2026-10-10 13:30 PM', /1-12/],
        ['2026-10-10 25:00', /0-23/],
        ['2026-10-10 12:60', /minutes 60 out of range/],
        ['October 10, 2026 0:30 PM', /1-12/],
      ];
      for (const [input, pat] of cases) {
        let thrown: string | null = null;
        try { parseSpaInput(input); } catch (e) { thrown = (e as Error).message; }
        ok(thrown !== null && pat.test(thrown!),
           `7. invalid time "${input}" rejected (${thrown})`);
      }
    }

    // 8. Invalid calendar date in a natural datetime rejected.
    {
      let thrown: string | null = null;
      try { parseSpaInput('Feb 30 2026 5:30 PM'); } catch (e) { thrown = (e as Error).message; }
      ok(thrown !== null && /not a valid calendar date/.test(thrown!),
         '8. "Feb 30 2026 5:30 PM" rejected as invalid calendar date');
    }

    // 9. Ambiguous numeric date rejected even with a time.
    {
      let thrown: string | null = null;
      try { parseSpaInput('10/10/2026 5:30 PM'); } catch (e) { thrown = (e as Error).message; }
      ok(thrown !== null && /ambiguous/.test(thrown!),
         '9. "10/10/2026 5:30 PM" rejected as ambiguous');
    }

    // 10. Cross-tool: check_availability accepts natural datetime and uses
    //     the DATE part (ignores time). Oct 10 2026 is Saturday -> Priya only
    //     for Swedish.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'check_availability',
        arguments: { service: 'svc-swedish-massage', date: 'October 10, 2026 5:30 PM' },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok((r as any).isError !== true && data.available === true,
         '10a. check_availability accepts "October 10, 2026 5:30 PM"');
      ok(data.slots.every((s: any) => s.therapist_id === 'thr-priya'),
         '10b. Saturday slots are all Priya (date extracted from natural datetime)');
    }

    // 11. Cross-tool: create_booking with natural datetime stores the exact
    //     requested instant. Oct 10 2026 Sat: Priya 09-17, Swedish 60min.
    //     "4:00 PM" -> 16:00 PDT (last feasible start; ends 17:00).
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          service: 'svc-swedish-massage',
          therapist_id: 'thr-priya',
          start_time: 'October 10, 2026 4:00 PM',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '11a. create_booking accepts natural datetime');
      ok(data.start_time === '2026-10-10T16:00:00.000-07:00',
         '11b. response start_time = 16:00 PDT (exact requested wall-clock)');
      ok(data.end_time === '2026-10-10T17:00:00.000-07:00',
         '11c. response end_time = 17:00 (60-min Swedish)');
      const appt = loadAppointments().find((a) => a.id === data.appointment_id);
      ok(!!appt && new Date(appt!.start_time).toISOString() === '2026-10-10T23:00:00.000Z',
         '11d. persisted start_time is exact instant (23:00Z = 16:00 PDT)');
    }

    // 12. Cross-tool: reschedule_booking with natural datetime. apt-1001 is
    //     Maya deep-tissue Mon 10:00. Reschedule to "October 5, 2026 1:00 PM"
    //     (Mon 13:00 PDT) -> Maya free, deep-tissue 13:00-14:15 fits 09-17.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'reschedule_booking',
        arguments: {
          appointment_id: 'apt-1001',
          new_start_time: 'October 5, 2026 1:00 PM',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.rescheduled === true, '12a. reschedule accepts natural datetime');
      ok(data.appointment.therapist_id === 'thr-maya',
         '12b. stayed with Maya (preferred existing, available)');
      ok(data.appointment.start_time === '2026-10-05T13:00:00.000-07:00',
         '12c. start_time = 13:00 PDT (exact requested wall-clock)');
      ok(data.appointment.end_time === '2026-10-05T14:15:00.000-07:00',
         '12d. end_time recalculated (75-min deep-tissue) = 14:15');
    }

    // 13. Backward-compat wrappers delegate to parseSpaInput (no behavior
    //     regression for previously-supported forms).
    {
      ok(parseSpaDate('2026-10-10').toISOString() === '2026-10-10T07:00:00.000Z',
         '13a. parseSpaDate wrapper still works');
      ok(parseSpaDateTime('2026-10-06T17:30').toISOString() === '2026-10-07T00:30:00.000Z',
         '13b. parseSpaDateTime wrapper still works');
      // Wrappers now also accept the wider format set (single helper).
      ok(parseSpaDate('October 10, 2026 5:30 PM').toISOString() === ref,
         '13c. parseSpaDate wrapper accepts natural datetime (delegated)');
    }
  }

  console.log('\n[13] new-customer ID: UUID-based generation');
  {
    // 1. New customer gets a valid UUID (not name-derived).
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Emily Chen', phone: '+1-415-555-1001' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '1a. Emily booking succeeds');
      ok(UUID_RE.test(data.customer_id),
         '1b. generated customer_id is a valid UUID');
      ok(![CUS_ELENA, CUS_DAVID, CUS_SOFIA].includes(data.customer_id),
         '1c. new UUID differs from all fixture UUIDs');
      ok(!data.customer_id.includes('emily'),
         '1d. UUID is NOT derived from the customer name');

      // 1e. Persistence: customer ID lands in customers.json.
      const persisted = loadCustomers().find((c) => c.id === data.customer_id);
      ok(!!persisted && persisted.name === 'Emily Chen',
         '1e. new customer persisted to customers.json with UUID ID');

      // 1f. Same ID used in appointments.json (no mismatch).
      const appt = loadAppointments().find((a) => a.id === data.appointment_id);
      ok(!!appt && appt.customer_id === data.customer_id,
         '1f. appointment references the same UUID (consistent across files)');
    }

    // 2. Two new customers get distinct UUIDs.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r1 = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'John Smith', phone: '+1-415-555-2001' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const d1 = JSON.parse((r1.content as Array<{ type: string; text: string }>)[0].text);
      // Block Maya's 12:00 slot for the second booking so it goes to Priya.
      const r2 = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Jane Doe', phone: '+1-415-555-2002' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-priya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const d2 = JSON.parse((r2.content as Array<{ type: string; text: string }>)[0].text);
      ok(d1.success && d2.success, '2a. both new-customer bookings succeed');
      ok(UUID_RE.test(d1.customer_id) && UUID_RE.test(d2.customer_id),
         '2b. both IDs are valid UUIDs');
      ok(d1.customer_id !== d2.customer_id,
         '2c. two new customers get distinct UUIDs');
      // Both are persisted.
      const customers = loadCustomers();
      ok(customers.some(c => c.id === d1.customer_id),
         '2d. first new customer persisted');
      ok(customers.some(c => c.id === d2.customer_id),
         '2e. second new customer persisted');
    }

    // 3. Existing fixture customer IDs (now UUIDs) are never changed.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      // Book for an existing customer by id; no new customer is created.
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true && data.customer_id === CUS_ELENA,
         '3a. existing-customer path keeps the fixture UUID (no new ID minted)');

      // No new customer record appeared.
      const after = loadCustomers();
      ok(after.length === custSnapshot.length,
         '3b. no new customer record added for existing-customer booking');
      ok([CUS_ELENA, CUS_DAVID, CUS_SOFIA].every(id => after.some(c => c.id === id)),
         '3c. all three fixture UUIDs still present and unchanged');
    }

    // 4. get_appointment works with UUID customer_id.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      // apt-1001 belongs to David (CUS_DAVID).
      const r = await client.callTool({
        name: 'get_appointment',
        arguments: { customer_id: CUS_DAVID },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.found === true && data.count === 1,
         '4a. get_appointment finds David by UUID customer_id');
      ok(data.appointments[0].id === 'apt-1001',
         '4b. returns David\'s apt-1001');
      ok(data.appointments[0].customer_id === CUS_DAVID,
         '4c. appointment customer_id is the UUID');
    }

    // 5. reschedule_booking preserves the UUID customer_id.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'reschedule_booking',
        arguments: {
          appointment_id: 'apt-1001',
          new_start_time: '2026-10-05T13:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.rescheduled === true, '5a. reschedule succeeds');
      ok(data.appointment.customer_id === CUS_DAVID,
         '5b. rescheduled appointment keeps the UUID customer_id');
      ok(data.appointment.service_id === 'svc-deep-tissue-massage',
         '5c. service preserved');
    }
  }

  console.log('\n[14] customer_name on appointments + name-based lookup');
  {
    // 1. customer_name is stored on and returned from fixture appointments.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'get_appointment',
        arguments: { appointment_id: 'apt-1001' },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.found === true && data.appointments[0].customer_name === 'David Okonkwo',
         '1. apt-1001 has customer_name "David Okonkwo"');
      ok(data.appointments[0].customer_id === CUS_DAVID,
         '1. customer_id UUID still present alongside customer_name');
    }

    // 2. create_booking stores customer_name for a new customer.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Unique Newerson', phone: '+1-415-555-5001' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '2a. new customer booking succeeds');
      ok(UUID_RE.test(data.customer_id),
         '2b. new customer gets a UUID');
      const appt = loadAppointments().find((a) => a.id === data.appointment_id);
      ok(!!appt && appt.customer_name === 'Unique Newerson',
         '2c. appointment stores customer_name "Unique Newerson"');
      ok(Boolean(!!appt && appt.customer_id === data.customer_id),
         '2d. appointment stores the UUID as customer_id');
    }

    // 3. create_booking resolves existing customer by name + phone.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Elena Marsh', phone: '+1-415-555-0142' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '3a. name+phone booking succeeds');
      ok(data.customer_id === CUS_ELENA,
         '3b. resolved existing Elena by name+phone (no new customer created)');
      ok(loadCustomers().length === custSnapshot.length,
         '3c. no new customer record added');
    }

    // 4. Duplicate customer names: create_booking rejects name-only match
    //    with no phone, asking for disambiguation.
    {
      saveAppointments(apptSnapshot);
      // Seed a duplicate: two customers named "Jordan Doe".
      const dupId1 = randomUUID();
      const dupId2 = randomUUID();
      const seeded = [...custSnapshot,
        { id: dupId1, name: 'Jordan Doe', phone: '+1-415-555-6001', email: '', postcode: '', date_of_birth: '' },
        { id: dupId2, name: 'Jordan Doe', phone: '+1-415-555-6002', email: '', postcode: '', date_of_birth: '' },
      ];
      saveCustomers(seeded);

      // Name only -> ambiguous, should error.
      const r1 = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Jordan Doe' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const d1 = JSON.parse((r1.content as Array<{ type: string; text: string }>)[0].text);
      ok((r1 as any).isError === true && /Multiple customers named/.test(JSON.stringify(d1)),
         '4a. name-only with dupes -> disambiguation error');

      // Name + phone -> resolves the right one.
      const r2 = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Jordan Doe', phone: '+1-415-555-6001' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const d2 = JSON.parse((r2.content as Array<{ type: string; text: string }>)[0].text);
      ok(d2.success === true, '4b. name+phone resolves duplicate name');
      ok(d2.customer_id === dupId1,
         '4c. resolved the correct Jordan Doe (phone 6001)');
      ok(loadCustomers().length === seeded.length,
         '4d. no new customer created (existing resolved)');
    }

    // 5. get_appointment by customer_name (unique) returns appointments.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'get_appointment',
        arguments: { customer_name: 'Sofia Reyes' },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.found === true && !data.ambiguous,
         '5a. unique name -> found, not ambiguous');
      ok(data.count === 1 && data.appointments[0].id === 'apt-1002',
         '5b. returns Sofia\'s apt-1002');
      ok(data.appointments[0].customer_name === 'Sofia Reyes',
         '5c. appointment includes customer_name');
    }

    // 6. get_appointment by customer_name (duplicate) returns candidates
    //    for disambiguation — does NOT guess.
    {
      saveAppointments(apptSnapshot);
      const dupId1 = randomUUID();
      const dupId2 = randomUUID();
      const seeded = [...custSnapshot,
        { id: dupId1, name: 'Taylor Smith', phone: '+1-415-555-7001', email: '', postcode: '', date_of_birth: '' },
        { id: dupId2, name: 'Taylor Smith', phone: '+1-415-555-7002', email: '', postcode: '', date_of_birth: '' },
      ];
      saveCustomers(seeded);

      const r = await client.callTool({
        name: 'get_appointment',
        arguments: { customer_name: 'Taylor Smith' },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.found === true && data.ambiguous === true,
         '6a. duplicate name -> ambiguous flag set');
      ok(Array.isArray(data.matching_customers) && data.matching_customers.length === 2,
         '6b. returns 2 matching candidates');
      ok(data.matching_customers.every((c: any) =>
         c.customer_id && c.name === 'Taylor Smith' && !c.phone && !c.email),
         '6c. candidates show ID+name only (no phone/email exposed)');
      ok(/verify identity|additional verification/i.test(data.message),
         '6d. message indicates additional verification required');

      // Now resolve by UUID (one of the duplicates).
      const r2 = await client.callTool({
        name: 'get_appointment',
        arguments: { customer_id: dupId1 },
      });
      const d2 = JSON.parse((r2.content as Array<{ type: string; text: string }>)[0].text);
      ok(d2.found === false,
         '6e. Taylor Smith #1 has no appointments (new fixture customer)');
    }

    // 7. get_appointment by customer_name with no match.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'get_appointment',
        arguments: { customer_name: 'Nobody Here' },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.found === false && /No customer named/.test(data.message),
         '7. unknown name -> found:false with clear message');
    }

    // 8. Phone not exposed in normal appointment responses.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'get_appointment',
        arguments: { appointment_id: 'apt-1001' },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      const appt = data.appointments[0];
      ok(!Object.prototype.hasOwnProperty.call(appt, 'phone') &&
         !Object.prototype.hasOwnProperty.call(appt, 'email') &&
         !Object.prototype.hasOwnProperty.call(appt, 'date_of_birth'),
         '8. phone/email/DOB not exposed in appointment response');
    }

    // 9. reschedule preserves customer_name.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'reschedule_booking',
        arguments: {
          appointment_id: 'apt-1001',
          new_start_time: '2026-10-05T13:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.rescheduled === true, '9a. reschedule succeeds');
      ok(data.appointment.customer_name === 'David Okonkwo',
         '9b. customer_name preserved after reschedule');
      ok(data.appointment.customer_id === CUS_DAVID,
         '9c. customer_id UUID preserved after reschedule');
    }
  }

  console.log('\n[15] create_booking: customer resolution by UUID, name+phone, name+email');
  {
    // 1. Existing customer by UUID.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer_id: CUS_ELENA,
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '1a. existing UUID booking succeeds');
      ok(data.customer_id === CUS_ELENA,
         '1b. reused Elena\'s UUID (no new customer)');
      ok(loadCustomers().length === custSnapshot.length,
         '1c. no duplicate customer created');
    }

    // 2. Existing customer by name + phone.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'David Okonkwo', phone: '+1-415-555-0178' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '2a. name+phone booking succeeds');
      ok(data.customer_id === CUS_DAVID,
         '2b. resolved David by name+phone -> reused UUID');
      ok(loadCustomers().length === custSnapshot.length,
         '2c. no duplicate customer created');
    }

    // 3. Existing customer by name + email (no phone).
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Sofia Reyes', email: 'sofia.reyes@example.com' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '3a. name+email booking succeeds');
      ok(data.customer_id === CUS_SOFIA,
         '3b. resolved Sofia by name+email -> reused UUID');
      ok(loadCustomers().length === custSnapshot.length,
         '3c. no duplicate customer created');
    }

    // 4. New customer when no match.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const before = loadCustomers().length;
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Brand Newperson', phone: '+1-415-555-9999' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '4a. new customer booking succeeds');
      ok(UUID_RE.test(data.customer_id) && ![CUS_ELENA, CUS_DAVID, CUS_SOFIA].includes(data.customer_id),
         '4b. got a new UUID');
      ok(loadCustomers().length === before + 1,
         '4c. exactly one new customer record persisted');
      ok(loadCustomers().some((c) => c.id === data.customer_id && c.name === 'Brand Newperson'),
         '4d. new customer persisted with correct name');
    }

    // 5. Duplicate-name ambiguity: name only (no phone/email) -> error.
    {
      saveAppointments(apptSnapshot);
      const dupId1 = randomUUID();
      const dupId2 = randomUUID();
      const seeded = [...custSnapshot,
        { id: dupId1, name: 'Alex Lee', phone: '+1-415-555-8001', email: 'alex1@example.com', postcode: '', date_of_birth: '' },
        { id: dupId2, name: 'Alex Lee', phone: '+1-415-555-8002', email: 'alex2@example.com', postcode: '', date_of_birth: '' },
      ];
      saveCustomers(seeded);

      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Alex Lee' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok((r as any).isError === true && /Multiple customers named/.test(JSON.stringify(data)),
         '5a. name-only with dupes -> disambiguation error');
      ok(/phone or email|customer_id/i.test(JSON.stringify(data)),
         '5b. error suggests phone, email, or customer_id');
    }

    // 6. Duplicate-name disambiguation by phone.
    {
      saveAppointments(apptSnapshot);
      const dupId1 = randomUUID();
      const dupId2 = randomUUID();
      const seeded = [...custSnapshot,
        { id: dupId1, name: 'Casey Kim', phone: '+1-415-555-8101', email: 'casey1@example.com', postcode: '', date_of_birth: '' },
        { id: dupId2, name: 'Casey Kim', phone: '+1-415-555-8102', email: 'casey2@example.com', postcode: '', date_of_birth: '' },
      ];
      saveCustomers(seeded);

      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Casey Kim', phone: '+1-415-555-8101' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '6a. name+phone resolves duplicate');
      ok(data.customer_id === dupId1,
         '6b. resolved correct Casey Kim (phone 8101)');
      ok(loadCustomers().length === seeded.length,
         '6c. no new customer created (existing resolved)');
    }

    // 7. Duplicate-name disambiguation by email (no phone).
    {
      saveAppointments(apptSnapshot);
      const dupId1 = randomUUID();
      const dupId2 = randomUUID();
      const seeded = [...custSnapshot,
        { id: dupId1, name: 'Morgan Bell', phone: '+1-415-555-8201', email: 'morgan1@example.com', postcode: '', date_of_birth: '' },
        { id: dupId2, name: 'Morgan Bell', phone: '+1-415-555-8202', email: 'morgan2@example.com', postcode: '', date_of_birth: '' },
      ];
      saveCustomers(seeded);

      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Morgan Bell', email: 'morgan2@example.com' },
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '7a. name+email resolves duplicate');
      ok(data.customer_id === dupId2,
         '7b. resolved correct Morgan Bell (email morgan2)');
    }

    // 8. Duplicate prevention: name+phone matching an existing customer
    //    never creates a second record.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const before = loadCustomers().length;
      // Book twice with the same name+phone (Elena).
      const args = {
        customer: { name: 'Elena Marsh', phone: '+1-415-555-0142' },
        service: 'svc-swedish-massage',
        therapist_id: 'thr-maya',
        start_time: '2026-10-06T12:00:00-07:00',
      };
      // Use two different times + therapists to avoid slot conflicts.
      await client.callTool({ name: 'create_booking', arguments: args });
      // Second booking at a different time.
      const r2 = await client.callTool({
        name: 'create_booking',
        arguments: {
          ...args,
          therapist_id: 'thr-priya',
          start_time: '2026-10-06T13:00:00-07:00',
        },
      });
      const data2 = JSON.parse((r2.content as Array<{ type: string; text: string }>)[0].text);
      ok(data2.success === true, '8a. second booking with same name+phone succeeds');
      ok(data2.customer_id === CUS_ELENA,
         '8b. reused Elena\'s UUID on second booking (no duplicate)');
      ok(loadCustomers().length === before,
         '8c. still no duplicate after two bookings with same name+phone');
    }

    // 9. New customer with same name as existing but different phone -> new record.
    {
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
      const before = loadCustomers().length;
      const r = await client.callTool({
        name: 'create_booking',
        arguments: {
          customer: { name: 'Elena Marsh', phone: '+1-415-555-0143' }, // different phone
          service: 'svc-swedish-massage',
          therapist_id: 'thr-maya',
          start_time: '2026-10-06T12:00:00-07:00',
        },
      });
      const data = JSON.parse((r.content as Array<{ type: string; text: string }>)[0].text);
      ok(data.success === true, '9a. different-phone booking succeeds');
      ok(data.customer_id !== CUS_ELENA,
         '9b. created NEW UUID (different person, different phone)');
      ok(loadCustomers().length === before + 1,
         '9c. a new customer record was created (same name, different phone)');
    }
  }

  // Restore fixtures before the HTTP smoke test so the HTTP test starts clean
  // and so a crash there can't leave polluted data.
  saveAppointments(apptSnapshot);
  saveCustomers(custSnapshot);

  console.log('\n[16] HTTP transport (Streamable HTTP on /mcp)');
  {
    // Spawn the server in HTTP mode on an ephemeral port.
    const port = 3999;
    const httpServer = spawn(
      process.execPath,
      [serverPath, '--http'],
      { env: { ...process.env, PORT: String(port), MCP_TRANSPORT: undefined } },
    );
    let httpServerLog = '';
    httpServer.stdout.on('data', (d: Buffer) => { httpServerLog += d.toString(); });
    httpServer.stderr.on('data', (d: Buffer) => { httpServerLog += d.toString(); });

    // Wait for the "listening" log line.
    const started = await new Promise<boolean>((resolve) => {
      const deadline = setTimeout(() => resolve(false), 8000);
      httpServer.stdout.on('data', () => {
        if (/listening/.test(httpServerLog)) {
          clearTimeout(deadline);
          resolve(true);
        }
      });
    });
    ok(started, '1a. HTTP server boots and logs "listening"');
    if (!started) {
      console.error('HTTP server failed to start. Log:\n', httpServerLog);
      httpServer.kill('SIGKILL');
      process.exit(1);
    }

    // Wait a beat for the listener to be ready.
    await new Promise((r) => setTimeout(r, 100));

    try {
      // Connect an MCP client over Streamable HTTP to /mcp.
      const httpTransport = new StreamableHTTPClientTransport(
        new URL(`http://localhost:${port}/mcp`),
      );
      const httpClient = new Client(
        { name: 'http-test-client', version: '0.1.0' },
        { capabilities: {} },
      );
      await httpClient.connect(httpTransport);

      // 2. tools/list returns all 5 tools over HTTP.
      const listRes = await httpClient.listTools();
      const toolNames = listRes.tools.map((t: any) => t.name).sort();
      ok(toolNames.length === 5,
         '2a. HTTP tools/list returns 5 tools');
      ok(JSON.stringify(toolNames) ===
         JSON.stringify(['check_availability', 'create_booking', 'get_appointment', 'get_service_info', 'reschedule_booking']),
         '2b. all 5 tool names present over HTTP');

      // 3. tools/call works over HTTP (get_service_info).
      const callRes = await httpClient.callTool({
        name: 'get_service_info',
        arguments: { service: 'Swedish Massage' },
      });
      const callData = JSON.parse(
        (callRes.content as Array<{ type: string; text: string }>)[0].text,
      );
      ok(callData.found === true && callData.id === 'svc-swedish-massage',
         '3. tools/call get_service_info works over HTTP');

      // 4. tools/call works over HTTP (check_availability).
      const availRes = await httpClient.callTool({
        name: 'check_availability',
        arguments: { service: 'svc-swedish-massage', date: '2026-10-06' },
      });
      const availData = JSON.parse(
        (availRes.content as Array<{ type: string; text: string }>)[0].text,
      );
      ok(availData.available === true && availData.slots.length > 0,
         '4. tools/call check_availability works over HTTP (returns slots)');

      // 5. Non-/mcp path returns 404 (minimal server sanity check).
      {
        const r = await fetch(`http://localhost:${port}/`);
        ok(r.status === 404,
           '5. GET / returns 404 (only POST /mcp is served)');
      }

      await httpClient.close();
    } finally {
      httpServer.kill('SIGTERM');
      // Restore fixtures again after the HTTP test (it only reads, but be safe).
      saveAppointments(apptSnapshot);
      saveCustomers(custSnapshot);
    }
  }

  await client.close();
  // Restore both fixtures so repeated test runs don't accumulate fake
  // customers or appointments.
  saveAppointments(apptSnapshot);
  saveCustomers(custSnapshot);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
