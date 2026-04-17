export { defineService, type SharedTabService } from './service.js';
export {
  createSharedTabService,
  type CreateSharedTabServiceOptions,
  type CreatedClient,
  type SharedTabClient,
  type ServicesRecord,
} from './client.js';
export { runSharedTabHub, type RunSharedTabHubOptions } from './worker.js';
export type { Hub, ServiceStub } from 'tab-election/hub';
