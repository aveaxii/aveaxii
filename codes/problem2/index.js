const DEFAULT_ALLOWLIST = new Set(["LIS", "HIS"]);
const FIVE_MINUTES_MS = 5 * 60 * 1000;

function pad2(value) {
  return String(value).padStart(2, "0");
}

function pad3(value) {
  return String(value).padStart(3, "0");
}

function parseOffset(iso) {
  if (iso.endsWith("Z") || iso.endsWith("z")) {
    return { minutes: 0, suffix: "Z" };
  }
  const match = iso.match(/([+-])(\d{2}):?(\d{2})$/);
  if (!match) {
    return null;
  }
  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const total = sign * (hours * 60 + minutes);
  const suffix = `${match[1]}${match[2]}:${match[3]}`;
  return { minutes: total, suffix };
}

function formatWithOffset(ms, offsetMinutes, suffix) {
  const shifted = ms + offsetMinutes * 60 * 1000;
  const d = new Date(shifted);
  const year = d.getUTCFullYear();
  const month = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const hours = pad2(d.getUTCHours());
  const minutes = pad2(d.getUTCMinutes());
  const seconds = pad2(d.getUTCSeconds());
  const millis = pad3(d.getUTCMilliseconds());
  if (suffix === "Z") {
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}Z`;
  }
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${millis}${suffix}`;
}

function roundToFiveMinutesIso(iso) {
  const ms = new Date(iso).getTime();
  const rounded = Math.round(ms / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
  const offset = parseOffset(iso);
  if (!offset) {
    return new Date(rounded).toISOString();
  }
  return formatWithOffset(rounded, offset.minutes, offset.suffix);
}

function buildKey(
  patientId,
  code,
  roundedEffective,
  unit
) {
  const sep = "\u0000";
  return `${String(patientId)}${sep}${code}${sep}${roundedEffective}${sep}${unit}`;
}

function isPlainIntegerString(value) {
  return /^-?(0|[1-9]\d*)$/.test(value);
}

function comparePatientId(
  left,
  right
) {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  const leftStr = String(left);
  const rightStr = String(right);
  const leftNum = Number(leftStr);
  const rightNum = Number(rightStr);
  const leftIsInt = isPlainIntegerString(leftStr);
  const rightIsInt = isPlainIntegerString(rightStr);

  if (leftIsInt && rightIsInt && Number.isFinite(leftNum) && Number.isFinite(rightNum)) {
    if (leftNum !== rightNum) {
      return leftNum - rightNum;
    }
  }

  return leftStr.localeCompare(rightStr);
}

export function normalizeObservations(
  observations,
  allowlist = DEFAULT_ALLOWLIST
) {
  const allowlistSet =
    allowlist instanceof Set ? allowlist : new Set(allowlist);
  const map = new Map();

  for (const obs of observations) {
    const roundedEffective = roundToFiveMinutesIso(obs.effective_datetime);
    const key = buildKey(obs.patient_id, obs.code, roundedEffective, obs.unit);
    const next = {
      ...obs,
      effective_datetime: roundedEffective,
    };

    const current = map.get(key);
    if (!current) {
      map.set(key, next);
      continue;
    }

    const currentAllow = allowlistSet.has(current.source);
    const nextAllow = allowlistSet.has(next.source);

    if (currentAllow && !nextAllow) {
      continue;
    }
    if (nextAllow && !currentAllow) {
      map.set(key, next);
      continue;
    }

    const currentIngested = new Date(current.ingested_at).getTime();
    const nextIngested = new Date(next.ingested_at).getTime();
    if (nextIngested >= currentIngested) {
      map.set(key, next);
    }
  }

  const normalized = Array.from(map.values());
  normalized.sort((a, b) => {
    const patientOrder = comparePatientId(a.patient_id, b.patient_id);
    if (patientOrder !== 0) {
      return patientOrder;
    }
    if (a.code !== b.code) {
      return a.code.localeCompare(b.code);
    }
    return a.effective_datetime.localeCompare(b.effective_datetime);
  });

  return normalized;
}
