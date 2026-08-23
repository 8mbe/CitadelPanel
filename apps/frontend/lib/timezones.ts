"use client";

/**
 * The IANA timezone names the setup wizard and admin settings offer.
 *
 * Sourced from the runtime's own tz database via `Intl.supportedValuesOf` when
 * the browser exposes it, so the list matches what the backend will accept
 * (both validate against the same underlying database). A curated fallback keeps
 * the control usable on older engines that lack `supportedValuesOf`. It is not
 * exhaustive, but the field also accepts a typed value the backend validates.
 */

const FALLBACK_ZONES = [
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Europe/Moscow",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

export function listTimezones(): string[] {
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  try {
    const zones = intl.supportedValuesOf?.("timeZone");
    if (zones && zones.length > 0) {
      // Keep UTC pinned to the top; it is the panel default.
      return ["UTC", ...zones.filter((zone) => zone !== "UTC")];
    }
  } catch {
    // Fall through to the curated list.
  }
  return FALLBACK_ZONES;
}

/**
 * The browser's best guess at the local timezone, used to preselect a sensible
 * default. Returns "UTC" if it cannot be determined.
 */
export function guessTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
