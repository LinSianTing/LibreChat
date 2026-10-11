import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ArchivedChatsTable from '~/components/Nav/SettingsTabs/General/ArchivedChatsTable';
import { conversationDeleteErrorKey } from '~/utils/conversationDeleteError';
import { DeleteConversationDialog } from '../DeleteButton';
import mockZh from '~/locales/zh-Hant/translation.json';
import mockEn from '~/locales/en/translation.json';

let mockLocale: 'en' | 'zh-Hant' = 'zh-Hant';
const mockToast = jest.fn();
const mockMutate = jest.fn();
const mockNavigate = jest.fn();
const mockRefetch = jest.fn();
let mockCallbacks: { onError: (error: unknown) => void };
const pending = {
  response: {
    status: 409,
    data: { code: 'OPENSCHOOL_DELETION_PENDING', error: 'private identifiers' },
  },
};

jest.mock('~/data-provider', () => ({
  useDeleteConversationMutation: (callbacks: typeof mockCallbacks) => {
    mockCallbacks = callbacks;
    return { mutate: mockMutate, isLoading: false };
  },
  useArchiveConvoMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useConversationsInfiniteQuery: () => ({
    data: { pages: [{ conversations: [{ conversationId: 'chat', title: 'Retained chat' }] }] },
    refetch: mockRefetch,
  }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: keyof typeof mockZh) =>
    (mockLocale === 'en' ? mockEn : mockZh)[key] ?? key,
  useNewConvo: () => ({ newConversation: mockNavigate }),
}));
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({ conversationId: 'chat' }),
}));
jest.mock('recoil', () => ({ useRecoilValue: () => ({ enabled: false }) }));
jest.mock('~/store', () => ({ search: {} }));
jest.mock('~/utils', () => ({ formatDate: () => '', logger: { error: jest.fn() } }));
jest.mock('~/components/Endpoints', () => ({ MinimalIcon: () => null }));
jest.mock('react-i18next', () => ({
  Trans: ({ values }: { values: { title: string } }) => <span>{values.title}</span>,
}));
jest.mock('@librechat/client', () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
  Spinner: () => null,
  OGDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
  OGDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogClose: ({ children }: { children: React.ReactNode }) => children,
  TooltipAnchor: ({ render: content }: { render: React.ReactNode }) => content,
  useToastContext: () => ({ showToast: mockToast }),
  useMediaQuery: () => false,
  VirtualizedDataTable: ({
    data,
    columns,
  }: {
    data: Array<{ title: string }>;
    columns: Array<{ id?: string; cell: (arg: unknown) => React.ReactNode }>;
  }) => (
    <div>
      {data.map((row) => (
        <div key={row.title}>
          {row.title}
          {columns.find((column) => column.id === 'actions')?.cell({ row: { original: row } })}
        </div>
      ))}
    </div>
  ),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockLocale = 'zh-Hant';
});

it.each([
  undefined,
  null,
  'OPENSCHOOL_DELETION_PENDING',
  { code: 'OPENSCHOOL_DELETION_PENDING' },
  { response: { status: 500, data: pending.response.data } },
  { response: { status: 409, data: { code: 'UNKNOWN', error: 'private identifiers' } } },
  { response: { status: 409, data: JSON.stringify(pending.response.data) } },
])('keeps unknown or malformed errors generic: %p', (error) => {
  expect(conversationDeleteErrorKey(error)).toBe('com_ui_convo_delete_error');
  expect(conversationDeleteErrorKey(error, 'com_ui_archive_delete_error')).toBe(
    'com_ui_archive_delete_error',
  );
});

it('provides retry copy in English and Traditional Chinese', () => {
  expect(mockEn.com_ui_convo_delete_pending).toContain('Please try again later');
  expect(mockZh.com_ui_convo_delete_pending).toContain('請稍後再試');
});

it('keeps the delete dialog and conversation after pending, with a retry action', () => {
  const close = jest.fn();
  const retainView = jest.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DeleteConversationDialog
        setShowDeleteDialog={close}
        conversationId="chat"
        retainView={retainView}
        title="Retained chat"
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: mockZh.com_ui_delete }));
  act(() => mockCallbacks.onError(pending));
  expect(mockToast).toHaveBeenCalledWith(
    expect.objectContaining({ message: mockZh.com_ui_convo_delete_pending }),
  );
  expect(close).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
  expect(retainView).not.toHaveBeenCalled();
  expect(screen.getByText('Retained chat')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: mockZh.com_ui_delete }));
  expect(mockMutate).toHaveBeenCalledTimes(2);
});

it.each([
  [pending, mockZh.com_ui_convo_delete_pending],
  [
    { response: { status: 503, data: { error: 'private identifiers' } } },
    mockZh.com_ui_archive_delete_error,
  ],
])('keeps the archive dialog open on failure and uses safe copy', (error, message) => {
  render(<ArchivedChatsTable />);
  fireEvent.click(screen.getByRole('button', { name: mockZh.com_ui_delete_conversation_tooltip }));
  fireEvent.click(screen.getByRole('button', { name: mockZh.com_ui_delete }));
  act(() => mockCallbacks.onError(error));
  expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ message }));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(mockRefetch).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: mockZh.com_ui_delete }));
  expect(mockMutate).toHaveBeenCalledTimes(2);
});

// Accessible-name regression; real keyboard close/focus is covered by the browser harness.
it.each([
  ['en', 'Cancel'],
  ['zh-Hant', '取消'],
] as const)('exposes the visible %s cancel label as its accessible name', (locale, name) => {
  mockLocale = locale;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DeleteConversationDialog
        setShowDeleteDialog={jest.fn()}
        conversationId="chat"
        retainView={jest.fn()}
        title="Retained chat"
      />
    </QueryClientProvider>,
  );
  expect(screen.getByRole('button', { name })).toHaveTextContent(name);
});
