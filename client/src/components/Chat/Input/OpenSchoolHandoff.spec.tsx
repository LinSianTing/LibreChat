import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import OpenSchoolHandoff from './OpenSchoolHandoff';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('@librechat/client', () => ({
  Button: ({
    variant: _variant,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) => <button {...props} />,
}));

const makeHandoff = (
  phase: React.ComponentProps<typeof OpenSchoolHandoff>['handoff']['phase'],
) => ({
  phase,
  active: true,
  confirm: jest.fn(),
  cancel: jest.fn(),
  returnUrl: 'https://openschool.example.test/ai/chat',
});

it('dismisses only the notice, preserves edited text and does not submit or cancel the handoff', () => {
  const handoff = makeHandoff('success');
  const submit = jest.fn();
  const focus = jest.fn();
  const draftText = 'Edited private draft';
  render(
    <form onSubmit={submit}>
      <OpenSchoolHandoff handoff={handoff} onDismiss={focus} />
      <textarea aria-label="Draft" defaultValue={draftText} />
    </form>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_close' }));
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue(draftText);
  expect(handoff.cancel).not.toHaveBeenCalled();
  expect(handoff.confirm).not.toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  expect(focus).toHaveBeenCalledTimes(1);
});

it('does not hide a later access failure when the success notice was dismissed', () => {
  const { rerender } = render(<OpenSchoolHandoff handoff={makeHandoff('success')} />);
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_close' }));
  rerender(<OpenSchoolHandoff handoff={makeHandoff('forbidden')} />);
  expect(screen.getByRole('status')).toHaveTextContent('com_openschool_handoff_forbidden');
  expect(screen.getByRole('link')).toHaveAttribute(
    'href',
    'https://openschool.example.test/ai/chat',
  );
  expect(screen.queryByRole('button', { name: 'com_ui_close' })).not.toBeInTheDocument();
  rerender(<OpenSchoolHandoff handoff={makeHandoff('success')} />);
  expect(screen.getByRole('status')).toHaveTextContent('com_openschool_handoff_success');
});

it('keeps the explicit append and keep-text choices usable without submitting', () => {
  const handoff = makeHandoff('confirm');
  render(<OpenSchoolHandoff handoff={handoff} />);
  fireEvent.click(screen.getByRole('button', { name: 'com_openschool_handoff_append' }));
  fireEvent.click(screen.getByRole('button', { name: 'com_openschool_handoff_cancel' }));
  expect(handoff.confirm).toHaveBeenCalledTimes(1);
  expect(handoff.cancel).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'com_ui_close' })).not.toBeInTheDocument();
});

it.each(['expired', 'invalid', 'disabled', 'unavailable', 'model', 'login'] as const)(
  'keeps %s recovery visible',
  (phase) => {
    render(<OpenSchoolHandoff handoff={makeHandoff(phase)} />);
    expect(screen.getByRole('status')).toHaveTextContent(`com_openschool_handoff_${phase}`);
    expect(screen.getByRole('link', { name: 'com_openschool_handoff_return' })).toBeVisible();
  },
);
