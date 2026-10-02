import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextWindowStart, parseTimeWindow } from '../src/utils/timeWindow.js';

const JAKARTA = 'Asia/Jakarta';
const window = parseTimeWindow('08:00-20:00');

test('parses HH:MM-HH:MM windows and rejects malformed ones', () => {
  assert.deepEqual(window, { start: 480, end: 1200 });
  assert.deepEqual(parseTimeWindow('22:00-06:00'), { start: 1320, end: 360 });
  assert.throws(() => parseTimeWindow('8-20'), /Invalid time window/);
  assert.throws(() => parseTimeWindow('25:00-26:00'), /Invalid time window/);
});

test('returns null inside the window and the next opening outside it', () => {
  assert.equal(nextWindowStart(new Date('2026-10-03T05:00:00Z'), window, JAKARTA), null); // 12:00 WIB
  assert.equal(nextWindowStart(new Date('2026-10-03T00:30:00Z'), window, JAKARTA).toISOString(), '2026-10-03T01:00:00.000Z'); // 07:30 WIB
  assert.equal(nextWindowStart(new Date('2026-10-03T13:00:00Z'), window, JAKARTA).toISOString(), '2026-10-04T01:00:00.000Z'); // 20:00 WIB
});

test('supports windows that wrap past midnight and always-open windows', () => {
  const night = parseTimeWindow('22:00-06:00');
  assert.equal(nextWindowStart(new Date('2026-10-03T16:00:00Z'), night, JAKARTA), null); // 23:00 WIB
  assert.equal(nextWindowStart(new Date('2026-10-03T05:00:00Z'), night, JAKARTA).toISOString(), '2026-10-03T15:00:00.000Z'); // 12:00 -> 22:00 WIB
  assert.equal(nextWindowStart(new Date('2026-10-03T05:00:00Z'), parseTimeWindow('00:00-00:00'), JAKARTA), null);
});
