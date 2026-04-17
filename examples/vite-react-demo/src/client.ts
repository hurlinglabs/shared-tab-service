import { createSharedTabService } from '@hurling/shared-tab-service';
import sharedWorkerUrl from './shared.worker.ts?worker&url';
import { createServices } from './services.js';

export const tabId = crypto.randomUUID().slice(0, 8);

const params = new URLSearchParams(location.search);
export const currentMode: 'shared' | 'tab' = params.get('mode') === 'tab' ? 'tab' : 'shared';

const workerUrl = currentMode === 'shared' ? sharedWorkerUrl : undefined;

export const client = createSharedTabService({
  name: 'vite-react-demo',
  services: createServices(),
  ...(workerUrl ? { workerUrl } : {}),
});
