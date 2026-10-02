import express from 'express';
import sessionRoutes from './sessionRoutes.js';
import messageRoutes from './messageRoutes.js';
import { apiKeyAuth } from '../middlewares/auth.js';

const router = express.Router();

// Health Check
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Test Webhook Receiver Endpoint for convenient debugging
router.post('/webhook-test', (req, res) => {
  console.log('----------------------------------------------------');
  console.log('[Webhook Test Receiver] Received Payload:');
  console.log(JSON.stringify(req.body, null, 2));
  console.log('----------------------------------------------------');
  res.status(200).json({ received: true });
});

// Protect routes with optional API key auth
router.use('/sessions', apiKeyAuth, sessionRoutes);
router.use('/messages', apiKeyAuth, messageRoutes);

export default router;
