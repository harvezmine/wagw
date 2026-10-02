import express from 'express';
import {
  initSession,
  getQrCode,
  createQrLink,
  requestPairingCode,
  getStatus,
  listSessions,
  updateWebhook,
  logout,
  deleteSession
} from '../controllers/sessionController.js';
import { apiKeyAuth, qrPageAuth } from '../middlewares/auth.js';
import { validateSessionIdParam } from '../utils/validation.js';

const router = express.Router();

router.param('sessionId', validateSessionIdParam);

// The QR page can be opened in a browser with a signed ?token= link instead of the API key header
router.get('/:sessionId/qr', qrPageAuth, getQrCode);

// Every other session route requires the x-api-key header
router.use(apiKeyAuth);
router.post('/init', initSession);
router.get('/', listSessions);
router.get('/:sessionId/status', getStatus);
router.post('/:sessionId/qr-link', createQrLink);
router.post('/:sessionId/pairing-code', requestPairingCode);
router.put('/:sessionId/webhook', updateWebhook);
router.post('/:sessionId/logout', logout);
router.delete('/:sessionId', deleteSession);

export default router;
