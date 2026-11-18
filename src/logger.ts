import pino from 'pino';
import type { Logger, LoggerOptions } from 'pino';
import type { LogLevel, NodeEnv } from './config/env.js';

export function createLogger(level: LogLevel, nodeEnv: NodeEnv): Logger {
  const options: LoggerOptions = { level };

  if (nodeEnv === 'development') {
    options.transport = {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    };
  }

  return pino(options);
}
