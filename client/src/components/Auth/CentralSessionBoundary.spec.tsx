import { act, render, screen, waitFor } from '@testing-library/react';
import { clearCentralDrafts, lockCentralDrafts } from '~/utils/centralDraftScope';
import CentralSessionBoundary from './CentralSessionBoundary';

jest.mock('~/hooks/useLocalize', () => ({ __esModule: true, default: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => ({ apiBaseUrl: () => '' }));
jest.mock('~/utils/centralDraftScope', () => ({
  // 'central' and a refreshed 'central-refreshed' share one session; 'other' is a new session.
  centralReference: (token?: string) =>
    (
      ({
        central: 'reference',
        'central-refreshed': 'reference',
        other: 'other-reference',
      }) as Record<string, string>
    )[token ?? ''],
  clearCentralDrafts: jest.fn(),
  lockCentralDrafts: jest.fn(),
  unlockCentralDrafts: jest.fn(),
}));
beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
  jest.clearAllMocks();
});
const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  Object.defineProperty(document, 'hidden', { configurable: true, value: state === 'hidden' });
};
afterEach(() => setVisibility('visible'));
const composer = (token: string) => (
  <CentralSessionBoundary token={token}>
    <textarea aria-label="composer" defaultValue="Handoff draft" />
  </CentralSessionBoundary>
);
const showVerifiedComposer = async (token = 'central') => {
  const view = render(composer(token));
  await waitFor(() => expect(screen.getByLabelText('composer')).toBeVisible());
  const input = screen.getByLabelText('composer') as HTMLTextAreaElement;
  input.focus();
  // The first check covers and locks by design; later assertions concern only revalidation.
  jest.mocked(lockCentralDrafts).mockClear();
  return { view, input };
};
test('legacy renders without a central network request', () => {
  render(
    <CentralSessionBoundary>
      <div>{'Legacy page'}</div>
    </CentralSessionBoundary>,
  );
  expect(screen.getByText('Legacy page')).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
});
test('central content waits for exact 204; a failed later revalidation covers it', async () => {
  (fetch as unknown as jest.Mock)
    .mockResolvedValueOnce({ status: 204 })
    .mockResolvedValueOnce({ status: 503 });
  render(
    <CentralSessionBoundary token="central">
      <div>{'Private draft'}</div>
    </CentralSessionBoundary>,
  );
  await waitFor(() => expect(screen.getByText('Private draft')).toBeVisible());
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.getByText('Private draft')).not.toBeVisible());
  expect(screen.getByRole('button', { name: 'com_ui_retry' })).toBeVisible();
  expect(fetch).toHaveBeenLastCalledWith(
    '/api/auth/central-session-check',
    expect.objectContaining({
      headers: { Authorization: 'Bearer central' },
      redirect: 'error',
      cache: 'no-store',
      credentials: 'same-origin',
    }),
  );
});
test('late success after pagehide cannot reveal old content', async () => {
  let resolve!: (value: { status: number }) => void;
  (fetch as unknown as jest.Mock).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  render(
    <CentralSessionBoundary token="central">
      <div>{'Private draft'}</div>
    </CentralSessionBoundary>,
  );
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  await act(async () => {
    resolve({ status: 204 });
  });
  expect(screen.queryByText('Private draft')).toBeNull();
});

test('older successful check cannot override a newer failed check', async () => {
  let resolve!: (value: { status: number }) => void;
  (fetch as unknown as jest.Mock)
    .mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    )
    .mockResolvedValueOnce({ status: 503 });
  render(
    <CentralSessionBoundary token="central">
      <div>{'Private draft'}</div>
    </CentralSessionBoundary>,
  );
  act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  await act(async () => {
    resolve({ status: 204 });
  });
  expect(screen.queryByText('Private draft')).toBeNull();
});

test('cross-tab notification only triggers a check, and failed check keeps private content covered', async () => {
  const original = global.BroadcastChannel;
  let channel: { onmessage?: (event: { data: string }) => void };
  global.BroadcastChannel = class {
    onmessage?: (event: { data: string }) => void;
    constructor() {
      // Capture the fake channel so the test can deliver a browser event.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      channel = this;
    }

    close() {}

    postMessage() {}
  } as unknown as typeof BroadcastChannel;
  try {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce({ status: 204 })
      .mockResolvedValueOnce({ status: 503 });
    render(
      <CentralSessionBoundary token="central">
        <div>{'Private draft'}</div>
      </CentralSessionBoundary>,
    );
    await waitFor(() => expect(screen.getByText('Private draft')).toBeVisible());
    act(() => {
      channel.onmessage?.({ data: 'check' });
    });
    expect(screen.getByText('Private draft')).not.toBeVisible();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Private draft')).not.toBeVisible();
  } finally {
    global.BroadcastChannel = original;
  }
});

