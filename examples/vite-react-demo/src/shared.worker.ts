import { runSharedTabHub } from '@hurling/shared-tab-service/worker';
import { createServices } from './services.js';

runSharedTabHub({
  name: 'vite-react-demo',
  services: createServices(),
});
