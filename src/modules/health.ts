import type { FastifyPluginAsync } from 'fastify';
import { requireAdmin } from '../http.js';
import { serviceVersion } from '../version.js';
import type { HealthService } from '../services/health-service.js';

/**
 * Liveness (`/health`), readiness (`/ready`) and the admin operational summary (`/v1/health`).
 * All responses are safe operational data only: no secrets, credentials, provider URLs or keys.
 */
export const healthRoutes: FastifyPluginAsync<{ health: HealthService }> = async (app, { health }) => {
  app.get('/health', async (_request, reply) => {
    return reply.send({
      status: 'ok',
      service: 'tariffia-pay-api',
      version: serviceVersion,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  app.get('/ready', async (_request, reply) => {
    try {
      const readiness = await health.readiness();
      if (!readiness.ready) {
        return reply.code(503).send({ status: 'not_ready', service: 'tariffia-pay-api', checks: readiness.checks });
      }
      return reply.send({ status: 'ready', service: 'tariffia-pay-api', checks: readiness.checks });
    } catch {
      return reply.code(503).send({ status: 'not_ready', service: 'tariffia-pay-api' });
    }
  });

  app.get('/v1/health', async (request, reply) => {
    requireAdmin(request);
    return reply.send(await health.summary());
  });
};
