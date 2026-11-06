import { z } from 'zod';

/** Alert list filters shared by GET /api/alerts and GET /api/alerts/export. */
export const alertFilterSchema = z.object({
  service: z.string().optional(),
  environment: z.string().optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  anomalyType: z.string().optional(),
  status: z.enum(['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'DISMISSED']).optional(),
  search: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});
