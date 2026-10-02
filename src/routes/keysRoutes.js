import express from 'express';
import { createKey, listKeys, revokeKey } from '../controllers/keysController.js';

const router = express.Router();

router.post('/', createKey);
router.get('/', listKeys);
router.delete('/:keyId', revokeKey);

export default router;
