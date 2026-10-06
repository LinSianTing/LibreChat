import { useEffect, useMemo } from 'react';
import { useSetRecoilState } from 'recoil';
import type { Endpoint } from '~/common';
import { OPENSCHOOL_ENDPOINT } from '~/hooks/Endpoint/useEndpoints';
import { pickAllowedOpenSchoolModel } from './utils';
import store from '~/store';

/**
 * OpenSchool fork: keeps an OpenSchool conversation on a model this reader may use, taken from the
 * per-user names `/api/openschool/model-names` returned. Only the model is replaced, so the draft,
 * project and the rest of the conversation stay as they are.
 */
export default function useOpenSchoolModel({
  endpoint,
  model,
  mappedEndpoints,
}: {
  endpoint?: string | null;
  model?: string | null;
  mappedEndpoints?: Endpoint[];
}) {
  const setConversation = useSetRecoilState(store.conversationByIndex(0));
  const allowed = useMemo(
    () =>
      Object.keys(
        mappedEndpoints?.find((item) => item.value === OPENSCHOOL_ENDPOINT)?.modelNames ?? {},
      ),
    [mappedEndpoints],
  );

  useEffect(() => {
    if (endpoint !== OPENSCHOOL_ENDPOINT) {
      return;
    }
    const next = pickAllowedOpenSchoolModel(model, allowed);
    if (next == null) {
      return;
    }
    setConversation((prev) =>
      prev != null &&
      (prev.endpoint as string | null) === OPENSCHOOL_ENDPOINT &&
      (prev.model ?? null) === (model ?? null)
        ? { ...prev, model: next }
        : prev,
    );
  }, [endpoint, model, allowed, setConversation]);
}
