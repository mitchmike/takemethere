import { config } from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// Resolve monorepo root (test/setup.ts → backend/ → packages/ → root)
const backendRoot = resolve(fileURLToPath(import.meta.url), '../..');
const monoRoot = resolve(backendRoot, '../..');
config({ path: resolve(monoRoot, '.env') });
