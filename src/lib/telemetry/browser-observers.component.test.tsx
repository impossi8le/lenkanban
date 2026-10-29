import { afterEach, expect, it, vi } from 'vitest';
import { observeBrowserRequests, observeControlActivations } from './browser-observers';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const sink = () => ({ recordRequestTiming: vi.fn(() => true), recordOperation: vi.fn((name: string) => Boolean(name)) });

it('observes only the current actor window and discards late callbacks after cleanup', () => {
  let rotate: () => void;
  const unsubscribe = vi.fn();
  const client = { ...sink(), subscribeSessionChange: (listener: () => void) => { rotate = listener; return unsubscribe; } };
  let callback: PerformanceObserverCallback;
  const disconnect = vi.fn(), observe = vi.fn();
  vi.spyOn(performance, 'now').mockReturnValue(100);
  vi.stubGlobal('PerformanceObserver', class {
    constructor(cb: PerformanceObserverCallback) { callback = cb; }
    observe = observe;
    disconnect = disconnect;
  });
  const stop = observeBrowserRequests(client);
  expect(observe).toHaveBeenCalledWith({ type: 'resource', buffered: true });
  const entry = (startTime: number) => ({ name: `${window.location.origin}/api/projects/PRIVATE`, entryType: 'resource', initiatorType: 'fetch', startTime, duration: 20 });
  const emit = () => callback({ getEntries: () => [entry(90), entry(110)] } as unknown as PerformanceObserverEntryList, {} as PerformanceObserver);
  emit();
  expect(client.recordRequestTiming).toHaveBeenCalledExactlyOnceWith('/api/projects/:id', { durationMs: 20 });
  vi.mocked(performance.now).mockReturnValue(120);
  rotate!();
  emit();
  expect(client.recordRequestTiming).toHaveBeenCalledTimes(1);
  stop();
  emit();
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(client.recordRequestTiming).toHaveBeenCalledTimes(1);
});

it('unsupported observers and sink failures never affect business behavior', () => {
  vi.stubGlobal('PerformanceObserver', undefined);
  expect(() => observeBrowserRequests(sink())()).not.toThrow();
  const client = sink();
  client.recordOperation.mockImplementation(() => { throw Error('SYNTHETIC_SECRET'); });
  const stop = observeControlActivations(client);
  const button = document.createElement('button');
  button.onclick = vi.fn();
  document.body.append(button);
  expect(() => button.click()).not.toThrow();
  expect(button.onclick).toHaveBeenCalledTimes(1);
  stop();
});

it('records closed control names without DOM text, input, href or selectors', () => {
  const client = sink(), stop = observeControlActivations(client);
  document.body.innerHTML = `<button data-telemetry-action="task.title.edit"><span>PRIVATE_TITLE</span></button>
    <button data-telemetry-action="SYNTHETIC_SECRET">PRIVATE_NAME</button>
    <a href="/PRIVATE?token=SECRET">PRIVATE_LINK</a><input type="checkbox" value="SECRET">
    <select><option value="SECRET">PRIVATE_OPTION</option></select>
    <input type="password" value="SECRET"><p>PRIVATE_DESCRIPTION</p>
    <div contenteditable="true"><button>PRIVATE</button></div>
    <div data-telemetry-private><button>PRIVATE</button></div>`;
  for (const element of document.body.querySelectorAll('span, button, a, input, select, p')) {
    // The first named button is tested through its nested icon/text only.
    if (element.matches('button[data-telemetry-action="task.title.edit"]')) continue;
    (element as HTMLElement).click();
  }
  expect(client.recordOperation.mock.calls.map(([name]) => name)).toEqual([
    'task.title.edit', 'ui.button.activate', 'ui.link.activate', 'ui.checkbox.activate', 'ui.select.activate',
  ]);
  expect(JSON.stringify(client.recordOperation.mock.calls)).not.toMatch(/PRIVATE|SECRET|href|value/);
  stop();
  document.querySelector('button')?.click();
  expect(client.recordOperation).toHaveBeenCalledTimes(5);
});
