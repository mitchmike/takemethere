import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  PTV_API_KEY: z.string().min(1),
  PTV_GTFS_URL: z.string().url().default('https://data.ptv.vic.gov.au/downloads/gtfs.zip'),
  PTV_GTFS_RT_URL: z.string().url(),
  GTFS_RT_ENABLED: z.string().default('false').transform(v => v === 'true'),
  GTFS_RT_POLL_INTERVAL_MS: z.coerce.number().default(30_000),
  PORT: z.coerce.number().default(3001),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
});

export const config = schema.parse(process.env);
