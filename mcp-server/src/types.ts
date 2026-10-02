// Shared types matching the on-disk JSON schema in /data.
// We intentionally mirror the existing schema rather than altering it.

export interface Service {
  id: string;
  name: string;
  description: string;
  duration_minutes: number;
  price_usd: number;
}

export interface Therapist {
  id: string;
  name: string;
  service_ids: string[];
  weekly_schedule: Record<DayKey, string[]>;
}

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  postcode: string;
  date_of_birth: string;
  notes?: string;
}

export interface Appointment {
  id: string;
  customer_id: string;
  customer_name: string; // denormalized snapshot for readability; customer_id is authoritative
  therapist_id: string;
  service_id: string;
  start_time: string;
  end_time: string;
  status: 'confirmed' | 'cancelled';
}

// ---------- File loading ----------

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// dist/src/ -> ../../../data  (mcp-server/dist/src -> mcp-server -> repo root -> data)
const DEFAULT_DATA_DIR = resolve(here, '..', '..', '..', 'data');
const DATA_DIR = process.env.SPA_DATA_DIR
  ? resolve(process.env.SPA_DATA_DIR)
  : DEFAULT_DATA_DIR;

function readJson<T>(file: string): T {
  const raw = readFileSync(resolve(DATA_DIR, file), 'utf8');
  return JSON.parse(raw) as T;
}

export function loadServices(): Service[] {
  return readJson<Service[]>('services.json');
}

export function loadTherapists(): Therapist[] {
  return readJson<Therapist[]>('therapists.json');
}

export function loadCustomers(): Customer[] {
  return readJson<Customer[]>('customers.json');
}

export function loadAppointments(): Appointment[] {
  return readJson<Appointment[]>('appointments.json');
}

export function saveAppointments(apts: Appointment[]): void {
  writeFileSync(
    resolve(DATA_DIR, 'appointments.json'),
    JSON.stringify(apts, null, 2) + '\n',
    'utf8',
  );
}

export function saveCustomers(customers: Customer[]): void {
  writeFileSync(
    resolve(DATA_DIR, 'customers.json'),
    JSON.stringify(customers, null, 2) + '\n',
    'utf8',
  );
}

// ---------- Helpers ----------

const DAY_KEYS: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export function dayKeyFor(date: Date): DayKey {
  return DAY_KEYS[date.getDay()];
}

/** Parse a "HH:MM-HH:MM" range into minutes-since-midnight endpoints. */
export function parseRange(range: string): { startMin: number; endMin: number } {
  const m = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(range);
  if (!m) throw new Error(`Invalid time range: ${range}`);
  const [, sh, sm, eh, em] = m;
  const startMin = Number(sh) * 60 + Number(sm);
  const endMin = Number(eh) * 60 + Number(em);
  if (endMin <= startMin) throw new Error(`Range end must be after start: ${range}`);
  return { startMin, endMin };
}

