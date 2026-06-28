import { buildApp } from './app.js';
import { config } from './config.js';

// Prepend HH:MM:SS to every console.log/warn/error line
const ts = () => new Date().toLocaleTimeString('en-AU', { hour12: false });
const wrap = (orig: typeof console.log) => (...args: unknown[]) => orig(`[${ts()}]`, ...args);
console.log   = wrap(console.log.bind(console));
console.warn  = wrap(console.warn.bind(console));
console.error = wrap(console.error.bind(console));

const { fastify } = await buildApp();

try {
  await fastify.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