test('new session signals other tabs once, without echoing checks or exposing identity', async () => {
  const original = global.BroadcastChannel;
  const postMessage = jest.fn();
  global.BroadcastChannel = class {
    postMessage = postMessage;
    close() {}
  } as unknown as typeof BroadcastChannel;
  try {
    (fetch as unknown as jest.Mock).mockResolvedValue({ status: 204 });
    const view = render(
      <CentralSessionBoundary token="central">
        <div>{'Private draft'}</div>
      </CentralSessionBoundary>,
    );
    await waitFor(() => expect(screen.getByText('Private draft')).toBeVisible());
    view.rerender(
      <CentralSessionBoundary token="central">
        <div>{'Updated draft'}</div>
      </CentralSessionBoundary>,
    );
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByText('Updated draft')).toBeVisible());
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith('check');
  } finally {
    global.BroadcastChannel = original;
  }
});

describe('revalidation while the page stayed visible', () => {
  test('window focus keeps the composer visible and focused while checking in the background', async () => {
    let resolve!: (value: { status: number }) => void;
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce({ status: 204 })
      .mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const { input } = await showVerifiedComposer();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    // Typing continues during the check: no cover, no draft lock, no lost focus.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(input).toBeVisible();
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole('status')).toBeNull();
    expect(lockCentralDrafts).not.toHaveBeenCalled();
    await act(async () => resolve({ status: 204 }));
    expect(input).toBeVisible();
    expect(input.value).toBe('Handoff draft');
  });

  test('a refreshed token for the same central session does not cover the composer', async () => {
    (fetch as unknown as jest.Mock).mockResolvedValue({ status: 204 });
    const { view, input } = await showVerifiedComposer();
    view.rerender(composer('central-refreshed'));
    expect(input).toBeVisible();
    expect(screen.queryByRole('status')).toBeNull();
    expect(lockCentralDrafts).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(fetch).toHaveBeenLastCalledWith(
        '/api/auth/central-session-check',
        expect.objectContaining({ headers: { Authorization: 'Bearer central-refreshed' } }),
      ),
    );
    expect(input).toBeVisible();
  });

  test('a revoked session found in the background still leaves the page', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce({ status: 204 })
      .mockResolvedValueOnce({ status: 401 });
    await showVerifiedComposer();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    // Only the 401/403 branch clears drafts before replacing the document (jsdom ignores the navigation).
    await waitFor(() => expect(clearCentralDrafts).toHaveBeenCalledTimes(1));
  });
});

describe('protections that still cover until revalidated', () => {
  test('a different central session reference covers the composer', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce({ status: 204 })
      .mockReturnValueOnce(new Promise(() => {}));
    const { view } = await showVerifiedComposer();
    view.rerender(composer('other'));
    expect(screen.getByLabelText('composer')).not.toBeVisible();
    expect(screen.getByRole('status')).toBeVisible();
    expect(lockCentralDrafts).toHaveBeenCalled();
  });

  test('returning to a hidden tab covers until the check succeeds', async () => {
    let resolve!: (value: { status: number }) => void;
    const pending = new Promise<{ status: number }>((r) => (resolve = r));
    (fetch as unknown as jest.Mock).mockResolvedValueOnce({ status: 204 }).mockReturnValue(pending);
    await showVerifiedComposer();
    act(() => {
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(screen.getByLabelText('composer')).not.toBeVisible();
    act(() => {
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByLabelText('composer')).not.toBeVisible();
    await act(async () => resolve({ status: 204 }));
    await waitFor(() => expect(screen.getByLabelText('composer')).toBeVisible());
  });

  test('a page restored from the back/forward cache covers until revalidated', async () => {
    (fetch as unknown as jest.Mock)
      .mockResolvedValueOnce({ status: 204 })
      .mockReturnValueOnce(new Promise(() => {}));
    await showVerifiedComposer();
    act(() => {
      const event = new Event('pageshow') as Event & { persisted?: boolean };
      Object.defineProperty(event, 'persisted', { value: true });
      window.dispatchEvent(event);
    });
    expect(screen.getByLabelText('composer')).not.toBeVisible();
  });
});
