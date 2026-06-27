// CLI entry point — delegates to the backend loader module
import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(import.meta.dirname, '../.env') });

import { run } from '../packages/backend/src/gtfs-static/loader.js';

run().catch(err => { console.error(err); process.exit(1); });
