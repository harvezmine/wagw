import express from 'express';
import {
  initSession,
  getQrCode,
  requestPairingCode,
  getStatus,
  listSessions,
  updateWebhook,
  logout,
  deleteSession
} from '../controllers/sessionController.js';

const router = express.Router();

router.post('/init', initSession);
router.get('/', listSessions);
router.get('/:sessionId/status', getStatus);
router.get('/:sessionId/qr', getQrCode);
router.post('/:sessionId/pairing-code', requestPairingCode);
router.put('/:sessionId/webhook', updateWebhook);
router.post('/:sessionId/logout', logout);
router.delete('/:sessionId', deleteSession);

export default router;
