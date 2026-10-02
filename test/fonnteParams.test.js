import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FonnteError, mapFonnteSend, parseFonnteData, parseFonnteDelay } from '../src/fonnte/fonnteParams.js';

const now = () => Date.parse('2026-10-03T00:00:00Z');

test('parses fixed and random delays in seconds', () => {
  assert.equal(parseFonnteDelay(undefined)(), 0);
  assert.equal(parseFonnteDelay('5')(), 5000);
  assert.equal(parseFonnteDelay('5-10', () => 0.5)(), 7500);
  assert.throws(() => parseFonnteDelay('ten'), FonnteError);
  assert.throws(() => parseFonnteDelay('10-5'), FonnteError);
});

test('maps a text send with variables, country code and stacked delays', () => {
  const items = mapFonnteSend({ target: '0811|Budi,0812|Ani', message: 'Hai {name}', delay: '2', countryCode: '62' }, { now });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => [item.to, item.type, item.payload.text]), [['0811', 'text', 'Hai Budi'], ['0812', 'text', 'Hai Ani']]);
  assert.equal(items[0].scheduleAt, null);
  assert.equal(items[1].scheduleAt.toISOString(), '2026-10-03T00:00:02.000Z');
  assert.equal(items[0].delayMs, 0);
  assert.equal(items[0].connectOnly, true);
});

test('maps schedule, typing, location, poll and media', () => {
  const [scheduled] = mapFonnteSend({ target: '0811', message: 'x', schedule: String(now() / 1000 + 60), typing: 'true', duration: '3' }, { now });
  assert.equal(scheduled.scheduleAt.toISOString(), '2026-10-03T00:01:00.000Z');
  assert.equal(scheduled.delayMs, 3000);

  const [location] = mapFonnteSend({ target: '0811', location: '-7.98, 112.62' }, { now });
  assert.deepEqual([location.type, location.payload], ['location', { latitude: -7.98, longitude: 112.62 }]);

  const [poll] = mapFonnteSend({ target: '0811', choices: 'A,B,C', select: 'multiple', pollname: 'Pilih' }, { now });
  assert.deepEqual(poll.payload, { name: 'Pilih', options: ['A', 'B', 'C'], selectableCount: 0 });

  const [image] = mapFonnteSend({ target: '0811', message: 'Promo', url: 'https://x.test/a.JPG' }, { now });
  assert.deepEqual([image.type, image.payload, image.media], ['image', { caption: 'Promo' }, 'https://x.test/a.JPG']);

  const [doc] = mapFonnteSend({ target: '0811', url: 'https://x.test/f.pdf', filename: 'Invoice.pdf' }, { now });
  assert.deepEqual([doc.type, doc.payload.fileName], ['document', 'Invoice.pdf']);

  const [upload] = mapFonnteSend({ target: '0811', message: 'Lagu' }, { now, file: { buffer: Buffer.from('a'), mimetype: 'audio/mpeg', originalname: 'a.mp3' } });
  assert.equal(upload.type, 'audio');
});

test('rejects missing targets, empty messages and malformed values', () => {
  assert.throws(() => mapFonnteSend({ message: 'x' }, { now }), { message: 'target invalid' });
  assert.throws(() => mapFonnteSend({ target: '0811' }, { now }), { message: 'input invalid' });
  assert.throws(() => mapFonnteSend({ target: '0811', location: 'nowhere' }, { now }), { message: 'input invalid' });
});

test('parses the data parameter', () => {
  assert.deepEqual(parseFonnteData('[{"target":"0811","message":"1"}]'), [{ target: '0811', message: '1' }]);
  assert.throws(() => parseFonnteData('{bad'), { message: 'JSON format invalid' });
  assert.throws(() => parseFonnteData('{"target":"0811"}'), { message: 'JSON format invalid' });
});
