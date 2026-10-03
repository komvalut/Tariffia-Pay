import { readFile } from 'node:fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import { openApiDocument } from '../openapi.js';

const docsHtml = readFile(new URL('../../web/docs.html', import.meta.url), 'utf8');

/**
 * Serves the hand-written OpenAPI description of the existing public/merchant API and a
 * dependency-free viewer. Documentation only: this changes no endpoint behavior and exposes
 * no credentials, private keys or provider secrets.
 */
export const docsRoutes: FastifyPluginAsync = async (app) => {
  app.get('/openapi.json', async (_request, reply) => {
    return reply.header('cache-control', 'public, max-age=300').send(openApiDocument);
  });

  app.get('/docs', async (_request, reply) => {
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(await docsHtml);
  });
};
