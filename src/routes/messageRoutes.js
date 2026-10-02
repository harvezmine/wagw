import express from 'express';
import multer from 'multer';
import {
  sendText,
  sendImage,
  sendAttachment,
  sendPairingCode,
  getMessages,
  downloadMedia
} from '../controllers/messageController.js';
import { validateSessionIdParam } from '../utils/validation.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB max upload
});

const router = express.Router();

router.param('sessionId', validateSessionIdParam);

router.post('/send-text', sendText);
router.post('/send-image', upload.single('file'), sendImage);
router.post('/send-attachment', upload.single('file'), sendAttachment);
router.post('/send-pairing-code', sendPairingCode);
router.get('/:sessionId', getMessages);
router.get('/:sessionId/download/:messageId', downloadMedia);

export default router;
