const WINDOW_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Parses "HH:MM-HH:MM" into minutes after midnight. A window may wrap past midnight ("22:00-06:00");
 * equal start and end means always open.
 */
export function parseTimeWindow(value) {
  const match = WINDOW_PATTERN.exec(String(value ?? '').trim());
  if (!match) {
    throw new Error(`Invalid time window "${value}": use HH:MM-HH:MM, e.g. 08:00-20:00`);
  }
  return { start: Number(match[1]) * 60 + Number(match[2]), end: Number(match[3]) * 60 + Number(match[4]) };
}

function minuteOfDay(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  return value('hour') * 60 + value('minute');
}

function isInside(minute, { start, end }) {
  if (start === end) return true;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/**
 * Null when `now` falls inside the window (in `timeZone`), otherwise the moment the window next opens.
 */
export function nextWindowStart(now, window, timeZone) {
  const minute = minuteOfDay(now, timeZone);
  if (isInside(minute, window)) return null;
  const minutesUntil = (window.start - minute + 1440) % 1440;
  const opening = new Date(now.getTime() + minutesUntil * 60000);
  opening.setUTCSeconds(0, 0);
  return opening;
}
