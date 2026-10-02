import pino from 'pino';
import { config } from '../config/index.js';

/**
 * Application logger: one JSON object per line in production, human-readable when LOG_PRETTY=true.
 * Add context with child loggers, e.g. logger.child({ module: 'queue' }).
 */
export const logger = pino({
  level: config.logLevel,
  ...(config.logPretty
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
    : {})
});
