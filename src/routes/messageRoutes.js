import express from 'express';
import multer from 'multer';
import {
  sendMessage,
  sendText,
  sendImage,
  sendAttachment,
  sendPairingCode,
  getMessages,
  downloadMedia
} from '../controllers/messageController.js';
import { validateSessionIdParam } from '../utils/validation.js';
import { requireSessionAccess } from '../middlewares/auth.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max upload
});

const router = express.Router();

router.param('sessionId', validateSessionIdParam);

router.post('/send', upload.single('file'), sendMessage);
router.post('/send-text', sendText);
router.post('/send-image', upload.single('file'), sendImage);
router.post('/send-attachment', upload.single('file'), sendAttachment);
router.post('/send-pairing-code', sendPairingCode);
router.get('/:sessionId', requireSessionAccess, getMessages);
router.get('/:sessionId/download/:messageId', requireSessionAccess, downloadMedia);

export default router;
