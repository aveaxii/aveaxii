import { createHash } from "node:crypto";

type ISOString = string;

export type Order = {
  order_id: string;
  patient_id: string;
  tz_offset_minutes: number;
  start_datetime: ISOString;
  end_datetime?: ISOString | null;
  frequency_per_day: number;
  window_minutes: number;
  do_not_overlap_group?: string | null;
  priority: number;
};

export type DoseEvent = {
  event_id: string;
  order_id: string;
  scheduled_time: ISOString;
  status: "SCHEDULED";
};

type ScheduledDose = {
  orderId: string;
  patientId: string;
  group: string | null;
  priority: number;
  utcMs: number;
  tzOffset: number;
  windowMs: number;
};

// constants
const MS_PER_MIN = 60000;
const MS_PER_DAY = 86400000;
const START_HOUR = 8;
const OVERLAP_WINDOW_MS = 60 * MS_PER_MIN;

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const hh = Math.floor(abs / 60);
  const mm = abs % 60;
  return `${sign}${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}`;
}

// example: "2026-01-15" => { y: 2026, m: 1, d: 15 }
function parseYmd(ymd: string): { y: number; m: number; d: number } {
  const [ys, ms, ds] = ymd.split("-");
  const y = Number(ys);
  const m = Number(ms);
  const d = Number(ds);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`invalid start_date: ${ymd}`);
  }
  return { y, m, d };
}

function isIsoWithTz(s: string): boolean {
  return /Z$/.test(s) || /[+\-]\d{2}:\d{2}$/.test(s);
}

function parseIsoInFixedOffset(iso: string, offsetMinutes: number): number {
  if (isIsoWithTz(iso)) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) throw new Error(`invalid iso: ${iso}`);
    return ms;
  }

  const m = iso.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!m) throw new Error(`invalid naive iso: ${iso}`);

  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const ss = m[6] ? Number(m[6]) : 0;

  const utcMs = Date.UTC(y, mo - 1, d, hh, mm, ss) - offsetMinutes * MS_PER_MIN;
  return utcMs;
}

function localMidnightUtcMs(startYmd: string, offsetMinutes: number): number {
  const { y, m, d } = parseYmd(startYmd);
  return Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMinutes * MS_PER_MIN;
}

function toIsoInFixedOffset(utcMs: number, offsetMinutes: number): string {
  const localMs = utcMs + offsetMinutes * MS_PER_MIN;
  const dt = new Date(localMs);

  const y = dt.getUTCFullYear();
  const mo = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  const hh = dt.getUTCHours();
  const mm = dt.getUTCMinutes();
  const ss = dt.getUTCSeconds();

  return `${y}-${mo.toString().padStart(2, '0')}-${d.toString().padStart(2, '0')}T${hh.toString().padStart(2, '0')}:${mm.toString().padStart(2, '0')}:${ss.toString().padStart(2, '0')}${formatOffset(
    offsetMinutes
  )}`;
}

function validateOrder(o: Order): void {
  if (!o.order_id) throw new Error("order_id required");
  if (!o.patient_id) throw new Error("patient_id required");
  if (!Number.isInteger(o.tz_offset_minutes)) throw new Error("tz_offset_minutes must be int");
  if (!Number.isInteger(o.frequency_per_day) || o.frequency_per_day < 1 || o.frequency_per_day > 6) {
    throw new Error("frequency_per_day must be 1..6");
  }
  if (!Number.isInteger(o.priority) || o.priority < 1 || o.priority > 5) {
    throw new Error("priority must be 1..5");
  }
  if (!Number.isInteger(o.window_minutes) || o.window_minutes < 0) {
    throw new Error("window_minutes must be non-negative int");
  }
}

