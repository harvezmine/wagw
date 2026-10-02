import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMessageAddress, phoneFromJid } from '../src/utils/jid.js';

test('phoneFromJid strips the server and device parts', () => {
  assert.equal(phoneFromJid('628123456789:12@s.whatsapp.net'), '628123456789');
  assert.equal(phoneFromJid(null), null);
});

test('phone-number chats keep their JID and expose the phone', () => {
  assert.deepEqual(describeMessageAddress({ remoteJid: '628111@s.whatsapp.net' }), {
    remoteJid: '628111@s.whatsapp.net',
    remoteJidAlt: null,
    senderJid: '628111@s.whatsapp.net',
    senderJidAlt: null,
    senderPhone: '628111',
    isGroup: false
  });
});

test('LID chats take the phone number from remoteJidAlt', () => {
  const address = describeMessageAddress({ remoteJid: '123456789@lid', remoteJidAlt: '628222@s.whatsapp.net' });
  assert.equal(address.senderJid, '123456789@lid');
  assert.equal(address.senderJidAlt, '628222@s.whatsapp.net');
  assert.equal(address.senderPhone, '628222');
});

test('group messages use participant and participantAlt', () => {
  const address = describeMessageAddress({ remoteJid: '1203@g.us', participant: '999@lid', participantAlt: '628333@s.whatsapp.net' });
  assert.equal(address.isGroup, true);
  assert.equal(address.remoteJidAlt, null);
  assert.equal(address.senderJid, '999@lid');
  assert.equal(address.senderPhone, '628333');
});
