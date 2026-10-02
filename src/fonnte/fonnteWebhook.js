import { phoneFromJid } from '../utils/jid.js';

const unixTime = (iso) => Math.floor((iso ? Date.parse(iso) : Date.now()) / 1000);

/**
 * Converts gateway webhook events into Fonnte webhook payloads, for receivers written for Fonnte.
 * Returns null for events that have no Fonnte equivalent.
 */
export function toFonnteWebhook(eventType, data, { device }) {
  switch (eventType) {
    case 'message.received': {
      if (data.fromMe) return null;
      const senderPhone = data.senderPhone || phoneFromJid(data.senderJid);
      const fileName = data.media?.fileName || '';
      return {
        device,
        sender: data.isGroup ? data.remoteJid : senderPhone,
        message: data.content || '',
        text: data.content || '',
        member: data.isGroup ? senderPhone : '',
        name: data.pushName || '',
        location: data.messageType === 'location' && data.media
          ? `${data.media.degreesLatitude},${data.media.degreesLongitude}`
          : '',
        pollname: data.messageType === 'poll' ? data.content || '' : '',
        choices: data.messageType === 'poll' ? (data.media?.options || []).join(',') : '',
        filename: fileName,
        extension: fileName.includes('.') ? fileName.split('.').pop() : '',
        inboxid: data.messageId,
        timestamp: unixTime(data.timestamp)
      };
    }
    case 'message.status': {
      const id = data.queueId !== null && data.queueId !== undefined ? String(data.queueId) : data.messageId;
      if (['delivered', 'read', 'played'].includes(data.status)) {
        return { device, id, stateid: data.messageId || '', state: data.status === 'played' ? 'read' : data.status };
      }
      return { device, id, stateid: data.messageId || '', status: data.status };
    }
    case 'connection.update': {
      if (data.status === 'connected') {
        return { device: data.phoneNumber || device, status: 'connect', timestamp: unixTime() };
      }
      if (data.status === 'disconnected' || data.status === 'reconnecting') {
        return { device, status: 'disconnect', reason: data.disconnectReason || data.reason || '', timestamp: unixTime() };
      }
      return null;
    }
    default:
      return null;
  }
}
