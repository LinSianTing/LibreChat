/**
 * OpenSchool fork (see OPENSCHOOL.md): the return link a gateway refusal offers. The refusal's own
 * text stays text; a separate link appears only for the configured URL (plus `?circle=<code>`).
 */
import React from 'react';
import { ErrorTypes } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import { findOpenSchoolReturnUrl } from '../Error/openschoolReturn';
import { ChatContext } from '~/Providers/ChatContext';
import Error from '../Error';

const RETURN_URL = 'http://127.0.0.1:5199/simulation/ai-circles';
let mockStartupData: { openschoolReturnUrl?: string } = { openschoolReturnUrl: RETURN_URL };

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, values?: Record<string, unknown>): string => {
      const template =
        (jest.requireActual('~/locales/en/translation.json') as Record<string, string>)[key] ?? key;
      return values
        ? template.replace(/\{\{(\w+)\}\}/g, (match, name) =>
            values[name] != null ? String(values[name]) : match,
          )
        : template;
    },
  useHasAccess: () => false,
  useExpandCollapse: (isExpanded: boolean) => ({
    style: { display: 'grid', gridTemplateRows: isExpanded ? '1fr' : '0fr' },
    ref: { current: null },
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: jest.fn(() => ({ data: {} })),
  useGetStartupConfig: jest.fn(() => ({ data: mockStartupData })),
}));

jest.mock('~/components/Input/SetKeyDialog', () => ({ SetKeyDialog: () => null }));

const message = {
  endpoint: 'agents',
  model: 'agent_pine',
  createdAt: new Date('2026-09-30T08:00:00.000Z'),
} as unknown as TMessage;

/** What the OpenSchool gateway's 403 reads like once LibreChat persists it. */
const refusal = (url: string) =>
  `403 你還不是「光影觀察圈（合成）」的成員。請先在開放學校加入這個圈。（返回開放學校共學圈：${url}）`;

function renderInChat(text: string) {
  const chat = { conversation: { conversationId: 'c1' } as Partial<TConversation> };
  return render(
    <ChatContext.Provider value={chat as unknown as React.ContextType<typeof ChatContext>}>
      <Error text={text} message={message} />
    </ChatContext.Provider>,
  );
}

const upstream = (detail: string) =>
  JSON.stringify({ type: ErrorTypes.UPSTREAM_MODEL_ERROR, status: 403, message: detail });

