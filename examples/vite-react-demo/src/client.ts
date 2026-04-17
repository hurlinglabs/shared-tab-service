import { createSharedTabService } from '@hurling/shared-tab-service';
import { currentMode } from './demo-mode.js';
import sharedWorkerUrl from './shared.worker.ts?worker&url';
import { createServices } from './services.js';

export const tabId = crypto.randomUUID().slice(0, 8);

export const client = createSharedTabService({
  name: 'vite-react-demo',
  services: createServices(),
  ...(currentMode === 'shared' ? { workerUrl: sharedWorkerUrl } : {}),
});
