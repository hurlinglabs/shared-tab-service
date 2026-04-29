import { createSharedTabService } from '@hurling/shared-tab-service';
import { currentMode, wireModeLinks } from './demo-mode.js';
import sharedWorkerUrl from './shared.worker.ts?worker&url';
import { createServices } from './services.js';

const tabId = crypto.randomUUID().slice(0, 8);

const client = createSharedTabService({
  name: 'vite-demo',
  services: createServices(),
  ...(currentMode === 'shared' ? { workerUrl: sharedWorkerUrl } : {}),
});

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const countEl = $('count');
const eventsEl = $<HTMLUListElement>('events');
const leaderEl = $('leader');

$('tab-id').textContent = tabId;
$('mode').textContent =
  currentMode === 'shared' ? 'SharedWorker (falls back to tab-election)' : 'Tab-election (forced)';

const baseTitle = document.title;
const renderLeader = (isLeader: boolean): void => {
  leaderEl.textContent = isLeader
    ? 'this tab'
    : currentMode === 'shared'
      ? 'worker'
      : 'another tab';
  document.title = isLeader ? `★ Leader — ${baseTitle}` : baseTitle;
};

const logEvent = (line: string): void => {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()} — ${line}`;
  eventsEl.prepend(li);
};

renderLeader(client.isLeader);
client.onLeaderChange(renderLeader);

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

wireModeLinks();