describe('OpenSchool return link', () => {
  beforeEach(() => {
    mockStartupData = { openschoolReturnUrl: RETURN_URL };
  });

  it('renders a real link to the configured page for the refused circle, and keeps the text', () => {
    renderInChat(upstream(refusal(`${RETURN_URL}?circle=light`)));

    const link = screen.getByRole('link', { name: 'Back to Open School circles' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', `${RETURN_URL}?circle=light`);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(document.body.textContent).toContain(`${RETURN_URL}?circle=light`);
    /** Clicking is left to the browser: nothing intercepts it or rewrites the destination. */
    expect(fireEvent.click(link)).toBe(true);
    expect(link).toHaveAttribute('href', `${RETURN_URL}?circle=light`);
  });

  it('also offers the link for plain provider prose and for the circle list', () => {
    renderInChat(`An error occurred while processing the request: ${refusal(RETURN_URL)}`);
    expect(screen.getByRole('link', { name: 'Back to Open School circles' })).toHaveAttribute(
      'href',
      RETURN_URL,
    );
  });

  it.each([
    ['another origin', 'https://evil.example/simulation/ai-circles?circle=light'],
    ['credentials trick', 'http://127.0.0.1:5199@evil.example/simulation/ai-circles'],
    ['another path', 'http://127.0.0.1:5199/admin/community'],
    ['path traversal', 'http://127.0.0.1:5199/simulation/ai-circles/../../admin'],
    ['extra query', `${RETURN_URL}?circle=light&returnUrl=https://evil.example`],
    ['returnUrl only', `${RETURN_URL}?returnUrl=https://evil.example`],
    ['uppercase code', `${RETURN_URL}?circle=LIGHT`],
    ['encoded markup', `${RETURN_URL}?circle=%3Cscript%3E`],
    ['fragment', `${RETURN_URL}?circle=light#x`],
    ['another port', 'http://127.0.0.1:5200/simulation/ai-circles'],
  ])('offers no link for %s', (_name, url) => {
    renderInChat(upstream(refusal(url)));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('offers no link when the deployment configured none', () => {
    mockStartupData = {};
    renderInChat(upstream(refusal(`${RETURN_URL}?circle=light`)));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('offers no link outside the chat (search results, shared links)', () => {
    render(<Error text={upstream(refusal(`${RETURN_URL}?circle=light`))} message={message} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('never turns error text into markup', () => {
    renderInChat(upstream(`<a href="https://evil.example">x</a> ${RETURN_URL}?circle=light`));
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(document.querySelector('a[href^="https://evil.example"]')).toBeNull();
  });
});

describe('OpenSchool gateway refusal', () => {
  const openschoolRow = {
    endpoint: 'OpenSchool',
    model: 'circle-openschool-public',
    createdAt: new Date('2026-10-06T08:00:00.000Z'),
  } as unknown as TMessage;
  const explanation = '你目前沒有使用這個 AI 的資格，請回開放學校確認共學圈。';

  function renderRow(text: string, row: TMessage) {
    const chat = { conversation: { conversationId: 'c1' } as Partial<TConversation> };
    return render(
      <ChatContext.Provider value={chat as unknown as React.ContextType<typeof ChatContext>}>
        <Error text={text} message={row} />
      </ChatContext.Provider>,
    );
  }

  beforeEach(() => {
    mockStartupData = { openschoolReturnUrl: RETURN_URL };
  });

  it('shows only the gateway message for an upstream 403 on the OpenSchool endpoint', () => {
    renderRow(
      'The model provider could not complete this request.\n' + upstream(explanation),
      openschoolRow,
    );
    expect(screen.getByText(explanation)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('could not complete this request');
    expect(document.body.textContent).not.toContain('403');
  });

  it('keeps the return link next to the gateway message', () => {
    renderRow(upstream(refusal(`${RETURN_URL}?circle=light`)), openschoolRow);
    expect(document.body.textContent).not.toContain('could not complete this request');
    expect(screen.getByRole('link', { name: 'Back to Open School circles' })).toHaveAttribute(
      'href',
      `${RETURN_URL}?circle=light`,
    );
  });

  it('shows only the gateway message for unclassified provider prose', () => {
    renderRow(
      JSON.stringify({ error: { message: explanation, type: 'permission_error' } }),
      openschoolRow,
    );
    expect(screen.getByText(explanation)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('could not complete this request');
  });

  it('falls back to the generic copy when the gateway gave no message', () => {
    renderRow(
      JSON.stringify({ type: ErrorTypes.UPSTREAM_MODEL_ERROR, status: 403 }),
      openschoolRow,
    );
    expect(
      screen.getByText('The model provider could not complete this request (status 403).'),
    ).toBeInTheDocument();
  });

  it('leaves other endpoints with the generic headline', () => {
    renderRow(upstream(explanation), {
      ...openschoolRow,
      endpoint: 'openAI',
      model: 'gpt-4o',
    } as unknown as TMessage);
    expect(
      screen.getByText('The model provider could not complete this request (status 403).'),
    ).toBeInTheDocument();
    expect(screen.getByText(explanation)).toBeInTheDocument();
  });
});

describe('findOpenSchoolReturnUrl', () => {
  it('rebuilds the link from the configured URL', () => {
    expect(findOpenSchoolReturnUrl(`see ${RETURN_URL}?circle=pine。`, RETURN_URL)).toBe(
      `${RETURN_URL}?circle=pine`,
    );
  });

  it('skips a foreign URL and takes the configured one after it', () => {
    expect(
      findOpenSchoolReturnUrl(`https://evil.example/x ${RETURN_URL}?circle=pine`, RETURN_URL),
    ).toBe(`${RETURN_URL}?circle=pine`);
  });

  it.each([undefined, '', 'javascript:alert(1)', 'ftp://127.0.0.1/x', `${RETURN_URL}?a=1`])(
    'ignores an unusable configured URL: %s',
    (configured) => {
      expect(findOpenSchoolReturnUrl(`${RETURN_URL}?circle=pine`, configured)).toBeUndefined();
    },
  );
});
