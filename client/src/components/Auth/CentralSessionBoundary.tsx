import { useLayoutEffect, useRef, useState } from 'react';
import useLocalize from '~/hooks/useLocalize';
import { apiBaseUrl } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  centralReference,
  clearCentralDrafts,
  lockCentralDrafts,
  unlockCentralDrafts,
} from '~/utils/centralDraftScope';

const CHANNEL = 'openschool-central-session-check';
export function signalCentralSessionChange() {
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage('check'); // No identity or token crosses tabs.
    channel.close();
  } catch {
    /* focus/pageshow validation still applies */
  }
}

export default function CentralSessionBoundary({
  token,
  children,
}: {
  token?: string;
  children: ReactNode;
}) {
  const localize = useLocalize();
  const content = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false);
  const [verified, setVerified] = useState(false);
  const retry = useRef<() => void>(() => {});
  const reference = centralReference(token);
  const central = reference != null;
  useLayoutEffect(() => {
    // A newly signed-in tab may replace shared cookies while another tab stays open.
    // Notify only on a session change, not on each check or token refresh.
    if (reference) signalCentralSessionChange();
  }, [reference]);
  useLayoutEffect(() => {
    if (!central || !token) return;
    let generation = 0;
    let disposed = false;
    let controller: AbortController | undefined;
    const hide = () => {
      generation++;
      controller?.abort();
      lockCentralDrafts();
      if (content.current) content.current.style.display = 'none';
      setPending(true);
    };
    const check = async () => {
      hide();
      if (document.visibilityState === 'hidden') return;
      const own = generation;
      controller = new AbortController();
      const ownController = controller;
      const timer = window.setTimeout(() => ownController.abort(), 5000);
      try {
        const response = await fetch(`${apiBaseUrl()}/api/auth/central-session-check`, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        });
        if (disposed || own !== generation) return;
        if (response.status === 204) {
          unlockCentralDrafts();
          setVerified(true);
          if (content.current) content.current.style.display = 'contents';
          setPending(false);
        } else if (response.status === 401 || response.status === 403) {
          clearCentralDrafts();
          // Full document replacement drops queries, attachments and late async callbacks.
          // Never call logout with the newer browser's cookies, or clear another scope.
          window.location.replace(`${apiBaseUrl()}/login?redirect=false`);
        }
      } catch {
        /* Network/503 stays covered; retry does not renew the session. */
      } finally {
        window.clearTimeout(timer);
      }
    };
    const visibility = () => {
      if (document.hidden) hide();
      else void check();
    };
    const resume = () => {
      void check();
    };
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event) => {
        if (event.data === 'check') void check();
      };
    } catch {
      /* optional transport */
    }
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', resume);
    window.addEventListener('focus', resume);
    retry.current = resume;
    void check();
    return () => {
      disposed = true;
      generation++;
      controller?.abort();
      channel?.close();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('focus', resume);
    };
  }, [central, token]);
  return (
    <>
      {central && pending && (
        <main role="status" className="p-6">
          <p>{localize('com_ui_loading')}</p>
          <button type="button" onClick={() => retry.current()}>
            {localize('com_ui_retry')}
          </button>
        </main>
      )}
      <div ref={content} style={{ display: central && pending ? 'none' : 'contents' }}>
        {!central || verified ? children : null}
      </div>
    </>
  );
}
