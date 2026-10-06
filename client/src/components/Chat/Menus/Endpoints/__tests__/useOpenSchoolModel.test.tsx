import React from 'react';
import { RecoilRoot, useRecoilState } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';
import type { Endpoint } from '~/common';
import useOpenSchoolModel from '../useOpenSchoolModel';
import store from '~/store';

const openschool = (modelNames?: Record<string, string>): Endpoint => ({
  value: 'OpenSchool',
  label: 'OpenSchool',
  hasModels: true,
  icon: null,
  modelNames,
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RecoilRoot>{children}</RecoilRoot>
);

type Seeded = { endpoint: string; model: string };

/** Runs the guard against the real conversation atom, the way the model selector does. */
function renderGuard(conversation: Seeded, mappedEndpoints: Endpoint[]) {
  return renderHook(
    () => {
      const [convo, setConvo] = useRecoilState(store.conversationByIndex(0));
      useOpenSchoolModel({
        endpoint: convo?.endpoint,
        model: convo?.model,
        mappedEndpoints,
      });
      return { convo, setConvo };
    },
    {
      wrapper: ({ children }) =>
        wrapper({
          children: <Seed conversation={conversation}>{children}</Seed>,
        }),
    },
  );
}

function Seed({ conversation, children }: { conversation: Seeded; children: React.ReactNode }) {
  const [convo, setConvo] = useRecoilState(store.conversationByIndex(0));
  React.useLayoutEffect(() => {
    setConvo({ conversationId: 'new', title: 'New Chat', ...conversation } as TConversation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return convo == null ? null : <>{children}</>;
}

const allowed = { 'circle-openschool-public': '開放學校公開圈', 'circle-teachers': '老師圈' };

describe('useOpenSchoolModel', () => {
  it('moves the config default to the first model this reader may use', () => {
    const { result } = renderGuard({ endpoint: 'OpenSchool', model: 'personal' }, [
      openschool(allowed),
    ]);
    expect(result.current.convo?.model).toBe('circle-openschool-public');
    expect(result.current.convo?.conversationId).toBe('new');
  });

  it('keeps an allowed choice', () => {
    const { result } = renderGuard({ endpoint: 'OpenSchool', model: 'circle-teachers' }, [
      openschool(allowed),
    ]);
    expect(result.current.convo?.model).toBe('circle-teachers');
  });

  it('corrects a later switch to a model outside the list', () => {
    const { result } = renderGuard({ endpoint: 'OpenSchool', model: 'circle-teachers' }, [
      openschool(allowed),
    ]);
    act(() => {
      result.current.setConvo((prev) => ({ ...(prev as TConversation), model: 'personal' }));
    });
    expect(result.current.convo?.model).toBe('circle-openschool-public');
  });

  it('changes nothing until the names are known, or when the list is empty', () => {
    const unknown = renderGuard({ endpoint: 'OpenSchool', model: 'personal' }, [openschool()]);
    expect(unknown.result.current.convo?.model).toBe('personal');

    const empty = renderGuard({ endpoint: 'OpenSchool', model: 'personal' }, [openschool({})]);
    expect(empty.result.current.convo?.model).toBe('personal');
  });

  it('leaves other endpoints alone', () => {
    const { result } = renderGuard({ endpoint: 'openAI', model: 'personal' }, [
      openschool(allowed),
    ]);
    expect(result.current.convo?.model).toBe('personal');
  });
});
