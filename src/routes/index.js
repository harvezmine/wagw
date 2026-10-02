import express from 'express';
import sessionRoutes from './sessionRoutes.js';
import messageRoutes from './messageRoutes.js';
import { apiKeyAuth } from '../middlewares/auth.js';
import { config } from '../config/index.js';

const router = express.Router();

// Health Check
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Unauthenticated test webhook receiver for local debugging only
if (config.nodeEnv !== 'production') {
  router.post('/webhook-test', (req, res) => {
    console.log('----------------------------------------------------');
    console.log('[Webhook Test Receiver] Received Payload:');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('----------------------------------------------------');
    res.status(200).json({ received: true });
  });
}

// Session routes apply auth themselves (the QR page also accepts signed links)
router.use('/sessions', sessionRoutes);
router.use('/messages', apiKeyAuth, messageRoutes);

export default router;
