/** ISO local time with an explicit offset; callers retain their chosen timezone. */
export function localIso(date: Date, timeZone = 'Asia/Shanghai'): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit',
    hourCycle:'h23', timeZoneName:'longOffset',
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  const offset = (parts.timeZoneName ?? 'GMT+00:00').replace('GMT', '') || '+00:00';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}
