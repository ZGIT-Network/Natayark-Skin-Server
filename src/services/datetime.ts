import { Temporal } from '@js-temporal/polyfill';

/** Preserve the legacy local DATETIME format, using the offset at each instant. */
export function formatLocalDate(date: Date, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime()).toZonedDateTimeISO(timeZone)
    .toPlainDateTime().toString({ smallestUnit: 'second' }).replace('T', ' ');
}

export function parseLocalDate(value: string, timeZone: string): number {
  try {
    // Legacy DATETIME cannot distinguish the two occurrences of a repeated hour.
    // Use Temporal's compatible policy: earlier in a fold, forward in a gap.
    return Temporal.PlainDateTime.from(value.replace(' ', 'T'))
      .toZonedDateTime(timeZone, { disambiguation: 'compatible' }).epochMilliseconds;
  } catch { return NaN; }
}
