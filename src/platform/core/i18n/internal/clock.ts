/** A moment in the machine's local time zone: `2026-10-08 00:30:00+03` (`Z` at UTC, `+0530` for a half-hour zone), so the person reads their own clock and the offset says which. */
export function clockText(ms: number): string {
  const date = new Date(ms), pad = (value: number) => String(value).padStart(2, '0');
  const east = -date.getTimezoneOffset(), minutes = Math.abs(east) % 60;
  const zone = east === 0 ? 'Z' : `${east < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(east) / 60))}${minutes ? pad(minutes) : ''}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${zone}`;
}
