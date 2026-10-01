import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useGetModelsQuery } from 'librechat-data-provider/react-query';
import { apiBaseUrl, Constants, EModelEndpoint } from 'librechat-data-provider';
import type { HandoffDraft } from './openschoolHandoff';
import { captureHandoff, clearHandoff, handoffUserId, HANDOFF_MODEL } from './openschoolHandoff';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import { useChatContext, useChatFormContext } from '~/Providers';
import { useAuthContext } from '~/hooks/AuthContext';

type Phase =
  | 'idle'
  | 'loading'
  | 'confirm'
  | 'ready'
  | 'success'
  | 'expired'
  | 'invalid'
  | 'disabled'
  | 'forbidden'
  | 'unavailable'
  | 'model'
  | 'login';

export default function useOpenSchoolHandoff({
  textAreaRef,
  enabled = true,
}: {
  textAreaRef: React.RefObject<HTMLTextAreaElement>;
  enabled?: boolean;
}) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const { user, token, isAuthenticated } = useAuthContext();
  const userId = handoffUserId(user);
  const { data: config } = useGetStartupConfig();
  const { data: endpoints } = useGetEndpointsQuery();
  const { data: models } = useGetModelsQuery();
  const { conversation, newConversation } = useChatContext();
  const methods = useChatFormContext();
  const [capture] = useState(() => (enabled ? captureHandoff(params) : {}));
  const [phase, setPhase] = useState<Phase>(
    capture.error ?? (capture.pending ? 'loading' : 'idle'),
  );
  const [draft, setDraft] = useState<HandoffDraft | null>(null);
  const active = enabled && Boolean(capture.pending || capture.error || params.has('os_handoff'));
  const job = useRef<Promise<HandoffDraft> | null>(null);
  const switched = useRef(false);
  const finished = useRef(false);
  const jobOwner = useRef<string>();
  const currentUser = useRef(userId);
  currentUser.current = userId;
  const expectedModel = useRef(params.get('model'));
  const typedText = useRef<string | null>(null);

  const removeUrl = useCallback(() => {
    const next = new URLSearchParams(params);
    for (const key of ['os_handoff', 'prompt', 'q', 'submit', 'autosubmit', 'endpoint', 'model']) {
      next.delete(key);
    }
    if (next.toString() !== params.toString()) {
      setParams(next, { replace: true });
    }
  }, [params, setParams]);

  useEffect(() => {
    if (!active || !enabled) {
      return;
    }
    if (capture.error) {
      clearHandoff();
      removeUrl();
      return;
    }
    const pending = capture.pending;
    if (job.current && jobOwner.current !== userId) {
      if (phase === 'success') {
        methods.setValue('text', '', { shouldDirty: false });
      }
      setDraft(null);
      finished.current = true;
      clearHandoff();
      setPhase('forbidden');
      return;
    }
    if (!pending || finished.current || !isAuthenticated || !token || !config) {
      return;
    }
    if (userId === undefined) {
      finished.current = true;
      clearHandoff();
      removeUrl();
      setPhase('forbidden');
      return;
    }
    if (location.pathname !== '/c/new') {
      setPhase('invalid');
      clearHandoff();
      removeUrl();
      return;
    }
    if (config.openschoolPromptHandoffEnabled !== true) {
      setPhase('disabled');
      clearHandoff();
      removeUrl();
      return;
    }
    if (pending.expiresAt <= Date.now()) {
      setPhase('expired');
      clearHandoff();
      removeUrl();
      return;
    }
    // Wait for endpoint/model discovery before spending the single-use ID.
    if (!endpoints || !models || !textAreaRef.current) {
      return;
    }
    if (!endpoints.OpenSchool || !models.OpenSchool?.length) {
      setPhase('model');
      clearHandoff();
      removeUrl();
      return;
    }
    const owner = userId;
    if (!job.current) {
      jobOwner.current = owner;
      job.current = (async () => {
        const response = await fetch(`${apiBaseUrl()}/api/openschool/handoff`, {
          method: 'POST',
          credentials: 'same-origin',
          redirect: 'error',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ id: pending.id }),
          signal: AbortSignal.timeout(7000),
        });
        if (!response.ok) {
          // Never parse, display or log upstream error content.
          throw new Error(String(response.status));
        }
        const result: HandoffDraft = await response.json();
        const expiry = Date.parse(result.expiresAtUtc);
        if (
          typeof result.prompt !== 'string' ||
          !result.prompt.trim() ||
          result.prompt.length > 6000 ||
          !HANDOFF_MODEL.test(result.model) ||
          !Number.isFinite(expiry) ||
          expiry <= Date.now() ||
          expiry > Date.now() + 10 * 60 * 1000 ||
          (expectedModel.current != null && expectedModel.current !== result.model)
        ) {
          throw new Error('404');
        }
        return result;
      })();
      removeUrl();
    }
    let listening = true;
    job.current
      .then((result) => {
        if (!listening || finished.current || currentUser.current !== owner) {
          return;
        }
        finished.current = true;
        clearHandoff();
        if (!models.OpenSchool.includes(result.model)) {
          setPhase('model');
          return;
        }
        setDraft(result);
        setPhase(methods.getValues('text') ? 'confirm' : 'ready');
      })
      .catch((error: Error) => {
        if (!listening || finished.current || currentUser.current !== owner) {
          return;
        }
        finished.current = true;
        const status = error.message;
        if (status !== '401') {
          clearHandoff();
        }
        const statusPhases = new Map<string, Phase>([
          ['401', 'login'],
          ['403', 'forbidden'],
          ['400', 'invalid'],
          ['404', 'expired'],
        ]);
        setPhase(statusPhases.get(status) ?? 'unavailable');
      });
    // StrictMode reattaches to the same promise; it never issues a second consume.
    return () => {
      listening = false;
    };
  }, [
    active,
    enabled,
    capture,
    isAuthenticated,
    token,
    userId,
    config,
    endpoints,
    models,
    location.pathname,
    params,
    setParams,
    methods,
    textAreaRef,
    phase,
    removeUrl,
  ]);

  useEffect(() => {
    if (!active || phase !== 'loading' || !isAuthenticated) {
      return;
    }
    const timer = setTimeout(() => {
      finished.current = true;
      clearHandoff();
      removeUrl();
      setPhase('unavailable');
    }, 15000);
    return () => clearTimeout(timer);
  }, [active, phase, isAuthenticated, removeUrl]);

  useEffect(() => {
    if (!draft || (phase !== 'ready' && phase !== 'confirm')) {
      return;
    }
    const timer = setTimeout(
      () => {
        setDraft(null);
        setPhase('expired');
      },
      Math.max(0, Date.parse(draft.expiresAtUtc) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [draft, phase]);

  useEffect(() => {
    if (phase !== 'ready' || !draft || !textAreaRef.current) {
      return;
    }
    if (userId === undefined || jobOwner.current !== userId) {
      return;
    }
    if (location.pathname !== '/c/new') {
      setDraft(null);
      setPhase('invalid');
      return;
    }
    if (Date.parse(draft.expiresAtUtc) <= Date.now()) {
      setDraft(null);
      setPhase('expired');
      return;
    }
    if (!switched.current) {
      // Text can arrive while the network is in flight. Confirmation happens before any switch.
      const text = methods.getValues('text') ?? '';
      if (text && text !== typedText.current) {
        setPhase('confirm');
        return;
      }
      switched.current = true;
      newConversation({
        template: { conversationId: Constants.NEW_CONVO as string, chatProjectId: null },
        preset: {
          endpoint: 'OpenSchool' as EModelEndpoint,
          endpointType: EModelEndpoint.custom,
          model: draft.model,
        },
        keepComposerState: true,
        keepAddedConvos: false,
      });
      return;
    }
    if (
      conversation?.conversationId !== Constants.NEW_CONVO ||
      String(conversation.endpoint) !== 'OpenSchool' ||
      conversation.model !== draft.model ||
      conversation.endpointType !== EModelEndpoint.custom
    ) {
      return;
    }
    const current = methods.getValues('text') ?? '';
    if (current && current !== typedText.current) {
      switched.current = false;
      setPhase('confirm');
      return;
    }
    methods.setValue('text', current ? `${current}\n\n${draft.prompt}` : draft.prompt, {
      shouldDirty: true,
      shouldValidate: true,
    });
    textAreaRef.current.focus();
    setDraft(null);
    setPhase('success');
  }, [
    phase,
    draft,
    conversation,
    methods,
    newConversation,
    textAreaRef,
    location.pathname,
    userId,
  ]);

  useEffect(() => {
    if (phase !== 'ready') {
      return;
    }
    const timer = setTimeout(() => {
      setDraft(null);
      setPhase('model');
    }, 5000);
    return () => clearTimeout(timer);
  }, [phase]);

  return {
    phase,
    active,
    confirm: () => {
      typedText.current = methods.getValues('text') ?? '';
      switched.current = false;
      // An explicit append keeps the current user text.
      setPhase('ready');
    },
    cancel: () => {
      setDraft(null);
      setPhase('idle');
      clearHandoff();
    },
    returnUrl: config?.openschoolReturnUrl,
  };
}
