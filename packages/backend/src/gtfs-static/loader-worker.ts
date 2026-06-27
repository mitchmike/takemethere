import { parentPort } from 'worker_threads';
import { run } from './loader.js';
import type { ProgressStep } from './loader.js';

run((step: ProgressStep, count?: number) => {
  parentPort?.postMessage({ progress: step, count });
})
  .then(() => parentPort?.postMessage({ done: true }))
  .catch(err => parentPort?.postMessage({ error: err instanceof Error ? err.message : String(err) }));
