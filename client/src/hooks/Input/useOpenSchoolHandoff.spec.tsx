import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderHook, act, waitFor } from '@testing-library/react';
import useOpenSchoolHandoff from './useOpenSchoolHandoff';
import {
  HANDOFF_KEY,
  HANDOFF_TTL,
  captureHandoff,
  readHandoff,
  handoffUserId,
} from './openschoolHandoff';

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
  Constants: { NEW_CONVO: 'new' },
  EModelEndpoint: { custom: 'custom' },
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useGetModelsQuery: () => ({ data: mockModels }),
}));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => mockAuth }));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockConfig }),
  useGetEndpointsQuery: () => ({ data: mockEndpoints }),
}));
jest.mock('~/Providers', () => ({
  useChatContext: () => ({ conversation: mockConversation, newConversation: mockNewConversation }),
  useChatFormContext: () => mockMethods,
}));

const id = 'a'.repeat(64);
const ownerId = '507f1f77bcf86cd799439011';
const otherId = '507f1f77bcf86cd799439012';
const invalidUsers = [
  null,
  {},
  { email: 'same@example.test', googleId: 'same-subject' },
  { id: '' },
  { _id: ' ' },
  { id: ownerId, _id: '' },
  { id: '', _id: ownerId },
  { id: ownerId, _id: null },
  { id: undefined, _id: ownerId },
  { id: ownerId, _id: otherId },
  { id: 42, _id: ownerId },
  { _id: { $oid: ownerId } },
];
const link = `/c/new?endpoint=OpenSchool&model=personal&os_handoff=${id}&prompt=unsafe&q=unsafe&submit=true&autosubmit=true`;
let mockAuth: {
  user: Record<string, unknown> | null;
  token: string;
  isAuthenticated: boolean;
} = { user: { id: 'owner' }, token: 'jwt', isAuthenticated: true };
let mockConfig = { openschoolPromptHandoffEnabled: true };
let mockEndpoints: Record<string, object> | undefined = { OpenSchool: {} };
let mockModels = { OpenSchool: ['personal', 'circle-adult'] };
let mockConversation = {
  conversationId: 'new',
  endpoint: 'other',
  model: 'other',
  endpointType: 'custom',
};
const mockNewConversation = jest.fn();
let mockText = '';
const mockMethods = {
  getValues: jest.fn(() => mockText),
  setValue: jest.fn((_name, value: string) => {
    mockText = value;
  }),
};
let mockFetch: jest.Mock;
const originalFetch = global.fetch;

function draft(overrides = {}) {
  return {
    prompt: 'private user draft',
    model: 'personal',
    expiresAtUtc: new Date(Date.now() + 60000).toISOString(),
    ...overrides,
  };
}
function response(status = 200, value = draft()) {
  return { ok: status === 200, status, json: jest.fn().mockResolvedValue(value) };
}
function mount(url = link, strict = false) {
  const textAreaRef = { current: document.createElement('textarea') };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <MemoryRouter initialEntries={[url]}>
      {strict ? <React.StrictMode>{children}</React.StrictMode> : children}
    </MemoryRouter>
  );
  return renderHook(() => useOpenSchoolHandoff({ textAreaRef }), { wrapper });
}
async function modelReady(hook: ReturnType<typeof mount>) {
  await waitFor(() => expect(mockNewConversation).toHaveBeenCalled());
  mockConversation = {
    conversationId: 'new',
    endpoint: 'OpenSchool',
    model: 'personal',
    endpointType: 'custom',
  };
  hook.rerender();
  await waitFor(() => expect(hook.result.current.phase).toBe('success'));
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  jest.clearAllMocks();
  mockAuth = { user: { id: 'owner' }, token: 'jwt', isAuthenticated: true };
  mockConfig = { openschoolPromptHandoffEnabled: true };
  mockEndpoints = { OpenSchool: {} };
  mockModels = { OpenSchool: ['personal', 'circle-adult'] };
  mockConversation = {
    conversationId: 'new',
    endpoint: 'other',
    model: 'other',
    endpointType: 'custom',
  };
  mockText = '';
  mockFetch = jest.fn().mockResolvedValue(response());
  global.fetch = Object.assign(mockFetch, { preconnect: jest.fn() });
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    value: jest.fn(() => new AbortController().signal),
  });
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

