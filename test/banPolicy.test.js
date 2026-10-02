import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeBan } from '../src/services/banPolicy.js';

const now = () => Date.parse('2026-10-03T00:00:00Z');

test('describes temporary bans with reason and expiry', () => {
  assert.deepEqual(describeBan(402, { code: '101', expire: '3600' }, now), {
    permanent: false,
    code: 101,
    reason: 'sent too many messages to people who do not have this number in their address book',
    expiresAt: new Date('2026-10-03T01:00:00Z')
  });
  assert.deepEqual(describeBan(402, {}, now), { permanent: false, code: null, reason: 'temporarily banned by WhatsApp', expiresAt: null });
});

test('describes permanent bans and ignores other codes', () => {
  assert.equal(describeBan(406, {}, now).permanent, true);
  assert.equal(describeBan(428, {}, now), null);
});
