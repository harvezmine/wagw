import { AppError } from '../utils/errors.js';
import { normalizePhoneNumber } from '../utils/phone.js';

export const MEDIA_TYPES = ['image', 'video', 'audio', 'voice', 'document', 'sticker'];
// Types that act on an earlier message identified by messageId
export const KEY_TYPES = ['reaction', 'edit', 'delete'];
export const MESSAGE_TYPES = ['text', ...MEDIA_TYPES, 'location', 'contact', 'poll', ...KEY_TYPES];

const MAX_TEXT_LENGTH = 65536;
const CAPTIONLESS_TYPES = ['audio', 'voice', 'sticker'];

const invalid = (message) => new AppError(400, message);

function readString(value, name, { max = MAX_TEXT_LENGTH, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw invalid(`${name} is required.`);
  }
  if (typeof value !== 'string') throw invalid(`${name} must be a string.`);
  if (value.length > max) throw invalid(`${name} must be at most ${max} characters.`);
  return value;
}

function readNumber(value, name, min, max, { integer = false } = {}) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw invalid(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
  }
  return number;
}

/**
 * Validates the type-specific part of a send request. Returns the JSON payload stored in the queue
 * and, for media types, the raw media input (URL, data URL or uploaded Buffer).
 * Recipients, replyTo, mentions and message keys are resolved by the caller.
 */
export function parseMessageInput(body, { file = null, countryCode = '62' } = {}) {
  const type = body.type || (file || body.media ? null : 'text');
  if (!type || !MESSAGE_TYPES.includes(type)) {
    throw invalid(`type must be one of: ${MESSAGE_TYPES.join(', ')}.`);
  }

  if (type === 'text') {
    return { type, payload: { text: readString(body.text, 'text') }, media: null };
  }

  if (MEDIA_TYPES.includes(type)) {
    const media = body.media || {};
    const input = file ? file.buffer : media.url || media.base64 || null;
    if (!input) throw invalid('media.url, media.base64 or a file upload is required for media messages.');
    const payload = {};
    const caption = readString(body.caption ?? body.text, 'caption', { optional: true });
    if (caption && !CAPTIONLESS_TYPES.includes(type)) payload.caption = caption;
    if (type === 'document') {
      payload.fileName = readString(media.fileName ?? body.fileName ?? file?.originalname, 'fileName', { max: 255, optional: true }) || 'file';
    }
    const mimetype = media.mimetype ?? body.mimetype ?? file?.mimetype;
    if (mimetype) payload.mimetype = readString(mimetype, 'mimetype', { max: 255 });
    if (type === 'video' && (media.gifPlayback === true || body.gifPlayback === true)) payload.gifPlayback = true;
    return { type, payload, media: input };
  }

  if (type === 'location') {
    const location = body.location || {};
    const payload = {
      latitude: readNumber(location.latitude, 'location.latitude', -90, 90),
      longitude: readNumber(location.longitude, 'location.longitude', -180, 180)
    };
    const name = readString(location.name, 'location.name', { max: 1000, optional: true });
    const address = readString(location.address, 'location.address', { max: 1000, optional: true });
    if (name) payload.name = name;
    if (address) payload.address = address;
    return { type, payload, media: null };
  }

  if (type === 'contact') {
    const list = Array.isArray(body.contacts) ? body.contacts : body.contact ? [body.contact] : [];
    if (!list.length || list.length > 20) throw invalid('contacts must contain 1-20 entries of { name, phone }.');
    const contacts = list.map((contact, index) => ({
      name: readString(contact?.name, `contacts[${index}].name`, { max: 200 }),
      phone: normalizePhoneNumber(contact?.phone, countryCode)
    }));
    return { type, payload: { contacts }, media: null };
  }

  if (type === 'poll') {
    const poll = body.poll || {};
    if (!Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 12) {
      throw invalid('poll.options must contain 2-12 entries.');
    }
    const options = poll.options.map((option, index) => readString(option, `poll.options[${index}]`, { max: 100 }));
    if (new Set(options).size !== options.length) throw invalid('poll.options must be unique.');
    const selectableCount = poll.selectableCount === undefined
      ? 1
      : readNumber(poll.selectableCount, 'poll.selectableCount', 0, options.length, { integer: true });
    return { type, payload: { name: readString(poll.name, 'poll.name', { max: 255 }), options, selectableCount }, media: null };
  }

  const messageId = readString(body.messageId, 'messageId', { max: 150 });
  if (type === 'reaction') {
    // An empty emoji removes an earlier reaction
    return { type, payload: { messageId, emoji: readString(body.emoji, 'emoji', { max: 16, optional: true }) ?? '' }, media: null };
  }
  if (type === 'edit') {
    return { type, payload: { messageId, text: readString(body.text, 'text') }, media: null };
  }
  return { type, payload: { messageId }, media: null };
}

