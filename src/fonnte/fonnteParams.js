import { parseTargets, renderTemplate } from '../services/bulkTargets.js';

/**
 * Error answered as Fonnte does: HTTP 200 with { status: false, reason }.
 */
export class FonnteError extends Error {}

const isTrue = (value) => value === true || value === 'true' || value === '1' || value === 1;
const MAX_TYPING_MS = 15000;

/**
 * Fonnte delay syntax: "5" seconds or "5-10" (random per gap). Returns a function producing ms.
 */
export function parseFonnteDelay(value, random = Math.random) {
  if (value === undefined || value === null || value === '') return () => 0;
  const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(String(value));
  if (!match) throw new FonnteError('input invalid');
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (max < min) throw new FonnteError('input invalid');
  return () => Math.round((min + random() * (max - min)) * 1000);
}

export function parseFonnteData(data) {
  let items = data;
  if (typeof data === 'string') {
    try {
      items = JSON.parse(data);
    } catch {
      throw new FonnteError('JSON format invalid');
    }
  }
  if (!Array.isArray(items) || !items.every((item) => item && typeof item === 'object' && !Array.isArray(item))) {
    throw new FonnteError('JSON format invalid');
  }
  return items;
}

function mediaTypeOf({ mimetype, name }) {
  const extension = String(name || '').split('?')[0].split('.').pop().toLowerCase();
  if (mimetype?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(extension)) return 'image';
  if (mimetype?.startsWith('video/') || ['mp4', '3gp', 'mov'].includes(extension)) return 'video';
  if (mimetype?.startsWith('audio/') || ['mp3', 'ogg', 'm4a', 'aac', 'wav', 'opus'].includes(extension)) return 'audio';
  return 'document';
}

function urlPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function contentOf(params, file) {
  const message = params.message ?? '';
  if (params.location) {
    const [latitude, longitude] = String(params.location).split(',').map((part) => Number(part.trim()));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new FonnteError('input invalid');
    return { type: 'location', payload: { latitude, longitude }, media: null };
  }
  if (params.choices) {
    const options = String(params.choices).split(',').map((option) => option.trim()).filter(Boolean);
    return {
      type: 'poll',
      payload: { name: params.pollname || message || 'Poll', options, selectableCount: params.select === 'multiple' ? 0 : 1 },
      media: null
    };
  }
  if (file || params.url) {
    const name = file ? file.originalname : urlPath(params.url);
    const type = mediaTypeOf({ mimetype: file?.mimetype, name });
    const payload = {};
    if (message && type !== 'audio') payload.caption = message;
    if (type === 'document') payload.fileName = params.filename || String(name).split('/').pop() || 'file';
    if (file?.mimetype) payload.mimetype = file.mimetype;
    return { type, payload, media: file ? file.buffer : params.url };
  }
  if (!message) throw new FonnteError('input invalid');
  return { type: 'text', payload: { text: message }, media: null };
}

/**
 * Maps one Fonnte /send request (or one `data` item) to message submissions, one per target.
 * `delay` stacks between targets (the first goes at the base time); `schedule` (unix seconds) and
 * `followup` (seconds) move the base time.
 */
export function mapFonnteSend(params, { now = Date.now, random = Math.random, file = null } = {}) {
  const targets = parseTargets(params.target);
  if (!targets.length) throw new FonnteError('target invalid');
  const { type, payload, media } = contentOf(params, file);
  const nextDelay = parseFonnteDelay(params.delay, random);

  let base = null;
  if (params.schedule !== undefined && params.schedule !== '' && Number(params.schedule) > 0) {
    if (!/^\d+$/.test(String(params.schedule))) throw new FonnteError('input invalid');
    base = Number(params.schedule) * 1000;
  }
  if (params.followup !== undefined && params.followup !== '' && Number(params.followup) > 0) {
    base = (base ?? now()) + Number(params.followup) * 1000;
  }

  const countryCode = params.countryCode === undefined || params.countryCode === '' ? '62' : String(params.countryCode);
  const delayMs = isTrue(params.typing) ? Math.min(Math.max(Number(params.duration) || 1, 0) * 1000, MAX_TYPING_MS) : 0;
  const connectOnly = params.connectOnly === undefined || params.connectOnly === '' ? true : isTrue(params.connectOnly);
  const replyTo = params.inboxid ? String(params.inboxid) : null;

  let offset = 0;
  return targets.map((target, index) => {
    if (index > 0) offset += nextDelay();
    const at = base !== null || offset ? (base ?? now()) + offset : null;
    const personalized = { ...payload };
    for (const field of ['text', 'caption', 'name']) {
      if (typeof personalized[field] === 'string') personalized[field] = renderTemplate(personalized[field], target);
    }
    return {
      to: target.number,
      type,
      payload: personalized,
      media,
      countryCode,
      delayMs,
      connectOnly,
      replyTo,
      scheduleAt: at !== null && at > now() ? new Date(at) : null
    };
  });
}
