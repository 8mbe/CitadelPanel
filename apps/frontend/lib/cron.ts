/**
 * A five-field cron expression parser.
 *
 * `minute hour day-of-month month day-of-week`, evaluated in the panel's
 * configured timezone.
 *
 * Hand-rolled rather than pulled from npm because what the backup scheduler
 * needs is small and exactly specified — match a `Date`, describe an expression
 * in English, and compute the next run — while a cron library brings a parser
 * for @-shorthands, seconds fields, `L`/`W`/`#` extensions and its own timezone
 * handling, none of which the operator-facing field should accept. Keeping it
 * here also means the UI and the scheduler agree on what a schedule means,
 * because they call the same function.
 *
 * Shared between client and server on purpose: the settings form validates and
 * previews the next few runs as the operator types, and the scheduler decides
 * what is due — from one implementation, so a schedule can never display one
 * thing and do another.
 */

/** A parsed field: the set of values it matches. */
type FieldSet = ReadonlySet<number>;

export interface CronExpression {
  minute: FieldSet;
  hour: FieldSet;
  dayOfMonth: FieldSet;
  month: FieldSet;
  dayOfWeek: FieldSet;
  /** Whether day-of-month was restricted (i.e. not `*`). */
  domRestricted: boolean;
  /** Whether day-of-week was restricted (i.e. not `*`). */
  dowRestricted: boolean;
  /** The expression as written, normalised to single spaces. */
  source: string;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  /** Names accepted in place of numbers, lowercase, index-aligned to `min`. */
  names?: readonly string[];
}

const MONTH_NAMES = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
] as const;

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const FIELDS: readonly FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MONTH_NAMES },
  { name: "day of week", min: 0, max: 6, names: DAY_NAMES },
];

/** Thrown for an expression a human wrote wrong, with a message for that human. */
export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

/**
 * Parse one field into the set of values it matches.
 *
 * Supports `*`, `a`, `a-b`, `a-b/n`, `*​/n`, and comma-separated lists of those.
 * `7` is accepted for Sunday in the day-of-week field, because crontab has
 * always allowed it and an operator who writes `0 4 * * 7` means Sunday.
 */
function parseField(raw: string, spec: FieldSpec, index: number): { values: Set<number>; restricted: boolean } {
  const text = raw.trim().toLowerCase();
  if (text.length === 0) {
    throw new CronParseError(`The ${spec.name} field is empty.`);
  }

  const values = new Set<number>();
  let restricted = true;

  for (const part of text.split(",")) {
    if (part.length === 0) {
      throw new CronParseError(`The ${spec.name} field has an empty entry in its list.`);
    }

    const [rangeText, stepText] = part.split("/", 2);
    if (part.split("/").length > 2) {
      throw new CronParseError(`"${part}" has more than one step in the ${spec.name} field.`);
    }

    let step = 1;
    if (stepText !== undefined) {
      step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) {
        throw new CronParseError(
          `"${stepText}" is not a valid step in the ${spec.name} field; use a whole number of 1 or more.`,
        );
      }
    }

    let start: number;
    let end: number;

    if (rangeText === "*") {
      start = spec.min;
      end = spec.max;
      // A bare `*` matches everything; `*/n` still restricts the field.
      if (stepText === undefined) restricted = false;
    } else if (rangeText!.includes("-")) {
      const [fromText, toText] = rangeText!.split("-", 2);
      start = parseValue(fromText!, spec, index);
      end = parseValue(toText!, spec, index);
      if (start > end) {
        throw new CronParseError(
          `"${rangeText}" is a backwards range in the ${spec.name} field; write it low-to-high.`,
        );
      }
    } else {
      start = parseValue(rangeText!, spec, index);
      end = stepText === undefined ? start : spec.max;
    }

    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }

  if (values.size === 0) {
    throw new CronParseError(`The ${spec.name} field matches nothing.`);
  }
  return { values, restricted };
}

/** Parse a single number or name within a field, bounds-checked. */
function parseValue(text: string, spec: FieldSpec, index: number): number {
  if (spec.names) {
    const named = spec.names.indexOf(text as (typeof spec.names)[number]);
    if (named !== -1) return named + spec.min;
  }

  const value = Number(text);
  if (!Number.isInteger(value)) {
    throw new CronParseError(
      `"${text}" is not a valid ${spec.name} value.` +
        (spec.names ? ` Use ${spec.min}-${spec.max} or a name like "${spec.names[0]}".` : ""),
    );
  }

  // crontab's long-standing alias: 7 is Sunday, same as 0.
  if (index === 4 && value === 7) return 0;

  if (value < spec.min || value > spec.max) {
    throw new CronParseError(
      `${value} is out of range for the ${spec.name} field (${spec.min}-${spec.max}).`,
    );
  }
  return value;
}

