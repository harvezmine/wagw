const percent = (part, whole) => Math.round((part / whole) * 100);

/**
 * Whether campaigns should pause, from recent outcomes:
 * - delivery rate of sent messages (WhatsApp silently dropping them is an early restriction sign);
 * - reply rate of new chats (few replies usually means many reports and blocks).
 * Samples below `minSample` never trigger a pause.
 */
export function evaluateHealth({ deliverySample, delivered, replySample, replied }, { minSample, minDeliveryRate, minReplyRate }) {
  if (deliverySample >= minSample && delivered / deliverySample < minDeliveryRate) {
    return { pause: true, reason: `low delivery rate (${percent(delivered, deliverySample)}% of ${deliverySample} recent messages)` };
  }
  if (replySample >= minSample && replied / replySample < minReplyRate) {
    return { pause: true, reason: `low reply rate (${percent(replied, replySample)}% of ${replySample} recent new chats)` };
  }
  return { pause: false, reason: null };
}