export function buildVcard({ name, phone }) {
  const displayName = String(name).replace(/[\r\n]+/g, ' ');
  return ['BEGIN:VCARD', 'VERSION:3.0', `FN:${displayName}`, `TEL;type=CELL;type=VOICE;waid=${phone}:+${phone}`, 'END:VCARD'].join('\n');
}

/**
 * Turns a queued payload into Baileys message content. `media` is { buffer, contentType } for media
 * types; `key` is the WhatsApp key of the target message for reaction, edit and delete.
 */
export function buildMessageContent(type, payload, { media = null, key = null } = {}) {
  const mentions = payload.mentions?.length ? { mentions: payload.mentions } : {};
  switch (type) {
    case 'text':
      return { text: payload.text, ...mentions };
    case 'image':
      return { image: media.buffer, caption: payload.caption || '', ...mentions };
    case 'video':
      return { video: media.buffer, caption: payload.caption || '', gifPlayback: Boolean(payload.gifPlayback), ...mentions };
    case 'audio':
      return { audio: media.buffer, mimetype: payload.mimetype || media.contentType || 'audio/mpeg', ptt: false };
    case 'voice':
      // WhatsApp only plays voice notes encoded as OGG/Opus
      return { audio: media.buffer, mimetype: 'audio/ogg; codecs=opus', ptt: true };
    case 'document':
      return {
        document: media.buffer,
        fileName: payload.fileName || 'file',
        mimetype: payload.mimetype || media.contentType || 'application/octet-stream',
        caption: payload.caption || ''
      };
    case 'sticker':
      return { sticker: media.buffer };
    case 'location':
      return { location: { degreesLatitude: payload.latitude, degreesLongitude: payload.longitude, name: payload.name, address: payload.address } };
    case 'contact':
      return {
        contacts: {
          displayName: payload.contacts.length === 1 ? payload.contacts[0].name : `${payload.contacts.length} contacts`,
          contacts: payload.contacts.map((contact) => ({ displayName: contact.name, vcard: buildVcard(contact) }))
        }
      };
    case 'poll':
      return { poll: { name: payload.name, values: payload.options, selectableCount: payload.selectableCount }, ...mentions };
    case 'reaction':
      return { react: { text: payload.emoji, key } };
    case 'edit':
      return { text: payload.text, edit: key };
    case 'delete':
      return { delete: key };
    default:
      throw new AppError(400, `Unsupported message type "${type}".`);
  }
}

/**
 * Presence shown before sending: typing for most messages, recording for audio, none for actions.
 */
export function presenceFor(type) {
  if (type === 'audio' || type === 'voice') return 'recording';
  if (['sticker', ...KEY_TYPES].includes(type)) return null;
  return 'composing';
}

/**
 * Human-readable content stored in the message history.
 */
export function historyText(type, payload) {
  switch (type) {
    case 'text':
    case 'edit':
      return payload.text;
    case 'location':
      return payload.name || `${payload.latitude},${payload.longitude}`;
    case 'contact':
      return payload.contacts.map((contact) => contact.name).join(', ');
    case 'poll':
      return payload.name;
    case 'reaction':
      return payload.emoji;
    case 'delete':
      return '';
    default:
      return payload.caption || payload.fileName || '';
  }
}