/**
 * Parse a five-field cron expression.
 *
 * Throws {@link CronParseError} with a message meant for the operator who typed
 * it, since this validates a settings field rather than internal input.
 */
export function parseCron(expression: string): CronExpression {
  const source = expression.trim().replace(/\s+/g, " ");
  if (source.length === 0) {
    throw new CronParseError("A schedule is required.");
  }

  const parts = source.split(" ");
  if (parts.length !== 5) {
    throw new CronParseError(
      `A schedule needs exactly 5 fields (minute hour day-of-month month day-of-week); ` +
        `"${source}" has ${parts.length}.`,
    );
  }

  const parsed = FIELDS.map((spec, index) => parseField(parts[index]!, spec, index));

  return {
    minute: parsed[0]!.values,
    hour: parsed[1]!.values,
    dayOfMonth: parsed[2]!.values,
    month: parsed[3]!.values,
    dayOfWeek: parsed[4]!.values,
    domRestricted: parsed[2]!.restricted,
    dowRestricted: parsed[4]!.restricted,
    source,
  };
}

/** Whether an expression is valid, without throwing. */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * `Intl.DateTimeFormat` instances, cached per timezone.
 *
 * Constructing one is expensive relative to using it, and `nextCronRun` calls
 * this thousands of times per search. Uncached, previewing a schedule took tens
 * of seconds; the cache is what makes the scan below viable at all.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** A wall-clock time, already resolved into the target timezone. */
interface LocalParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

/**
 * Break a `Date` into calendar fields *in a given timezone*.
 *
 * Via `Intl.DateTimeFormat` rather than date arithmetic because a fixed UTC
 * offset is wrong twice a year: an operator whose schedule says 04:00 means
 * 04:00 local across a DST boundary, not 03:00 for half the year. `Intl` is the
 * only thing in the platform that knows the zone's rules.
 */
function localParts(date: Date, timeZone: string): LocalParts {
  const formatter = formatterFor(timeZone);

  const fields: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    fields[part.type] = part.value;
  }

  // `hour12: false` renders midnight as "24" in some ICU versions; normalise it.
  const hour = Number(fields.hour) % 24;

  return {
    minute: Number(fields.minute),
    hour,
    dayOfMonth: Number(fields.day),
    month: Number(fields.month),
    dayOfWeek: DAY_NAMES.indexOf(
      (fields.weekday ?? "").slice(0, 3).toLowerCase() as (typeof DAY_NAMES)[number],
    ),
  };
}

/**
 * Whether a cron expression matches a given instant, in a given timezone.
 *
 * The day-of-month / day-of-week rule follows POSIX crontab, which is not the
 * intersection people expect: when *both* fields are restricted the day matches
 * if *either* does. So `0 4 1 * mon` means "the 1st, and also every Monday", not
 * "Mondays that fall on the 1st". Matching real cron here is deliberate — an
 * operator's expression must do what its manpage says it does.
 */
export function cronMatches(
  expression: CronExpression,
  date: Date,
  timeZone: string,
): boolean {
  const parts = localParts(date, timeZone);
  return (
    dateFieldsMatch(expression, parts) &&
    expression.hour.has(parts.hour) &&
    expression.minute.has(parts.minute)
  );
}

/**
 * Whether the calendar-day fields match, ignoring the time of day.
 *
 * Split out because it is the predicate `nextCronRun` skips whole days on: the
 * day fields cannot change within a day, so a non-matching day has no matching
 * minute in it.
 */
function dateFieldsMatch(expression: CronExpression, parts: LocalParts): boolean {
  if (!expression.month.has(parts.month)) return false;

  const domMatch = expression.dayOfMonth.has(parts.dayOfMonth);
  const dowMatch = expression.dayOfWeek.has(parts.dayOfWeek);

  if (expression.domRestricted && expression.dowRestricted) return domMatch || dowMatch;
  if (expression.domRestricted) return domMatch;
  if (expression.dowRestricted) return dowMatch;
  return true;
}

