// Availability engine ported from mcp-server/src/availability.ts.
// Identical logic; only the import paths differ.

import {
  Service, Therapist, Appointment,
  spaDayKey, spaAddMinutes, spaHoursMinutes,
  parseRange, parseSpaInput, spaFormatISO, rangesOverlap,
} from './types.js';

export interface Slot {
  therapist_id: string;
  therapist_name: string;
  start_time: string; // ISO with spa offset
  end_time: string;
}

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

export function isSlotFree(
  service: Service,
  therapist: Therapist,
  start: Date,
  end: Date,
  appointments: Appointment[],
  excludeAppointmentId?: string,
): boolean {
  if (!therapist.service_ids.includes(service.id)) return false;
  const dayKey = spaDayKey(start);
  const ranges = therapist.weekly_schedule[dayKey] ?? [];
  const startMin = spaHoursMinutes(start);
  const endMin = spaHoursMinutes(end);
  const withinRange = ranges.some((r) => {
    const { startMin: rs, endMin: re } = parseRange(r);
    return startMin >= rs && endMin <= re;
  });
  if (!withinRange) return false;

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
