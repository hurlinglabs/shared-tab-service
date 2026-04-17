export { defineService, type SharedTabService } from './service.js';
export {
  createSharedTabService,
  type CreateSharedTabServiceOptions,
  type CreatedClient,
  type SharedTabClient,
} from './client.js';
export { runSharedTabHub, type RunSharedTabHubOptions } from './worker.js';
export type { ServiceStub } from 'tab-election/hub';
