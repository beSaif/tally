import { Hono } from 'hono';
import type { AppEnv } from '../env';

// TODO(agent): implement per docs/SPEC.md §6. Mounted in src/worker/index.ts.
export const exportRoutes = new Hono<AppEnv>();
