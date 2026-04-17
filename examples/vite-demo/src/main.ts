import { createSharedTabService } from '@hurling/shared-tab-service';
import { createServices } from './services.js';

const params = new URLSearchParams(location.search);
const wantShared = params.get('mode') !== 'tab';

const tabId = crypto.randomUUID().slice(0, 8);

const workerUrl = wantShared ? new URL('./shared.worker.ts', import.meta.url) : undefined;

const client = createSharedTabService({
  name: 'vite-demo',
  services: createServices(),
  ...(workerUrl ? { workerUrl } : {}),
});

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

$('tab-id').textContent = tabId;
$('mode').textContent = wantShared
  ? 'SharedWorker (falls back to tab-election)'
  : 'Tab-election (forced)';

const leaderEl = $('leader');
const renderLeader = (isLeader: boolean): void => {
  leaderEl.textContent = isLeader ? 'this tab' : wantShared ? 'worker' : 'another tab';
};
renderLeader(client.isLeader);
client.onLeaderChange(renderLeader);

const countEl = $('count');
const eventsEl = $<HTMLUListElement>('events');

const logEvent = (line: string): void => {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} — ${line}`;
  eventsEl.prepend(li);
};

client.counter.on('changed', ({ value, byTab }) => {
  countEl.textContent = String(value);
  logEvent(`counter → ${value} (by ${byTab === tabId ? 'this tab' : byTab})`);
});

$('increment').addEventListener('click', () => {
  void client.counter.increment(tabId);
});

void client.counter.get().then((value) => {
  countEl.textContent = String(value);
});
