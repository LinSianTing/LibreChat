import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@librechat/client';
import type useOpenSchoolHandoff from '~/hooks/Input/useOpenSchoolHandoff';
import { useLocalize } from '~/hooks';

export default function OpenSchoolHandoff({
  handoff,
  onDismiss,
}: {
  handoff: ReturnType<typeof useOpenSchoolHandoff>;
  onDismiss?: () => void;
}) {
  const localize = useLocalize();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => setDismissed(false), [handoff.phase]);
  if (handoff.phase === 'idle' || (handoff.phase === 'success' && dismissed)) {
    return null;
  }
  const phaseKeys = {
    loading: 'com_openschool_handoff_loading',
    confirm: 'com_openschool_handoff_confirm',
    ready: 'com_openschool_handoff_ready',
    success: 'com_openschool_handoff_success',
    expired: 'com_openschool_handoff_expired',
    invalid: 'com_openschool_handoff_invalid',
    disabled: 'com_openschool_handoff_disabled',
    forbidden: 'com_openschool_handoff_forbidden',
    unavailable: 'com_openschool_handoff_unavailable',
    model: 'com_openschool_handoff_model',
    login: 'com_openschool_handoff_login',
  } as const;
  return (
    <div className="mb-2 w-full min-w-0 rounded-lg border border-border-medium px-3 py-1 text-sm text-text-primary">
      <div className="flex min-w-0 items-center gap-2">
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="min-w-0 flex-1 break-words py-2"
        >
          {localize(phaseKeys[handoff.phase])}
        </p>
        {handoff.phase === 'success' && (
          <Button
            type="button"
            variant="ghost"
            className="h-11 w-11 shrink-0 p-0"
            aria-label={localize('com_ui_close')}
            onClick={() => {
              // Hide only this notice. Keep the hook's private-draft and account-switch guards.
              setDismissed(true);
              onDismiss?.();
            }}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        )}
      </div>
      {handoff.phase === 'confirm' && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button type="button" onClick={handoff.confirm}>
            {localize('com_openschool_handoff_append')}
          </Button>
          <Button type="button" variant="outline" onClick={handoff.cancel}>
            {localize('com_openschool_handoff_cancel')}
          </Button>
        </div>
      )}
      {handoff.phase === 'login' && (
        <a className="underline" href="/login?redirect_to=%2Fc%2Fnew">
          {localize('com_openschool_handoff_signin')}
        </a>
      )}
      {handoff.returnUrl && !['loading', 'ready', 'confirm', 'success'].includes(handoff.phase) && (
        <a
          className="mt-2 inline-block underline"
          href={handoff.returnUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {localize('com_openschool_handoff_return')}
        </a>
      )}
    </div>
  );
}
