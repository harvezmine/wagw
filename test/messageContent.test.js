import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessageContent, buildVcard, historyText, parseMessageInput, presenceFor } from '../src/services/messageContent.js';

test('defaults to a text message and requires text', () => {
  assert.deepEqual(parseMessageInput({ text: 'Halo' }), { type: 'text', payload: { text: 'Halo' }, media: null });
  assert.throws(() => parseMessageInput({}), { status: 400 });
  assert.throws(() => parseMessageInput({ type: 'fax', text: 'x' }), { status: 400 });
});

test('media messages need a URL, base64 or upload and keep caption/fileName/mimetype', () => {
  const doc = parseMessageInput({ type: 'document', caption: 'Invoice', media: { url: 'https://x.test/a.pdf', fileName: 'a.pdf' } });
  assert.deepEqual(doc, { type: 'document', payload: { caption: 'Invoice', fileName: 'a.pdf' }, media: 'https://x.test/a.pdf' });
  const upload = parseMessageInput({ type: 'image' }, { file: { buffer: Buffer.from('img'), mimetype: 'image/png', originalname: 'p.png' } });
  assert.deepEqual(upload.payload, { mimetype: 'image/png' });
  assert.ok(Buffer.isBuffer(upload.media));
  assert.deepEqual(parseMessageInput({ type: 'voice', caption: 'ignored', media: { url: 'https://x.test/v.ogg' } }).payload, {});
  assert.throws(() => parseMessageInput({ type: 'image' }), { status: 400 });
});

test('location, contact and poll are validated', () => {
  assert.deepEqual(parseMessageInput({ type: 'location', location: { latitude: '-6.2', longitude: 106.8, name: 'Kantor' } }).payload,
    { latitude: -6.2, longitude: 106.8, name: 'Kantor' });
  assert.throws(() => parseMessageInput({ type: 'location', location: { latitude: 91, longitude: 0 } }), { status: 400 });

  assert.deepEqual(parseMessageInput({ type: 'contact', contact: { name: 'Budi', phone: '0812-3456-789' } }, { countryCode: '62' }).payload,
    { contacts: [{ name: 'Budi', phone: '628123456789' }] });
  assert.throws(() => parseMessageInput({ type: 'contact', contacts: [] }), { status: 400 });

  assert.deepEqual(parseMessageInput({ type: 'poll', poll: { name: 'Menu?', options: ['A', 'B'] } }).payload,
    { name: 'Menu?', options: ['A', 'B'], selectableCount: 1 });
  assert.throws(() => parseMessageInput({ type: 'poll', poll: { name: 'x', options: ['A'] } }), { status: 400 });
  assert.throws(() => parseMessageInput({ type: 'poll', poll: { name: 'x', options: ['A', 'A'] } }), { status: 400 });
});

test('reaction, edit and delete target a messageId', () => {
  assert.deepEqual(parseMessageInput({ type: 'reaction', messageId: 'ABC', emoji: '👍' }).payload, { messageId: 'ABC', emoji: '👍' });
  assert.deepEqual(parseMessageInput({ type: 'reaction', messageId: 'ABC' }).payload, { messageId: 'ABC', emoji: '' });
  assert.deepEqual(parseMessageInput({ type: 'edit', messageId: 'ABC', text: 'fixed' }).payload, { messageId: 'ABC', text: 'fixed' });
  assert.deepEqual(parseMessageInput({ type: 'delete', messageId: 'ABC' }).payload, { messageId: 'ABC' });
  assert.throws(() => parseMessageInput({ type: 'delete' }), { status: 400 });
});

test('builds Baileys content for every type', () => {
  const media = { buffer: Buffer.from('x'), contentType: 'audio/mpeg' };
  const key = { remoteJid: '62811@s.whatsapp.net', fromMe: true, id: 'ABC' };
  assert.deepEqual(buildMessageContent('text', { text: 'hi', mentions: ['62811@s.whatsapp.net'] }), { text: 'hi', mentions: ['62811@s.whatsapp.net'] });
  assert.deepEqual(buildMessageContent('voice', {}, { media }), { audio: media.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true });
  assert.deepEqual(buildMessageContent('audio', {}, { media }), { audio: media.buffer, mimetype: 'audio/mpeg', ptt: false });
  assert.deepEqual(buildMessageContent('location', { latitude: 1, longitude: 2, name: 'N' }),
    { location: { degreesLatitude: 1, degreesLongitude: 2, name: 'N', address: undefined } });
  assert.deepEqual(buildMessageContent('poll', { name: 'Q', options: ['A', 'B'], selectableCount: 1 }), { poll: { name: 'Q', values: ['A', 'B'], selectableCount: 1 } });
  assert.deepEqual(buildMessageContent('reaction', { emoji: '👍' }, { key }), { react: { text: '👍', key } });
  assert.deepEqual(buildMessageContent('edit', { text: 'new' }, { key }), { text: 'new', edit: key });
  assert.deepEqual(buildMessageContent('delete', {}, { key }), { delete: key });
  const contact = buildMessageContent('contact', { contacts: [{ name: 'Budi', phone: '62811' }] });
  assert.equal(contact.contacts.displayName, 'Budi');
  assert.match(contact.contacts.contacts[0].vcard, /waid=62811:\+62811/);
});

test('presence, history text and vCard helpers', () => {
  assert.equal(presenceFor('text'), 'composing');
  assert.equal(presenceFor('voice'), 'recording');
  assert.equal(presenceFor('reaction'), null);
  assert.equal(historyText('document', { fileName: 'a.pdf' }), 'a.pdf');
  assert.equal(historyText('location', { latitude: 1, longitude: 2 }), '1,2');
  assert.equal(buildVcard({ name: 'A\nB', phone: '62811' }).split('\n')[2], 'FN:A B');
});
