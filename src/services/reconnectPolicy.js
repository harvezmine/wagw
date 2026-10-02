import { DisconnectReason } from '@whiskeysockets/baileys';

// Disconnects where reconnecting cannot help and would only hammer WhatsApp or fight another socket
const STOP_REASONS = new Map([
  [DisconnectReason.forbidden, 'forbidden'],
  [DisconnectReason.connectionReplaced, 'connection_replaced'],
  [DisconnectReason.multideviceMismatch, 'multidevice_mismatch'],
  [405, 'client_version_rejected'],
  // Bans: reconnecting while banned only adds to the account's record
  [402, 'temporarily_banned'],
  [406, 'banned'],
  [409, 'client_rejected']
]);

/**
 * Exponential backoff with "equal jitter": a random delay between half and all of the capped ceiling.
 */
export function backoffDelay(attempt, { baseDelayMs, maxDelayMs, random = Math.random }) {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt, 30));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/**
 * Decides what to do after a Baileys connection closes.
 * @returns {{ action: 'reconnect' | 'stop' | 'logout', reason: string, delayMs?: number }}
 */
export function decideReconnect({ statusCode, attempt, registered, baseDelayMs, maxDelayMs, random = Math.random }) {
  if (statusCode === DisconnectReason.loggedOut) {
    return { action: 'logout', reason: 'logged_out' };
  }
  if (STOP_REASONS.has(statusCode)) {
    return { action: 'stop', reason: STOP_REASONS.get(statusCode) };
  }
  if (statusCode === DisconnectReason.restartRequired) {
    return { action: 'reconnect', reason: 'restart_required', delayMs: 0 };
  }
  if (!registered) {
    // Unpaired socket closed (QR refs exhausted, pairing timed out): wait for an explicit /init
    return { action: 'stop', reason: 'pairing_timeout' };
  }
  return {
    action: 'reconnect',
    reason: 'connection_lost',
    delayMs: backoffDelay(attempt, { baseDelayMs, maxDelayMs, random })
  };
}
