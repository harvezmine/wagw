import { AppError } from './errors.js';

const JID_PATTERNS = [
  ['@s.whatsapp.net', /^\d{8,15}$/],
  ['@g.us', /^\d+(-\d+)?$/],
  ['@lid', /^\d+$/],
  ['@newsletter', /^\d+$/],
  ['@broadcast', /^(status|\d+)$/]
];

/**
 * Normalises a phone number to international digits (e.g. "0812-3456-789" -> "628123456789").
 * A leading "0" is replaced by `countryCode`; a leading "+" marks the number as already international.
 * countryCode "0" disables the replacement (same semantics as Fonnte's countryCode=0).
 */
export function normalizePhoneNumber(input, countryCode) {
  const code = String(countryCode ?? '');
  if (!/^\d{1,4}$/.test(code)) {
    throw new AppError(400, `Invalid countryCode "${code}": use digits only, e.g. 62.`);
  }
  const raw = String(input ?? '').trim();
  const isInternational = raw.startsWith('+');
  let digits = raw.replace(/[\s\-().]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) {
    throw new AppError(400, `Invalid phone number "${raw}": use digits only, e.g. 08123456789 or 628123456789.`);
  }
  if (!isInternational && digits.startsWith('0') && code !== '0') {
    digits = code + digits.slice(1);
  }
  if (digits.startsWith('0') || digits.length < 8 || digits.length > 15) {
    throw new AppError(400, `Invalid phone number "${raw}": expected 8-15 digits including the country code.`);
  }
  return digits;
}

/**
 * Converts a send target into a WhatsApp JID. Accepts phone numbers in local or international
 * format and pre-formed JIDs (personal, group, LID, newsletter, broadcast).
 */
export function normalizeTarget(target, countryCode) {
  const raw = String(target ?? '').trim().toLowerCase();
  if (!raw) {
    throw new AppError(400, 'Target number is required.');
  }
  if (raw.includes('@')) {
    const match = JID_PATTERNS.find(([suffix]) => raw.endsWith(suffix));
    if (!match || !match[1].test(raw.slice(0, -match[0].length))) {
      throw new AppError(400, `Invalid WhatsApp JID "${target}".`);
    }
    return raw;
  }
  return `${normalizePhoneNumber(raw, countryCode)}@s.whatsapp.net`;
}