test('StrictMode consumes once, waits for correct new model, ignores URL prompt/autosubmit', async () => {
  const hook = mount(link, true);
  await waitFor(() => expect(mockNewConversation).toHaveBeenCalledTimes(1));
  expect(mockMethods.setValue).not.toHaveBeenCalled();
  expect(mockNewConversation).toHaveBeenCalledWith(
    expect.objectContaining({
      template: { conversationId: 'new', chatProjectId: null },
      preset: { endpoint: 'OpenSchool', endpointType: 'custom', model: 'personal' },
      keepComposerState: true,
    }),
  );
  await modelReady(hook);
  expect(mockText).toBe('private user draft');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch.mock.calls[0][1].body).toBe(JSON.stringify({ id }));
  expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull();
  expect(localStorage.length).toBe(0);
  expect(hook.result.current.active).toBe(true);
  hook.rerender();
  expect(mockMethods.setValue).toHaveBeenCalledTimes(1);
});
test('existing text requires an explicit append and is preserved', async () => {
  mockText = 'my writing';
  const hook = mount();
  await waitFor(() => expect(hook.result.current.phase).toBe('confirm'));
  expect(mockText).toBe('my writing');
  expect(mockNewConversation).not.toHaveBeenCalled();
  act(() => hook.result.current.confirm());
  await modelReady(hook);
  expect(mockText).toBe('my writing\n\nprivate user draft');
});
test('cancel keeps existing text without switching or filling', async () => {
  mockText = 'keep this';
  const hook = mount();
  await waitFor(() => expect(hook.result.current.phase).toBe('confirm'));
  act(() => hook.result.current.cancel());
  expect(mockText).toBe('keep this');
  expect(mockNewConversation).not.toHaveBeenCalled();
  expect(mockMethods.setValue).not.toHaveBeenCalled();
});
test('typing while model initialization is pending prompts again', async () => {
  const hook = mount();
  await waitFor(() => expect(mockNewConversation).toHaveBeenCalled());
  mockText = 'typed during switch';
  mockConversation = {
    conversationId: 'new',
    endpoint: 'OpenSchool',
    model: 'personal',
    endpointType: 'custom',
  };
  hook.rerender();
  await waitFor(() => expect(hook.result.current.phase).toBe('confirm'));
  expect(mockText).toBe('typed during switch');
  expect(mockMethods.setValue).not.toHaveBeenCalled();
});
test('OAuth resume stores only ID and deadline, consumes only after authentication', async () => {
  mockAuth.isAuthenticated = false;
  mockAuth.token = '';
  captureHandoff(new URLSearchParams(link.split('?')[1]));
  expect(Object.keys(JSON.parse(sessionStorage.getItem(HANDOFF_KEY)!))).toEqual([
    'id',
    'expiresAt',
  ]);
  const hook = mount('/c/new');
  expect(mockFetch).not.toHaveBeenCalled();
  mockAuth = { user: { id: 'owner' }, token: 'jwt', isAuthenticated: true };
  hook.rerender();
  await modelReady(hook);
  expect(mockText).toBe('private user draft');
});
test('expired session is cleared with visible failure and no consume', () => {
  sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ id, expiresAt: Date.now() - 1 }));
  const hook = mount('/c/new');
  expect(hook.result.current.phase).toBe('expired');
  expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull();
  expect(mockFetch).not.toHaveBeenCalled();
});
test('disabled feature does not consume or fill', async () => {
  mockConfig.openschoolPromptHandoffEnabled = false;
  const hook = mount();
  await waitFor(() => expect(hook.result.current.phase).toBe('disabled'));
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockMethods.setValue).not.toHaveBeenCalled();
});
test.each([400, 403, 404, 503, 401])(
  'status %s yields UX without retry or reading error body',
  async (status) => {
    const result = response(status);
    mockFetch.mockResolvedValue(result);
    const hook = mount();
    const phase = {
      400: 'invalid',
      403: 'forbidden',
      404: 'expired',
      503: 'unavailable',
      401: 'login',
    }[status];
    await waitFor(() => expect(hook.result.current.phase).toBe(phase));
    expect(result.json).not.toHaveBeenCalled();
    expect(mockMethods.setValue).not.toHaveBeenCalled();
    hook.rerender();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(HANDOFF_KEY) != null).toBe(status === 401);
  },
);
test('account change during fetch never exposes the old account draft', async () => {
  let resolve!: (value: ReturnType<typeof response>) => void;
  mockFetch.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const hook = mount();
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  mockAuth = { user: { id: 'other' }, token: 'other-jwt', isAuthenticated: true };
  hook.rerender();
  await act(async () => resolve(response()));
  expect(hook.result.current.phase).toBe('forbidden');
  expect(mockMethods.setValue).not.toHaveBeenCalled();
});
test('refresh _id-only to GET id+_id during HTTP 200 preserves the same account', async () => {
  const owner = '507f1f77bcf86cd799439011';
  mockAuth.user = { _id: owner };
  const ok = response();
  let resolve!: (value: ReturnType<typeof response>) => void;
  mockFetch.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const hook = mount(link, true);
  await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
  mockAuth.user = { _id: owner, id: owner };
  hook.rerender();
  await act(async () => resolve(ok));
  expect(ok.status).toBe(200);
  expect(hook.result.current.phase).not.toBe('forbidden');
  await modelReady(hook);
  expect(mockText).toBe('private user draft');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockMethods.setValue).toHaveBeenCalledTimes(1);
});
test('refresh _id-only to GET id+_id after prefill keeps the same account draft', async () => {
  const owner = '507f1f77bcf86cd799439011';
  mockAuth.user = { _id: owner };
  const hook = mount();
  await modelReady(hook);
  mockAuth.user = { _id: owner, id: owner };
  hook.rerender();
  expect(hook.result.current.phase).toBe('success');
  expect(mockText).toBe('private user draft');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockMethods.setValue).toHaveBeenCalledTimes(1);
});
test.each([{ id: ownerId }, { _id: ownerId }, { id: ownerId, _id: ownerId }])(
  'canonical identity accepts each valid server shape: %j',
  (user) => {
    expect(handoffUserId(user)).toBe(ownerId);
  },
);
test.each(invalidUsers)('invalid or missing identity never consumes: %j', async (user) => {
  expect(handoffUserId(user)).toBeUndefined();
  mockAuth.user = user;
  const hook = mount();
  await waitFor(() => expect(hook.result.current.phase).toBe('forbidden'));
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockMethods.setValue).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(HANDOFF_KEY)).toBeNull();
});
test.each(invalidUsers)(
  'identity loss/conflict during HTTP 200 discards the response: %j',
  async (user) => {
    mockAuth.user = { _id: ownerId };
    let resolve!: (value: ReturnType<typeof response>) => void;
    mockFetch.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const hook = mount();
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    mockAuth.user = user;
    hook.rerender();
    await act(async () => resolve(response()));
    expect(hook.result.current.phase).toBe('forbidden');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockMethods.setValue).not.toHaveBeenCalled();
    expect(mockNewConversation).not.toHaveBeenCalled();
  },
);
test('equivalent id-only to _id-only shape during model setup preserves the owner', async () => {
  mockAuth.user = { id: ownerId };
  const hook = mount();
  await waitFor(() => expect(mockNewConversation).toHaveBeenCalledTimes(1));
  mockAuth.user = { _id: ownerId };
  hook.rerender();
  await modelReady(hook);
  expect(mockText).toBe('private user draft');
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
test('real _id account switch during model readiness never prefills the new account', async () => {
  mockAuth.user = { _id: ownerId };
  const hook = mount();
  await waitFor(() => expect(mockNewConversation).toHaveBeenCalledTimes(1));
  mockAuth.user = { _id: otherId };
  mockConversation = {
    conversationId: 'new',
    endpoint: 'OpenSchool',
    model: 'personal',
    endpointType: 'custom',
  };
  hook.rerender();
  expect(hook.result.current.phase).toBe('forbidden');
  expect(mockMethods.setValue).not.toHaveBeenCalled();
  expect(mockFetch).toHaveBeenCalledTimes(1);
});
test.each([null, {}, { _id: otherId }, { id: ownerId, _id: otherId }])(
  'identity loss, real switch or conflicting aliases after prefill clears the draft: %j',
  async (user) => {
    mockAuth.user = { _id: ownerId };
    const hook = mount();
    await modelReady(hook);
    mockAuth.user = user;
    hook.rerender();
    expect(hook.result.current.phase).toBe('forbidden');
    expect(mockText).toBe('');
    expect(mockMethods.setValue).toHaveBeenLastCalledWith('text', '', { shouldDirty: false });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  },
);
test('malformed link never consumes or uses prompt', () => {
  const hook = mount(
    '/c/new?endpoint=OpenSchool&model=personal&os_handoff=bad&prompt=unsafe&submit=true',
  );
  expect(hook.result.current.phase).toBe('invalid');
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockMethods.setValue).not.toHaveBeenCalled();
});
test('Web model mismatch and oversized prompt are refused', async () => {
  mockFetch.mockResolvedValue(
    response(200, draft({ model: 'circle-adult', prompt: 'x'.repeat(6001) })),
  );
  const hook = mount();
  await waitFor(() => expect(hook.result.current.phase).toBe('expired'));
  expect(mockMethods.setValue).not.toHaveBeenCalled();
});
test('pending ID TTL is not extended on rerender/reentry', () => {
  const params = new URLSearchParams(link.split('?')[1]);
  const first = captureHandoff(params);
  const second = captureHandoff(params);
  expect(second).toEqual(first);
  expect(readHandoff().pending?.expiresAt).toBeLessThanOrEqual(Date.now() + HANDOFF_TTL);
});
test('confirm draft expires in memory without overwriting user text', async () => {
  jest.useFakeTimers();
  mockText = 'my writing';
  const hook = mount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(hook.result.current.phase).toBe('confirm');
  act(() => {
    jest.advanceTimersByTime(60001);
  });
  expect(hook.result.current.phase).toBe('expired');
  expect(mockText).toBe('my writing');
  expect(mockMethods.setValue).not.toHaveBeenCalled();
});
