import type { FastifyPluginAsync } from 'fastify';
import { requireAdmin } from '../http.js';
import type { PaymentAdapterRegistry } from '../payment-adapters/registry.js';

export const adminPaymentAdapterRoutes: FastifyPluginAsync<{ adapters: PaymentAdapterRegistry }> = async (app, { adapters }) => {
  app.get('/v1/admin/payment-adapters', async (request, reply) => {
    requireAdmin(request);
    return reply.send({ adapters: await adapters.list() });
  });
};
