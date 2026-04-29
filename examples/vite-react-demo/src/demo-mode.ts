// Demo-only plumbing: coordinates which transport mode (SharedWorker vs
// tab-election) every open tab is using — discovers on startup, follows
// force-switches. Not something library consumers need to write.

export type Mode = 'shared' | 'tab';

type ModeMessage = { t: 'query' } | { t: 'announce'; mode: Mode } | { t: 'force'; mode: Mode };

const CHANNEL_NAME = 'vite-react-demo-mode';
const DISCOVERY_TIMEOUT = 150;
const DEFAULT_MODE: Mode = 'shared';

const channel = new BroadcastChannel(CHANNEL_NAME);

const paramMode = new URLSearchParams(location.search).get('mode');
const explicitMode: Mode | null = paramMode === 'shared' || paramMode === 'tab' ? paramMode : null;

function discover(): Promise<Mode | null> {
  return new Promise((resolve) => {
    let found: Mode | null = null;
    const onMessage = (event: MessageEvent<ModeMessage>): void => {
      if (event.data.t === 'announce' && !found) {
        found = event.data.mode;
        channel.removeEventListener('message', onMessage);
        resolve(found);
      }
    };
    channel.addEventListener('message', onMessage);
    channel.postMessage({ t: 'query' } satisfies ModeMessage);
    setTimeout(() => {
      channel.removeEventListener('message', onMessage);
      resolve(found);
    }, DISCOVERY_TIMEOUT);
  });
}

async function resolveMode(): Promise<Mode> {
  if (explicitMode) {
    channel.postMessage({ t: 'force', mode: explicitMode } satisfies ModeMessage);
    return explicitMode;
  }
  const discovered = await discover();
  if (discovered && discovered !== DEFAULT_MODE) {
    location.replace(`?mode=${discovered}`);
    await new Promise<never>(() => {});
  }
  return DEFAULT_MODE;
}

export const currentMode: Mode = await resolveMode();

channel.addEventListener('message', (event: MessageEvent<ModeMessage>) => {
  const msg = event.data;
  if (msg.t === 'query') {
    channel.postMessage({ t: 'announce', mode: currentMode } satisfies ModeMessage);
  } else if (msg.t === 'force' && msg.mode !== currentMode) {
    location.href = `?mode=${msg.mode}`;
  }
});

export function selectMode(next: Mode): void {
  if (next === currentMode) return;
  channel.postMessage({ t: 'force', mode: next } satisfies ModeMessage);
  location.href = `?mode=${next}`;
}