function generateScheduledTimes(
  startDate: string,
  days: number,
  o: Order
): ScheduledDose[] {
  const offset = o.tz_offset_minutes;

  // Global window: calendar days from midnight to midnight
  const globalStartUtc = localMidnightUtcMs(startDate, offset);
  const globalEndUtc = globalStartUtc + days * MS_PER_DAY;

  const orderStartUtc = parseIsoInFixedOffset(o.start_datetime, offset);
  const orderEndUtc =
    o.end_datetime == null ? Number.POSITIVE_INFINITY : parseIsoInFixedOffset(o.end_datetime, offset);

  const effectiveStart = Math.max(globalStartUtc, orderStartUtc);
  const effectiveEnd = Math.min(globalEndUtc, orderEndUtc);

  if (effectiveStart > effectiveEnd) return [];

  const freq = o.frequency_per_day;
  const intervalMin = 1440 / freq;

  const out: ScheduledDose[] = [];

  const firstCycleStart = globalStartUtc + START_HOUR * 60 * MS_PER_MIN;
  const numCycles = days + 1;

  for (let cycleIdx = 0; cycleIdx < numCycles; cycleIdx++) {
    const cycleStartUtc = firstCycleStart + cycleIdx * MS_PER_DAY;

    for (let i = 0; i < freq; i++) {
      // evenly spaced across 24h from 08:00
      const minutesFromCycleStart = Math.round(i * intervalMin);
      const tUtc = cycleStartUtc + minutesFromCycleStart * MS_PER_MIN;

      if (tUtc >= effectiveStart && tUtc <= effectiveEnd) {
        out.push({
          orderId: o.order_id,
          patientId: o.patient_id,
          group: o.do_not_overlap_group ?? null,
          priority: o.priority,
          utcMs: tUtc,
          tzOffset: offset,
          windowMs: o.window_minutes * MS_PER_MIN,
        });
      }
    }
  }

  const seen = new Set<string>();
  return out.filter(d => {
    const key = `${d.orderId}|${d.utcMs}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveOverlaps(doses: ScheduledDose[]): ScheduledDose[] {
  const byKey = new Map<string, ScheduledDose[]>();
  const passthrough: ScheduledDose[] = [];

  for (const d of doses) {
    if (!d.group) {
      passthrough.push(d);
      continue;
    }
    const key = `${d.patientId}::${d.group}`;
    const arr = byKey.get(key);
    if (arr) arr.push(d);
    else byKey.set(key, [d]);
  }

  const kept: ScheduledDose[] = [...passthrough];

  for (const [, groupDoses] of byKey) {
    groupDoses.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      if (a.orderId !== b.orderId) return a.orderId.localeCompare(b.orderId);
      return a.utcMs - b.utcMs;
    });

    const keptByMinute = new Map<number, ScheduledDose>();

    for (const d of groupDoses) {
      const minute = Math.floor(d.utcMs / MS_PER_MIN);
      let hasConflict = false;

      for (let m = minute - 60; m <= minute + 60; m++) {
        const other = keptByMinute.get(m);
        if (!other) continue;
        if (Math.abs(d.utcMs - other.utcMs) < OVERLAP_WINDOW_MS) {
          hasConflict = true;
          break;
        }
      }

      if (!hasConflict) {
        keptByMinute.set(minute, d);
        kept.push(d);
      }
    }
  }

  return kept;
}

export function generateDoseEvents(input: {
  start_date: string;
  days: number;
  orders: Order[];
}): DoseEvent[] {
  const { start_date, days, orders } = input;

  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw new Error("days must be 1..30");
  }

  for (const o of orders) validateOrder(o);

  const allDoses: ScheduledDose[] = [];
  for (const o of orders) {
    allDoses.push(...generateScheduledTimes(start_date, days, o));
  }

  const winners = resolveOverlaps(allDoses);
  winners.sort((a, b) => {
    if (a.utcMs !== b.utcMs) return a.utcMs - b.utcMs;
    return a.orderId.localeCompare(b.orderId);
  });

  const events: DoseEvent[] = winners.map((d) => {
    const scheduled = toIsoInFixedOffset(d.utcMs, d.tzOffset);
    const id = sha256Hex(`${d.orderId}|${scheduled}`);
    return {
      event_id: id,
      order_id: d.orderId,
      scheduled_time: scheduled,
      status: "SCHEDULED",
    };
  });

  return events;
}
