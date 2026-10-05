/**
 * Zone for the "local" time in helper output: `LOCAL_TIME_ZONE` (an IANA name), otherwise UTC.
 * An invalid name throws here, so a helper that calls this first fails before any network
 * call or long-running step, not when it finally formats a timestamp.
 */
export function localTimeZone(env: Record<string, string | undefined> = process.env): string {
  const zone = env.LOCAL_TIME_ZONE?.trim() || 'UTC';
  try { new Intl.DateTimeFormat('en-CA', {timeZone: zone}); }
  catch { throw new Error(`Invalid LOCAL_TIME_ZONE: ${zone}`); }
  return zone;
}

/** ISO local time with an explicit offset, in the selected zone unless a caller passes one. */
export function localIso(date: Date, timeZone = localTimeZone()): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    hourCycle:'h23', timeZoneName:'longOffset',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const offset = (parts.timeZoneName ?? 'GMT+00:00').replace('GMT', '') || '+00:00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}
