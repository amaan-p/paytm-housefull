import pino from 'pino';

// JSON logs to stdout — the platform (Fly) collects stdout
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: ['req.headers.authorization', 'req.headers["x-admin-key"]'], // never log secrets
});