/**
 * The next instant after `from` that the expression matches.
 *
 * Searches forward rather than solving for the answer: a closed-form "next
 * match" has to special-case the either-or day rule, DST gaps where a local time
 * does not exist, and DST overlaps where one happens twice. Stepping avoids all
 * three, because every candidate is re-resolved through the timezone.
 *
 * The step size is coarsened by what has already been ruled out. A day whose
 * calendar fields do not match contains no match, so the cursor jumps to the
 * start of the next local day; an hour that does not match contains no match, so
 * it jumps to the next hour. Only inside a matching day and hour does it step
 * minute by minute. That turns a `29 feb` search from ~800k timezone conversions
 * into a few thousand. Each jump is bounded by the remainder of a unit proven
 * empty, so no match can be skipped — a DST shift merely means the next
 * iteration re-decides.
 *
 * Four years is the bound: the only multi-year cycle in the fields is Feb 29, so
 * an expression matching nothing in four years matches nothing at all.
 */
export function nextCronRun(
  expression: CronExpression,
  from: Date,
  timeZone: string,
): Date | null {
  // Start from the next whole minute: a match at `from`'s own minute has either
  // already fired or is the caller's current tick.
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);

  const deadline = from.getTime() + 4 * 366 * 24 * 60 * 60_000;

  while (cursor.getTime() <= deadline) {
    const parts = localParts(cursor, timeZone);

    if (!dateFieldsMatch(expression, parts)) {
      // Skip to local 00:00 tomorrow.
      cursor.setUTCMinutes(cursor.getUTCMinutes() + (1440 - (parts.hour * 60 + parts.minute)));
      continue;
    }
    if (!expression.hour.has(parts.hour)) {
      cursor.setUTCMinutes(cursor.getUTCMinutes() + (60 - parts.minute));
      continue;
    }
    if (expression.minute.has(parts.minute)) {
      return new Date(cursor.getTime());
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

/**
 * Describe an expression in English, for the settings form.
 *
 * Covers the shapes an operator actually types and falls back to echoing the
 * expression rather than producing a strained sentence for an exotic one — a
 * wrong plain-English gloss is worse than none, because it invites trust.
 */
export function describeCron(expression: CronExpression): string {
  const { minute, hour, dayOfMonth, month, dayOfWeek, domRestricted, dowRestricted } = expression;

  const everyMinute = minute.size === 60;
  const everyHour = hour.size === 24;
  const everyMonth = month.size === 12;

  const at = () => {
    const times = [...hour].sort((a, b) => a - b).flatMap((h) =>
      [...minute].sort((a, b) => a - b).map((m) => `${pad(h)}:${pad(m)}`),
    );
    return times.length <= 4 ? times.join(", ") : `${times.length} times a day`;
  };

  if (everyMinute && everyHour) return "Every minute";
  if (everyMinute) return `Every minute during ${[...hour].sort((a, b) => a - b).map(pad).join(", ")}:00`;

  if (everyHour) {
    const mins = [...minute].sort((a, b) => a - b);
    return mins.length === 1
      ? `Every hour at :${pad(mins[0]!)}`
      : `Every hour at ${mins.map((m) => `:${pad(m)}`).join(", ")}`;
  }

  const when = at();

  if (!domRestricted && !dowRestricted && everyMonth) return `Every day at ${when}`;

  if (dowRestricted && !domRestricted) {
    const days = [...dayOfWeek].sort((a, b) => a - b).map((d) => DAY_LABELS[d]!);
    const label =
      days.length === 7
        ? "day"
        : days.length === 5 && !dayOfWeek.has(0) && !dayOfWeek.has(6)
          ? "weekday"
          : days.join(", ");
    return `Every ${label} at ${when}`;
  }

  if (domRestricted && !dowRestricted) {
    const days = [...dayOfMonth].sort((a, b) => a - b);
    const dayLabel =
      days.length === 1 ? `day ${days[0]}` : `days ${days.join(", ")}`;
    return everyMonth
      ? `On ${dayLabel} of every month at ${when}`
      : `On ${dayLabel} of ${[...month].sort((a, b) => a - b).map((m) => MONTH_LABELS[m - 1]).join(", ")} at ${when}`;
  }

  return `At ${when}, per "${expression.source}"`;
}

const DAY_LABELS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Ready-made schedules the settings form offers, so nobody has to write cron. */
export const CRON_PRESETS = [
  { label: "Every day at 04:00", value: "0 4 * * *" },
  { label: "Every day at 04:00 and 16:00", value: "0 4,16 * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Every Sunday at 03:00", value: "0 3 * * sun" },
  { label: "Every Monday at 05:00", value: "0 5 * * mon" },
  { label: "On the 1st of each month at 02:00", value: "0 2 1 * *" },
] as const;
