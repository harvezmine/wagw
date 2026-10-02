import {
  cancelQueuedMessage,
  formatQueueItem,
  getQueuedMessage,
  listQueuedMessages,
  rescheduleQueuedMessage
} from '../services/messageService.js';
import { QUEUE_STATUSES } from '../services/messageStatus.js';
import { AppError, sendError } from '../utils/errors.js';
import { assertSessionId, parseOptionalInt, parseScheduleAt } from '../utils/validation.js';

function parseQueueId(value) {
  return parseOptionalInt(value, { name: 'queueId', min: 1, max: Number.MAX_SAFE_INTEGER });
}

export async function getQueueItem(req, res) {
  try {
    const item = await getQueuedMessage(parseQueueId(req.params.queueId));
    return res.status(200).json({ success: true, item: formatQueueItem(item) });
  } catch (error) {
    return sendError(res, error, 'QueueController');
  }
}

export async function listQueue(req, res) {
  try {
    const { sessionId, status } = req.query;
    if (sessionId) assertSessionId(sessionId);
    if (status && !QUEUE_STATUSES.includes(status)) {
      throw new AppError(400, `status must be one of: ${QUEUE_STATUSES.join(', ')}.`);
    }
    const items = await listQueuedMessages({
      sessionId: sessionId || null,
      status: status || null,
      limit: parseOptionalInt(req.query.limit, { name: 'limit', min: 1, max: 200, defaultValue: 50 }),
      offset: parseOptionalInt(req.query.offset, { name: 'offset', min: 0, max: Number.MAX_SAFE_INTEGER, defaultValue: 0 })
    });
    return res.status(200).json({ success: true, count: items.length, items: items.map(formatQueueItem) });
  } catch (error) {
    return sendError(res, error, 'QueueController');
  }
}

export async function cancelQueueItem(req, res) {
  try {
    const item = await cancelQueuedMessage(parseQueueId(req.params.queueId));
    return res.status(200).json({ success: true, item: formatQueueItem(item) });
  } catch (error) {
    return sendError(res, error, 'QueueController');
  }
}

export async function rescheduleQueueItem(req, res) {
  try {
    const item = await rescheduleQueuedMessage(parseQueueId(req.params.queueId), parseScheduleAt(req.body.scheduleAt));
    return res.status(200).json({ success: true, item: formatQueueItem(item) });
  } catch (error) {
    return sendError(res, error, 'QueueController');
  }
}
