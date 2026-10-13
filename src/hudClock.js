/**
 * HUD wall clocks (REC timestamp, COLL time) in the viewer's local time,
 * labelled with the UTC offset so the reading stays unambiguous. Feed and
 * card times elsewhere stay in UTC (`Z`).
 */

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * The local UTC offset of `date` as a label: `UTC`, `UTC+2`, `UTC-5`,
 * `UTC+5:30`.
 * @param {Date} date
 * @returns {string}
 */
export function formatUtcOffset(date) {
  const minutes = -date.getTimezoneOffset();
  if (minutes === 0) return 'UTC';
  const sign = minutes > 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return `UTC${sign}${hours}${rest ? `:${pad2(rest)}` : ''}`;
}

/**
 * Local time of day as `HH:MM:SS`.
 * @param {Date} date
 * @returns {string}
 */
export function formatLocalTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

/**
 * Local date and time with its offset, e.g. `2026-10-13 18:17:42 UTC+2`.
 * @param {Date} date
 * @returns {string}
 */
export function formatLocalTimestamp(date) {
  const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  return `${day} ${formatLocalTime(date)} ${formatUtcOffset(date)}`;
}
