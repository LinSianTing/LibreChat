import { Button } from '@librechat/client';
import type useOpenSchoolHandoff from '~/hooks/Input/useOpenSchoolHandoff';
import { useLocalize } from '~/hooks';

export default function OpenSchoolHandoff({
  handoff,
}: {
  handoff: ReturnType<typeof useOpenSchoolHandoff>;
}) {
  const localize = useLocalize();
  if (handoff.phase === 'idle') {
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
    <div
      role="status"
      aria-live="polite"
      className="mb-2 rounded-lg border border-border-medium p-3 text-sm text-text-primary"
    >
      <p>{localize(phaseKeys[handoff.phase])}</p>
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
