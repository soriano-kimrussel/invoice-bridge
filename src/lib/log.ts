import type { WorkerLogger } from '../worker/extractionWorker.js';

/** Minimal structured logger (one JSON object per line) for processes without Fastify's pino. */
export const jsonLogger: WorkerLogger = {
  info: (o, m) => console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), msg: m, ...o })),
  warn: (o, m) => console.warn(JSON.stringify({ level: 'warn', time: new Date().toISOString(), msg: m, ...o })),
  error: (o, m) => console.error(JSON.stringify({ level: 'error', time: new Date().toISOString(), msg: m, ...o })),
};
