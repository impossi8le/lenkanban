import { apiRouteTemplate } from '../api-observation-routes';
import { isBreadcrumbName } from './breadcrumbs';
import type { TelemetryOutcome } from './contract';
import type { TelemetryScreen } from './catalog';

interface DiagnosticSink {
  recordRequestTiming(route: string, details: { durationMs: number; statusCode?: number; outcome?: TelemetryOutcome }): boolean;
  recordOperation(name: string): boolean;
  subscribeSessionChange?(listener: () => void): () => void;
}

/** Only closed labels leave this function; paths, queries and fragments never do. */
export function screenForTelemetry(pathname: string | null): TelemetryScreen | null {
  if (pathname === '/') return 'home';
  if (/^\/projects\/[^/]+\/board\/?$/.test(pathname ?? '')) return 'board';
  if (/^\/projects\/[^/]+\/tasks\/[^/]+\/?$/.test(pathname ?? '')) return 'task.detail';
  if (/^\/admin\/telemetry(?:\/|$)/.test(pathname ?? '')) return 'admin.telemetry';
  if (/^\/admin(?:\/|$)/.test(pathname ?? '')) return 'admin';
  for (const screen of ['my-tasks', 'inbox', 'messages', 'analytics', 'settings', 'login', 'register'] as const) {
    if (pathname === `/${screen}` || pathname?.startsWith(`/${screen}/`)) return screen;
  }
  return null;
}

/** Resource timing is a browser observation (including cache), not server/handler time.
 * Missing status/failed-or-cancelled entries are never invented. Only requests that
 * STARTED in this identity's observation window may be attributed to it. */
export function resourceObservation(entry: PerformanceEntry, origin: string, notBefore: number) {
  try {
    const resource = entry as PerformanceResourceTiming & { responseStatus?: number };
    if (!Number.isFinite(notBefore) || notBefore < 0 || entry.entryType !== 'resource' || !['fetch', 'xmlhttprequest'].includes(resource.initiatorType)
      || !Number.isFinite(entry.startTime) || entry.startTime < notBefore
      || !Number.isFinite(entry.duration) || entry.duration < 0 || entry.duration > 86_400_000) return null;
    const url = new URL(entry.name, origin);
    if (url.origin !== origin || url.username || url.password) return null;
    const route = apiRouteTemplate(url.pathname);
    if (!route || route === '/api/telemetry' || route.startsWith('/api/telemetry/')
      || route.startsWith('/api/admin/telemetry')) return null;
    const status = resource.responseStatus;
    const statusCode = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const outcome: TelemetryOutcome | undefined = statusCode === undefined ? undefined
      : statusCode === 409 ? 'conflict' : statusCode >= 500 ? 'failure' : statusCode >= 400 ? 'rejected' : 'success';
    return { route, details: {
      durationMs: Math.round(entry.duration * 100) / 100,
      ...(statusCode !== undefined ? { statusCode, outcome } : {}),
    } };
  } catch { return null; }
}

/** Passive: does not patch fetch, wait for requests, read bodies or send directly.
 * The existing signed client owns the bounded queue and delivery. */
export function observeBrowserRequests(sink: DiagnosticSink): () => void {
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return () => undefined;
  let active = true;
  let observer: PerformanceObserver | undefined;
  let unsubscribe = () => {};
  try {
    const origin = window.location.origin;
    let notBefore = performance.now();
    unsubscribe = sink.subscribeSessionChange?.(() => { notBefore = performance.now(); }) ?? unsubscribe;
    observer = new PerformanceObserver(list => {
      if (!active) return;
      for (const entry of list.getEntries()) {
        const observation = resourceObservation(entry, origin, notBefore);
        if (observation) {
          try { sink.recordRequestTiming(observation.route, observation.details); } catch { /* Never break business UI. */ }
        }
      }
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch { observer?.disconnect(); unsubscribe(); }
  return () => { active = false; observer?.disconnect(); unsubscribe(); };
}

/** Last control activations only. No DOM text, aria-label, href, ID, form value,
 * selector or typing is read. Known controls may opt into a closed machine name. */
export function observeControlActivations(sink: DiagnosticSink): () => void {
  if (typeof document === 'undefined') return () => undefined;
  const listener = (event: MouseEvent) => {
    try {
      const target = event.target;
      if (!(target instanceof Element) || target.closest('[data-telemetry-private], [contenteditable="true"]')) return;
      const control = target.closest('button,[role="button"],a[href],[role="link"],input[type="checkbox"],[role="checkbox"],select,[role="combobox"]');
      if (!control) return;
      const explicit = control.getAttribute('data-telemetry-action');
      const name = explicit && isBreadcrumbName('operation', explicit) ? explicit
        : control.matches('input[type="checkbox"],[role="checkbox"]') ? 'ui.checkbox.activate'
          : control.matches('select,[role="combobox"]') ? 'ui.select.activate'
            : control.matches('a[href],[role="link"]') ? 'ui.link.activate' : 'ui.button.activate';
      sink.recordOperation(name);
    } catch { /* Telemetry cannot prevent click/default action. */ }
  };
  document.addEventListener('click', listener, { capture: true, passive: true });
  return () => document.removeEventListener('click', listener, true);
}
