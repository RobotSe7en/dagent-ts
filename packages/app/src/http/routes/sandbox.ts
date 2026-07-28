import type { FastifyInstance } from 'fastify';

import type { SandboxService } from '../../services/sandbox-service.js';

export function registerSandboxRoutes(server: FastifyInstance, sandbox: SandboxService): void {
  server.get('/api/v1/sandbox/status', async () => sandbox.status());
}
