import { buildApp } from './app.js';
import { config } from './config.js';

const { fastify } = await buildApp();

try {
  await fastify.listen({ port: config.PORT, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
