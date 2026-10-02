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
  deleteSession,
  listWebhookDeliveries,
  retryWebhookDelivery,
  getLimits,
  validateSessionNumbers,
  getGroups,
  getGroupDetail,
  getSettings,
  updateSettings
} from '../controllers/sessionController.js';
import { deleteConsent, getHealth, listConsents, putConsents, resumeHealth } from '../controllers/guardController.js';
import { authenticate, qrPageAuth, requireSessionAccess } from '../middlewares/auth.js';
import { validateSessionIdParam } from '../utils/validation.js';

const router = express.Router();

router.param('sessionId', validateSessionIdParam);

// The QR page can be opened in a browser with a signed ?token= link instead of the API key header
router.get('/:sessionId/qr', qrPageAuth, requireSessionAccess, getQrCode);

// Every other session route requires the x-api-key header; tenant keys only reach their own sessions
router.use(authenticate);
router.post('/init', initSession);
router.get('/', listSessions);
router.get('/:sessionId/status', requireSessionAccess, getStatus);
router.get('/:sessionId/limits', requireSessionAccess, getLimits);
router.post('/:sessionId/validate', requireSessionAccess, validateSessionNumbers);
router.get('/:sessionId/groups', requireSessionAccess, getGroups);
router.get('/:sessionId/groups/:groupId', requireSessionAccess, getGroupDetail);
router.get('/:sessionId/settings', requireSessionAccess, getSettings);
router.patch('/:sessionId/settings', requireSessionAccess, updateSettings);
router.get('/:sessionId/health', requireSessionAccess, getHealth);
router.post('/:sessionId/health/resume', requireSessionAccess, resumeHealth);
router.get('/:sessionId/consents', requireSessionAccess, listConsents);
router.put('/:sessionId/consents', requireSessionAccess, putConsents);
router.delete('/:sessionId/consents/:number', requireSessionAccess, deleteConsent);
router.post('/:sessionId/qr-link', requireSessionAccess, createQrLink);
router.post('/:sessionId/pairing-code', requireSessionAccess, requestPairingCode);
router.put('/:sessionId/webhook', requireSessionAccess, updateWebhook);
router.get('/:sessionId/webhook-deliveries', requireSessionAccess, listWebhookDeliveries);
router.post('/:sessionId/webhook-deliveries/:deliveryId/retry', requireSessionAccess, retryWebhookDelivery);
router.post('/:sessionId/logout', requireSessionAccess, logout);
router.delete('/:sessionId', requireSessionAccess, deleteSession);

export default router;
