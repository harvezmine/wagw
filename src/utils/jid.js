export function phoneFromJid(jid) {
  return jid ? jid.split('@')[0].split(':')[0] : null;
}

/**
 * Baileys v7 may address chats and group participants by LID (`…@lid`); the phone-number JID then
 * arrives in remoteJidAlt / participantAlt. Returns both forms and the sender's phone when known.
 */
export function describeMessageAddress(key) {
  const isGroup = Boolean(key.remoteJid?.endsWith('@g.us'));
  const senderJid = key.participant || key.remoteJid;
  const remoteJidAlt = isGroup ? null : key.remoteJidAlt || null;
  const senderJidAlt = (isGroup ? key.participantAlt : remoteJidAlt) || null;
  const phoneJid = [senderJid, senderJidAlt].find((jid) => jid?.endsWith('@s.whatsapp.net'));
  return {
    remoteJid: key.remoteJid,
    remoteJidAlt,
    senderJid,
    senderJidAlt,
    senderPhone: phoneJid ? phoneFromJid(phoneJid) : null,
    isGroup
  };
}