/** Convert minutes-since-midnight to "HH:MM". */
export function minToHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Parse an ISO timestamp into a Date, throwing a clear error on bad input. */
export function parseISO(ts: string, label: string): Date {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${label}: ${ts}`);
  }
  return d;
}

// ---------- Spa timezone helpers (America/Los_Angeles) ----------
//
// The spa operates in America/Los_Angeles. All wall-clock reasoning
// (which day of the week, working-hour ranges, slot grids) is anchored to
// spa-local time, regardless of the server's own timezone. Inputs without
// an explicit offset (e.g. "2026-10-06T17:30" or "2026-10-06") are
// interpreted as spa-local. The internal representation is still a UTC
// `Date` (one consistent instant); we only project to spa parts when we
// need calendar/hour fields or an unambiguous wire format.

const SPA_TZ = 'America/Los_Angeles';

const SPA_PARTS_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: SPA_TZ,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short',
});

const SPA_OFFSET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: SPA_TZ,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
});

/** Spa-local calendar parts for a given instant. */
function spaParts(d: Date): {
  year: number; month: number; day: number;
  hour: number; minute: number; second: number;
  weekday: DayKey;
} {
  const parts = SPA_PARTS_FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = (get('weekday').toLowerCase().slice(0, 3)) as DayKey;
  if (!['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(weekday)) {
    throw new Error(`Unexpected weekday from Intl: ${get('weekday')}`);
  }
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday,
  };
}

/**
 * Offset (in minutes) of the spa timezone from UTC at the given instant.
 * Positive means ahead of UTC (e.g. +0 would be UTC; -420 means PDT is 7h
 * behind). The sign convention here matches `Date.getTimezoneOffset()`:
 * minutes to *add* to local to reach UTC = -offset. We return the value
 * such that `utcMs = spaWallAsUtcMs - offsetMinutes*60000`.
 */
function spaOffsetMinutes(d: Date): number {
  const parts = SPA_OFFSET_FMT.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asIfUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return Math.round((asIfUTC - d.getTime()) / 60000);
}

/** The spa-local day key (mon/tue/...) for the given instant. */
export function spaDayKey(d: Date): DayKey {
  return spaParts(d).weekday;
}

/** Spa-local minutes-since-midnight for the given instant. */
export function spaHoursMinutes(d: Date): number {
  const { hour, minute } = spaParts(d);
  return hour * 60 + minute;
}

/**
 * Return a Date whose spa-local time is `minutesSinceMidnight` on the same
 * spa-local calendar day as `date`. Preserves the wall-clock minute;
 * never shifts or rounds.
 */
export function spaAddMinutes(date: Date, minutesSinceMidnight: number): Date {
  const { year, month, day } = spaParts(date);
  const h = Math.floor(minutesSinceMidnight / 60);
  const m = minutesSinceMidnight % 60;
  // Build the instant as if those spa wall-clock values were UTC, then
  // correct by the spa offset AT that guess. The offset can only flip by
  // a whole number of minutes (DST jumps by 60), so one iteration is
  // sufficient; we do a second pass to be safe.
  const guessUTC = Date.UTC(year, month - 1, day, h, m, 0, 0);
  const off = spaOffsetMinutes(new Date(guessUTC));
  let instant = guessUTC - off * 60000;
  // Recompute offset at the actual instant in case the guess straddled a
  // DST transition (extremely rare for our wall-clock-aligned inputs).
  const off2 = spaOffsetMinutes(new Date(instant));
  instant = guessUTC - off2 * 60000;
  return new Date(instant);
}

/**
 * Format a Date as an ISO string with the spa timezone offset, e.g.
 * "2026-10-06T17:30:00.000-07:00". The wall-clock part is always the
 * spa-local time, so the displayed hour/minute matches what the caller
 * asked about. This is the single canonical wire format for stored and
 * returned datetimes.
 */
export function spaFormatISO(d: Date): string {
  const { year, month, day, hour, minute, second } = spaParts(d);
  const off = spaOffsetMinutes(d);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return (
    `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}.000` +
    `${sign}${oh}:${om}`
  );
}

// ---------- Unified spa date/datetime parsing ----------
//
// `parseSpaInput` is the SINGLE shared parsing/normalization helper used by
// check_availability, create_booking, and reschedule_booking. It accepts a
// wide set of human-friendly forms and normalizes them to an instant (Date)
// anchored to America/Los_Angeles. `parseSpaDate` and `parseSpaDateTime`
// are kept as thin delegating wrappers (no duplicated logic) for backward
// compatibility with existing imports.

/** Build an instant from spa-local wall-clock components. */
function spaLocalFromParts(
  year: number, month: number, day: number,
  hour: number, minute: number, second: number,
): Date {
  const guessUTC = Date.UTC(year, month - 1, day, hour, minute, second, 0);
  const off = spaOffsetMinutes(new Date(guessUTC));
  let instant = guessUTC - off * 60000;
  // Second pass in case the wall-clock guess straddled a DST transition.
  const off2 = spaOffsetMinutes(new Date(instant));
  instant = guessUTC - off2 * 60000;
  return new Date(instant);
}

const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function daysInMonth(year: number, month: number): number {
  // month is 1-12. Handles leap years via Date.UTC normalization.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || year < 1900 || year > 9999) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) return false;
  return true;
}

/** Resolve a month name (full or 3-4 letter abbreviation) to 1-12, or throw. */
function lookupMonth(name: string, input: string, label: string): number {
  const m = MONTH_NAMES[name.toLowerCase()];
  if (!m) {
    throw new Error(`Invalid ${label}: unrecognized month "${name}" in "${input}".`);
  }
  return m;
}

/** Throw a clear error if (year, month, day) is not a real calendar date. */
function assertCalendarDate(
  year: number, month: number, day: number, input: string, label: string,
): void {
  if (!isValidCalendarDate(year, month, day)) {
    throw new Error(`Invalid ${label}: "${input}" is not a valid calendar date.`);
  }
}

/**
 * Normalize an hour/minute/second + optional AM/PM to a 24-hour {hour,minute,
 * second}, validating ranges. Without AM/PM the hour must be 0-23; with
 * AM/PM it must be 1-12 (12 AM -> 0, 12 PM -> 12).
 */
function to24Hour(
  h: number, mi: number, se: number, ap: string | undefined,
  input: string, label: string,
): { hour: number; minute: number; second: number } {
  if (mi < 0 || mi > 59) {
    throw new Error(`Invalid ${label}: minutes ${mi} out of range in "${input}".`);
  }
  if (se < 0 || se > 59) {
    throw new Error(`Invalid ${label}: seconds ${se} out of range in "${input}".`);
  }
  let hour = h;
  if (ap) {
    if (h < 1 || h > 12) {
      throw new Error(`Invalid ${label}: hour ${h} with ${ap.toUpperCase()} must be 1-12 in "${input}".`);
    }
    const u = ap.toUpperCase();
    if (u === 'PM' && h !== 12) hour += 12;
    if (u === 'AM' && h === 12) hour = 0;
  } else if (h < 0 || h > 23) {
    throw new Error(`Invalid ${label}: hour ${h} out of range (0-23, or use AM/PM) in "${input}".`);
  }
  return { hour, minute: mi, second: se };
}

/**
 * The single shared spa date/datetime parser used by all three tools.
 *
 * Accepted forms (case-insensitive, whitespace-trimmed):
 *
 * Date-only (returns spa-local midnight):
 *   - "YYYY-MM-DD"             e.g. "2026-10-10"
 *   - "MonthName D, YYYY"      e.g. "October 10, 2026", "Oct 10, 2026"
 *   - "MonthName D YYYY"       e.g. "October 10 2026"
 *
 * Datetime (returns spa-local time; preserves the exact requested minute):
 *   - "YYYY-MM-DDTHH:MM"       ISO, no offset -> spa local
 *   - "YYYY-MM-DDTHH:MM:SS"    (with optional .fff fractional seconds)
 *   - "YYYY-MM-DDTHH:MM:SSZ"   UTC (offset preserved)
 *   - "YYYY-MM-DDTHH:MM:SS±HH:MM" that offset (preserved)
 *   - "YYYY-MM-DD HH:MM[:SS]"  space separator, 24-hour
 *   - "YYYY-MM-DD H:MM [AM|PM]" space separator, 12-hour
 *   - "MonthName D, YYYY [at] HH:MM[:SS] [AM|PM]"  natural datetime
 *
 * For datetime inputs without an explicit offset (Z or ±HH:MM), the
 * wall-clock time is interpreted in America/Los_Angeles. The exact
 * requested hour/minute is never shifted or rounded.
 *
 * Rejected (with a clear error):
 *   - Ambiguous numeric slash/dot formats ("10/10/2026", "10.10.2026").
 *   - Invalid calendar dates ("Feb 30 2026", "2026-13-01").
 *   - Invalid times ("13:30 PM", "25:00", "12:60").
 *   - Unrecognized month names ("Foo 10 2026").
 */
export function parseSpaInput(input: string, label = 'datetime'): Date {
  const s = input.trim();

  // 1. ISO date-only: YYYY-MM-DD
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    assertCalendarDate(y, mo, d, input, label);
    return spaLocalFromParts(y, mo, d, 0, 0, 0);
  }

  // 2. ISO datetime with T (24-hour, optional offset). AM/PM not allowed
  //    in the standard T form; the space form below handles 12-hour.
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, se, tz] = m;
    assertCalendarDate(+y, +mo, +d, input, label);
    const t = to24Hour(+h, +mi, se ? +se : 0, undefined, input, label);
    if (tz) {
      const dt = new Date(s);
      if (Number.isNaN(dt.getTime())) {
        throw new Error(`Invalid ${label}: "${input}" could not be parsed.`);
      }
      return dt;
    }
    return spaLocalFromParts(+y, +mo, +d, t.hour, t.minute, t.second);
  }

  // 3. ISO datetime with space separator + optional AM/PM (12-hour).
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?$/.exec(s);
  if (m) {
    const [, y, mo, d, h, mi, se, ap] = m;
    assertCalendarDate(+y, +mo, +d, input, label);
    const t = to24Hour(+h, +mi, se ? +se : 0, ap, input, label);
    return spaLocalFromParts(+y, +mo, +d, t.hour, t.minute, t.second);
  }

  // 4. Month-name date-only: "Month D, YYYY" or "Month D YYYY"
  m = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const [, name, dd, yy] = m;
    const mo = lookupMonth(name, input, label);
    assertCalendarDate(+yy, mo, +dd, input, label);
    return spaLocalFromParts(+yy, mo, +dd, 0, 0, 0);
  }

  // 5. Month-name natural datetime: "Month D, YYYY [at] H:MM[:SS] [AM|PM]"
  m = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s+(?:at\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?$/.exec(s);
  if (m) {
    const [, name, dd, yy, h, mi, se, ap] = m;
    const mo = lookupMonth(name, input, label);
    assertCalendarDate(+yy, mo, +dd, input, label);
    const t = to24Hour(+h, +mi, se ? +se : 0, ap, input, label);
    return spaLocalFromParts(+yy, mo, +dd, t.hour, t.minute, t.second);
  }

  // 6. Explicitly reject ambiguous numeric slash/dot formats, including
  //    when followed by a time component (e.g. "10/10/2026 5:30 PM").
  if (/^\d{1,4}[/.]\d{1,2}[/.]\d{1,4}(\s|$)/.test(s)) {
    throw new Error(
      `Invalid ${label}: "${input}" is ambiguous. Use "YYYY-MM-DD", ` +
      '"MonthName D, YYYY", or a natural datetime form (e.g. "October 10, 2026 5:30 PM").',
    );
  }

  throw new Error(
    `Invalid ${label}: "${input}". Supported formats: "YYYY-MM-DD", ` +
    '"October 10, 2026", "2026-10-10T17:30", "October 10, 2026 5:30 PM".',
  );
}

/** Backward-compatible alias for parseSpaInput (date-only semantics). */
export function parseSpaDate(input: string, label = 'date'): Date {
  return parseSpaInput(input, label);
}

/** Backward-compatible alias for parseSpaInput (datetime semantics). */
export function parseSpaDateTime(input: string, label = 'datetime'): Date {
  return parseSpaInput(input, label);
}

/** Generate the next stable appointment ID given existing appointments. */
export function nextAppointmentId(existing: Appointment[]): string {
  let max = 1000;
  for (const a of existing) {
    const m = /^apt-(\d+)$/.exec(a.id);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return `apt-${max + 1}`;
}

/** True if [aStart, aEnd) overlaps [bStart, bEnd). */
export function rangesOverlap(
  aStart: Date, aEnd: Date,
  bStart: Date, bEnd: Date,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}
