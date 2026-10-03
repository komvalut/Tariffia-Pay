import type { FastifyPluginAsync } from 'fastify';
import type { Database } from '../db.js';
import { requireAdmin, requireMerchant } from '../http.js';
import type { AuditLogService } from '../services/audit-log-service.js';

export const auditLogRoutes: FastifyPluginAsync<{ db: Database; auditLog: AuditLogService }> =
  async (app, { db, auditLog }) => {
    app.get('/v1/audit-log', async (request, reply) => {
      const merchant = await requireMerchant(request, db);
      // Merchant-scoped: only this merchant's own entries, newest first.
      return reply.send(await auditLog.listForMerchant(merchant.id, request.query as Record<string, unknown>));
    });

    app.get('/v1/admin/audit-log', async (request, reply) => {
      requireAdmin(request);
      const query = request.query as Record<string, unknown>;
      return reply.send(await auditLog.listAll({
        actorType: query.actorType,
        action: query.action,
        resourceType: query.resourceType,
      }, query));
    });
  };
