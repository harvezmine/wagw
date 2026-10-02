import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFonnteWebhook } from '../src/fonnte/fonnteWebhook.js';

const device = '628100000000';

test('incoming personal and group messages use Fonnte field names', () => {
  const personal = toFonnteWebhook('message.received', {
    messageId: 'M1', remoteJid: '62811@s.whatsapp.net', senderJid: '62811@s.whatsapp.net', senderPhone: '62811',
    fromMe: false, pushName: 'Budi', isGroup: false, messageType: 'text', content: 'Halo', media: null,
    timestamp: '2026-10-03T00:00:00.000Z'
  }, { device });
  assert.deepEqual(personal, {
    device, sender: '62811', message: 'Halo', text: 'Halo', member: '', name: 'Budi', location: '',
    pollname: '', choices: '', filename: '', extension: '', inboxid: 'M1', timestamp: 1790985600
  });

  const group = toFonnteWebhook('message.received', {
    messageId: 'M2', remoteJid: '1203@g.us', senderJid: '999@lid', senderPhone: '62822', fromMe: false, pushName: 'Ani',
    isGroup: true, messageType: 'location', content: '', media: { degreesLatitude: 1.5, degreesLongitude: 2.5 },
    timestamp: '2026-10-03T00:00:00.000Z'
  }, { device });
  assert.equal(group.sender, '1203@g.us');
  assert.equal(group.member, '62822');
  assert.equal(group.location, '1.5,2.5');
});

test('own messages and unsupported events are not forwarded', () => {
  assert.equal(toFonnteWebhook('message.received', { fromMe: true }, { device }), null);
  assert.equal(toFonnteWebhook('connection.update', { status: 'qr_ready' }, { device }), null);
  assert.equal(toFonnteWebhook('account.restriction', {}, { device }), null);
});

test('status and connection events', () => {
  assert.deepEqual(toFonnteWebhook('message.status', { queueId: 42, messageId: 'M1', status: 'sent' }, { device }),
    { device, id: '42', stateid: 'M1', status: 'sent' });
  assert.deepEqual(toFonnteWebhook('message.status', { queueId: 42, messageId: 'M1', status: 'read' }, { device }),
    { device, id: '42', stateid: 'M1', state: 'read' });
  const connected = toFonnteWebhook('connection.update', { status: 'connected', phoneNumber: '62899' }, { device: null });
  assert.equal(connected.device, '62899');
  assert.equal(connected.status, 'connect');
  const lost = toFonnteWebhook('connection.update', { status: 'reconnecting', disconnectReason: 'connection_lost' }, { device });
  assert.deepEqual([lost.status, lost.reason], ['disconnect', 'connection_lost']);
});
