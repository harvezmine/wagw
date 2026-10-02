import express from 'express';
import { cancelQueueItem, getQueueItem, listQueue, rescheduleQueueItem } from '../controllers/queueController.js';

const router = express.Router();

router.get('/', listQueue);
router.get('/:queueId', getQueueItem);
router.delete('/:queueId', cancelQueueItem);
router.patch('/:queueId', rescheduleQueueItem);

export default router;
