// Availability engine shared by check_availability and create_booking.

import {
  Service, Therapist, Appointment,
  spaDayKey, spaAddMinutes, spaHoursMinutes,
  parseRange, parseSpaInput, spaFormatISO, rangesOverlap,
} from './types.js';

export interface Slot {
  therapist_id: string;
  therapist_name: string;
  start_time: string; // ISO with spa offset
  end_time: string;   // ISO with spa offset
}

/**
 * Compute available 30-minute-grid slots for a service on a given date,
 * per therapist who offers that service, respecting weekly_schedule and
 * existing confirmed appointments. We do not invent availability:
 * if no working range covers the slot, it is not returned.
 *
 * Slot cadence: every 30 minutes on the half-hour, aligned to the
 * therapist's working-range start. Only slots whose full duration fits
 * inside a single working range (with no appointment overlap) are returned.
 *
 * `date` is any instant within the spa-local day to enumerate. All wall-clock
 * reasoning is anchored to America/Los_Angeles (see spaDayKey/spaAddMinutes).
 */
export function computeAvailability(
  service: Service,
  date: Date,
  therapists: Therapist[],
  appointments: Appointment[],
  preferredTherapistId?: string,
): Slot[] {
  const slots: Slot[] = [];
  const durationMin = service.duration_minutes;
  const dayKey = spaDayKey(date);
  const gridStepMin = 30;

  const candidates = therapists.filter((t) => {
    if (preferredTherapistId && t.id !== preferredTherapistId) return false;
    return t.service_ids.includes(service.id);
  });

  for (const t of candidates) {
    const ranges = t.weekly_schedule[dayKey] ?? [];
    for (const range of ranges) {
      const { startMin, endMin } = parseRange(range);

      // Confirmed appointments for this therapist, as instants.
      const conflicts = appointments
        .filter((a) => a.therapist_id === t.id && a.status === 'confirmed')
        .map((a) => ({
          start: parseSpaInput(a.start_time, 'appointment start_time'),
          end: parseSpaInput(a.end_time, 'appointment end_time'),
        }));

      for (let s = startMin; s + durationMin <= endMin; s += gridStepMin) {
        const slotStart = spaAddMinutes(date, s);
        const slotEnd = spaAddMinutes(date, s + durationMin);

        const overlapsExisting = conflicts.some((c) =>
          rangesOverlap(slotStart, slotEnd, c.start, c.end),
        );
        if (overlapsExisting) continue;

        slots.push({
          therapist_id: t.id,
          therapist_name: t.name,
          start_time: spaFormatISO(slotStart),
          end_time: spaFormatISO(slotEnd),
        });
      }
    }
  }

  return slots;
}

/**
 * True if a proposed [start, end) for a therapist is free per the rules above.
 *
 * `excludeAppointmentId` (optional) excludes one appointment from the
 * conflict check. Used by reschedule_booking so the appointment being
 * moved does not conflict with itself at its new time.
 *
 * All calendar arithmetic uses spa-local (America/Los_Angeles) projection
 * so working-schedule checks are independent of the server's own timezone.
 */
export function isSlotFree(
  service: Service,
  therapist: Therapist,
  start: Date,
  end: Date,
  appointments: Appointment[],
  excludeAppointmentId?: string,
): boolean {
  // 1. Therapist must offer the service.
  if (!therapist.service_ids.includes(service.id)) return false;

  // 2. Must fall within a single working range on the spa-local day.
  const dayKey = spaDayKey(start);
  const ranges = therapist.weekly_schedule[dayKey] ?? [];
  const startMin = spaHoursMinutes(start);
  const endMin = spaHoursMinutes(end);
  const withinRange = ranges.some((r) => {
    const { startMin: rs, endMin: re } = parseRange(r);
    return startMin >= rs && endMin <= re;
  });
  if (!withinRange) return false;

  // 3. No overlap with existing confirmed appointments
  //    (optionally excluding the appointment being rescheduled).
  const conflicts = appointments
    .filter(
      (a) =>
        a.therapist_id === therapist.id &&
        a.status === 'confirmed' &&
        a.id !== excludeAppointmentId,
    )
    .map((a) => ({
      start: parseSpaInput(a.start_time, 'appointment start_time'),
      end: parseSpaInput(a.end_time, 'appointment end_time'),
    }));

  return !conflicts.some((c) => rangesOverlap(start, end, c.start, c.end));
}
