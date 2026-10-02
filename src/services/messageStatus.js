// Baileys WAMessageStatus values carried by `messages.update` for our own messages
const ACK_TO_STATUS = { 0: 'failed', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'played' };

// Delivery progress only moves forward
const PROGRESS = ['sent', 'delivered', 'read', 'played'];

// WhatsApp NACK codes worth explaining to API clients
const ACK_ERRORS = {
  463: 'account restricted from starting new chats (reach-out timelock or missing privacy token)',
  475: 'new chat message limit reached',
  479: 'rejected by WhatsApp (stale device session or invalid addressing)'
};

export const QUEUE_STATUSES = ['queued', 'processing', 'sent', 'delivered', 'read', 'played', 'failed', 'cancelled', 'expired'];

export function ackToStatus(ack) {
  return ACK_TO_STATUS[ack] ?? null;
}

/**
 * Statuses a message may currently have for `status` to be applied (forward-only transitions).
 * A failure can only follow a server ack.
 */
export function allowedPreviousStatuses(status) {
  if (status === 'failed') return ['sent', 'delivered'];
  const index = PROGRESS.indexOf(status);
  return index > 0 ? PROGRESS.slice(0, index) : [];
}

export function describeAckError(code) {
  if (!code) return 'WhatsApp rejected the message';
  return ACK_ERRORS[code] ? `WhatsApp error ${code}: ${ACK_ERRORS[code]}` : `WhatsApp error ${code}`;
}
