import { act, render, screen, waitFor } from '@testing-library/react';
import CentralSessionBoundary from './CentralSessionBoundary';

jest.mock('~/hooks/useLocalize', () => ({ __esModule: true, default: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => ({ apiBaseUrl: () => '' }));
jest.mock('~/utils/centralDraftScope', () => ({
  centralReference: (token?: string) => (token === 'central' ? 'reference' : undefined),
  clearCentralDrafts: jest.fn(),
  lockCentralDrafts: jest.fn(),
  unlockCentralDrafts: jest.fn(),
}));
beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
});
test('legacy renders without a central network request', () => {
  render(
    <CentralSessionBoundary>
      <div>{'Legacy page'}</div>
    </CentralSessionBoundary>,
  );
  expect(screen.getByText('Legacy page')).toBeVisible();
  expect(fetch).not.toHaveBeenCalled();
});
test('central content waits for exact 204; later focus covers it until revalidated', async () => {
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
  expect(screen.getByText('Private draft')).not.toBeVisible();
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(screen.getByText('Private draft')).not.toBeVisible();
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
