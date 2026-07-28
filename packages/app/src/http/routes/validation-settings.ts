import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { ValidationSettingsService } from '../../services/validation-settings-service.js';

export function registerValidationSettingsRoutes(
  server: FastifyInstance,
  validation: ValidationSettingsService,
): void {
  server.get('/api/v1/settings/validation', async () => validation.get());

  server.put('/api/v1/settings/validation', async (request) => {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(request.body);
    return validation.setEnabled(enabled);
  });
}
