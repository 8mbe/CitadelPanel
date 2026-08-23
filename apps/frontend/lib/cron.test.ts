/**
 * Tests for the cron parser.
 *
 * This decides when a fleet's backups run, so the cases that matter are the ones
 * where being subtly wrong means a backup silently never fires: the POSIX
 * either-or day rule, timezone evaluation across a DST boundary, and step
 * syntax. The error messages are tested too, because they are shown to the
 * operator who typed the expression.
 */

import { describe, expect, test } from "bun:test";
import {
  CronParseError,
  cronMatches,
  describeCron,
  isValidCron,
  nextCronRun,
  parseCron,
} from "./cron";

const utc = (iso: string) => new Date(iso);

describe("parseCron", () => {
  test("parses a plain daily schedule", () => {
    const cron = parseCron("0 4 * * *");
    expect([...cron.minute]).toEqual([0]);
    expect([...cron.hour]).toEqual([4]);
    expect(cron.domRestricted).toBe(false);
    expect(cron.dowRestricted).toBe(false);
  });

  test("normalises whitespace into the recorded source", () => {
    expect(parseCron("  0   4  *  *  * ").source).toBe("0 4 * * *");
  });

  test("parses lists, ranges and steps", () => {
    const cron = parseCron("0,30 9-17/4 * * *");
    expect([...cron.minute].sort((a, b) => a - b)).toEqual([0, 30]);
    expect([...cron.hour].sort((a, b) => a - b)).toEqual([9, 13, 17]);
  });

  test("*/n restricts the field even though it starts with a star", () => {
    const cron = parseCron("0 */6 * * *");
    expect([...cron.hour].sort((a, b) => a - b)).toEqual([0, 6, 12, 18]);
  });

  test("accepts month and day names", () => {
    const cron = parseCron("0 3 * jan,jul mon-fri");
    expect([...cron.month].sort((a, b) => a - b)).toEqual([1, 7]);
    expect([...cron.dayOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test("treats 7 as Sunday, the way crontab always has", () => {
    expect([...parseCron("0 4 * * 7").dayOfWeek]).toEqual([0]);
    expect([...parseCron("0 4 * * 0").dayOfWeek]).toEqual([0]);
  });

  test("rejects the wrong number of fields with a message naming the count", () => {
    expect(() => parseCron("0 4 * *")).toThrow(/exactly 5 fields/);
    expect(() => parseCron("0 4 * * * *")).toThrow(/has 6/);
  });

  test("rejects an out-of-range value naming the field and its range", () => {
    expect(() => parseCron("0 25 * * *")).toThrow(/out of range for the hour field \(0-23\)/);
    expect(() => parseCron("60 4 * * *")).toThrow(/minute field/);
    expect(() => parseCron("0 4 32 * *")).toThrow(/day of month/);
  });

  test("rejects a backwards range rather than matching nothing", () => {
    expect(() => parseCron("0 17-9 * * *")).toThrow(/backwards range/);
  });

  test("rejects a zero or fractional step", () => {
    expect(() => parseCron("0 */0 * * *")).toThrow(/valid step/);
    expect(() => parseCron("0 */1.5 * * *")).toThrow(/valid step/);
  });

  test("rejects gibberish in a field", () => {
    expect(() => parseCron("0 4 * * funday")).toThrow(/not a valid day of week/);
  });

  test("rejects an empty expression", () => {
    expect(() => parseCron("   ")).toThrow(/schedule is required/);
  });

  test("throws CronParseError so callers can distinguish operator error", () => {
    expect(() => parseCron("nope")).toThrow(CronParseError);
  });
});

describe("isValidCron", () => {
  test("reports validity without throwing", () => {
    expect(isValidCron("0 4 * * *")).toBe(true);
    expect(isValidCron("0 99 * * *")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });
});

describe("cronMatches", () => {
  test("matches the configured minute in the configured timezone", () => {
    const cron = parseCron("0 4 * * *");
    // 04:00 in Berlin (UTC+2 in August) is 02:00 UTC.
    expect(cronMatches(cron, utc("2026-08-19T02:00:00Z"), "Europe/Berlin")).toBe(true);
    expect(cronMatches(cron, utc("2026-08-19T04:00:00Z"), "Europe/Berlin")).toBe(false);
    // The same instant is 04:00 UTC for a UTC panel.
    expect(cronMatches(cron, utc("2026-08-19T04:00:00Z"), "UTC")).toBe(true);
  });

  test("follows the local clock across a DST boundary, not a fixed offset", () => {
    const cron = parseCron("0 4 * * *");
    // Berlin is UTC+2 in summer and UTC+1 in winter; 04:00 local is a different
    // UTC instant in each, which a fixed-offset implementation would get wrong.
    expect(cronMatches(cron, utc("2026-08-19T02:00:00Z"), "Europe/Berlin")).toBe(true);
    expect(cronMatches(cron, utc("2026-01-19T03:00:00Z"), "Europe/Berlin")).toBe(true);
    expect(cronMatches(cron, utc("2026-01-19T02:00:00Z"), "Europe/Berlin")).toBe(false);
  });

  test("matches midnight, which some hour formatters render as 24", () => {
    const cron = parseCron("0 0 * * *");
    expect(cronMatches(cron, utc("2026-08-19T00:00:00Z"), "UTC")).toBe(true);
  });

  test("restricting only day-of-week ignores day-of-month", () => {
    const cron = parseCron("0 3 * * wed");
    // 2026-08-19 is a Wednesday.
    expect(cronMatches(cron, utc("2026-08-19T03:00:00Z"), "UTC")).toBe(true);
    expect(cronMatches(cron, utc("2026-08-20T03:00:00Z"), "UTC")).toBe(false);
  });

  test("restricting only day-of-month ignores day-of-week", () => {
    const cron = parseCron("0 2 1 * *");
    expect(cronMatches(cron, utc("2026-09-01T02:00:00Z"), "UTC")).toBe(true);
    expect(cronMatches(cron, utc("2026-09-02T02:00:00Z"), "UTC")).toBe(false);
  });

  test("restricting BOTH day fields is a union, per POSIX crontab", () => {
    // "0 4 1 * mon" means the 1st, and also every Monday, not their
    // intersection. Getting this backwards would silently skip most runs.
    const cron = parseCron("0 4 1 * mon");
    // 2026-09-01 is a Tuesday: matches on day-of-month alone.
    expect(cronMatches(cron, utc("2026-09-01T04:00:00Z"), "UTC")).toBe(true);
    // 2026-09-07 is a Monday: matches on day-of-week alone.
    expect(cronMatches(cron, utc("2026-09-07T04:00:00Z"), "UTC")).toBe(true);
    // 2026-09-08 is a Tuesday and not the 1st: no match.
    expect(cronMatches(cron, utc("2026-09-08T04:00:00Z"), "UTC")).toBe(false);
  });

  test("honours the month field", () => {
    const cron = parseCron("0 4 * jan *");
    expect(cronMatches(cron, utc("2026-01-19T04:00:00Z"), "UTC")).toBe(true);
    expect(cronMatches(cron, utc("2026-08-19T04:00:00Z"), "UTC")).toBe(false);
  });
});

describe("nextCronRun", () => {
  test("finds the next daily run", () => {
    const cron = parseCron("0 4 * * *");
    const next = nextCronRun(cron, utc("2026-08-19T05:00:00Z"), "UTC");
    expect(next?.toISOString()).toBe("2026-08-20T04:00:00.000Z");
  });

  test("never returns the instant it was given", () => {
    const cron = parseCron("0 4 * * *");
    const from = utc("2026-08-19T04:00:00Z");
    expect(nextCronRun(cron, from, "UTC")?.getTime()).toBeGreaterThan(from.getTime());
  });

  test("resolves in the panel's timezone", () => {
    const cron = parseCron("0 4 * * *");
    const next = nextCronRun(cron, utc("2026-08-19T05:00:00Z"), "Europe/Berlin");
    // Next 04:00 Berlin after 07:00 Berlin is the following day = 02:00 UTC.
    expect(next?.toISOString()).toBe("2026-08-20T02:00:00.000Z");
  });

  test("skips to the next matching weekday", () => {
    const cron = parseCron("0 3 * * sun");
    // 2026-08-19 is a Wednesday; the next Sunday is the 23rd.
    const next = nextCronRun(cron, utc("2026-08-19T12:00:00Z"), "UTC");
    expect(next?.toISOString()).toBe("2026-08-23T03:00:00.000Z");
  });

  test("handles a Feb 29 schedule by finding the next leap year", () => {
    const cron = parseCron("0 4 29 feb *");
    const next = nextCronRun(cron, utc("2026-08-19T00:00:00Z"), "UTC");
    expect(next?.toISOString()).toBe("2028-02-29T04:00:00.000Z");
  });
});

describe("describeCron", () => {
  test("describes common schedules in plain English", () => {
    expect(describeCron(parseCron("0 4 * * *"))).toBe("Every day at 04:00");
    expect(describeCron(parseCron("0 4,16 * * *"))).toBe("Every day at 04:00, 16:00");
    expect(describeCron(parseCron("0 3 * * sun"))).toBe("Every Sunday at 03:00");
    expect(describeCron(parseCron("0 2 1 * *"))).toBe("On day 1 of every month at 02:00");
  });

  test("recognises weekdays as a group", () => {
    expect(describeCron(parseCron("30 6 * * mon-fri"))).toBe("Every weekday at 06:30");
  });

  test("describes hourly schedules by the minute they fire on", () => {
    expect(describeCron(parseCron("15 * * * *"))).toBe("Every hour at :15");
  });

  test("falls back to echoing the expression rather than inventing a gloss", () => {
    // Both day fields restricted is a union rule that no short sentence states
    // accurately, so the description defers to the expression itself.
    expect(describeCron(parseCron("0 4 1 * mon"))).toContain('per "0 4 1 * mon"');
  });
});
