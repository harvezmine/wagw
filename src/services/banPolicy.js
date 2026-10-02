// Temporary-ban reasons that come with connection failure 402 (strings from WhatsApp Web)
const TEMP_BAN_REASONS = {
  101: 'sent too many messages to people who do not have this number in their address book',
  102: 'too many people blocked this number',
  103: 'created too many groups with people who do not have this number in their address book',
  104: 'sent the same message to too many people',
  106: 'sent too many messages to a broadcast list'
};

/**
 * Details of a ban from a connection failure (402 temporary, 406 permanent), or null for other codes.
 * `data` are the failure attributes; `expire` is the remaining ban time in seconds.
 */
export function describeBan(statusCode, data = {}, now = Date.now) {
  if (statusCode === 402) {
    const code = Number(data?.code) || null;
    const expireSeconds = Number(data?.expire);
    return {
      permanent: false,
      code,
      reason: TEMP_BAN_REASONS[code] || 'temporarily banned by WhatsApp',
      expiresAt: Number.isFinite(expireSeconds) && expireSeconds > 0 ? new Date(now() + expireSeconds * 1000) : null
    };
  }
  if (statusCode === 406) {
    return { permanent: true, code: null, reason: 'banned by WhatsApp', expiresAt: null };
  }
  return null;
}
