import type { useLocalize } from '~/hooks';
import type { Endpoint } from '~/common';
import { filterItems, getDisplayValue, getModelLabel, pickAllowedOpenSchoolModel } from '../utils';

const agentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: true,
  icon: null,
  showMarketplace: true,
  searchAliases: ['agent marketplace', 'marketplace'],
};

const disabledAgentsEndpoint: Endpoint = {
  value: 'agents',
  label: 'My Agents',
  hasModels: false,
  icon: null,
};

describe('model selector utilities', () => {
  it('matches endpoint search aliases', () => {
    const results = filterItems([agentsEndpoint], 'marketplace', undefined, undefined);
    expect(results).toEqual([agentsEndpoint]);
  });

  it('matches localized Marketplace labels', () => {
    const localize = ((key: string) => {
      if (key === 'com_agents_marketplace') {
        return 'Tienda de Agentes';
      }
      if (key === 'com_ui_marketplace') {
        return 'Tienda';
      }
      return key;
    }) as ReturnType<typeof useLocalize>;

    const results = filterItems([agentsEndpoint], 'tienda', undefined, undefined, localize);
    expect(results).toEqual([agentsEndpoint]);
  });

  it('does not match agents when there are no selectable agent options', () => {
    const results = filterItems([disabledAgentsEndpoint], 'my agents', undefined, undefined);
    expect(results).toEqual([]);
  });
});

describe('OpenSchool model display names', () => {
  const localize = ((key: string) => key) as ReturnType<typeof useLocalize>;
  const openschool: Endpoint = {
    value: 'OpenSchool',
    label: 'OpenSchool',
    hasModels: true,
    icon: null,
    models: [{ name: 'circle-p0-sso-mock' }, { name: 'circle-unnamed' }],
    modelNames: { 'circle-p0-sso-mock': 'P0 SSO synthetic test circle' },
  };

  it('labels a model with its trusted name, falling back to the raw id', () => {
    expect(getModelLabel(openschool, 'circle-p0-sso-mock')).toBe('P0 SSO synthetic test circle');
    expect(getModelLabel(openschool, 'circle-unnamed')).toBe('circle-unnamed');
    expect(getModelLabel({}, 'circle-p0-sso-mock')).toBe('circle-p0-sso-mock');
  });

  it('shows the circle name as the selected model display value', () => {
    const display = (model: string, endpoints: Endpoint[] = [openschool]) =>
      getDisplayValue({
        localize,
        mappedEndpoints: endpoints,
        modelSpecs: [],
        selectedValues: { endpoint: 'OpenSchool', model, modelSpec: null },
      });
    expect(display('circle-p0-sso-mock')).toBe('P0 SSO synthetic test circle');
    expect(display('circle-unnamed')).toBe('circle-unnamed');
    expect(display('circle-p0-sso-mock', [{ ...openschool, modelNames: undefined }])).toBe(
      'circle-p0-sso-mock',
    );
  });

  it('finds an endpoint by a model display name', () => {
    expect(filterItems([openschool], 'synthetic', undefined, undefined)).toEqual([openschool]);
    expect(filterItems([openschool], 'no such circle', undefined, undefined)).toEqual([]);
  });
});

describe('pickAllowedOpenSchoolModel', () => {
  const allowed = ['circle-openschool-public', 'circle-teachers'];

  it('switches the config default to the first allowed model', () => {
    expect(pickAllowedOpenSchoolModel('personal', allowed)).toBe('circle-openschool-public');
  });

  it('switches a missing model to the first allowed model', () => {
    expect(pickAllowedOpenSchoolModel(null, allowed)).toBe('circle-openschool-public');
    expect(pickAllowedOpenSchoolModel(undefined, allowed)).toBe('circle-openschool-public');
  });

  it('keeps an allowed choice, including one from the model query param', () => {
    expect(pickAllowedOpenSchoolModel('circle-teachers', allowed)).toBeNull();
    expect(pickAllowedOpenSchoolModel('personal', ['personal', ...allowed])).toBeNull();
  });

  it('changes nothing while the allowed list is empty', () => {
    expect(pickAllowedOpenSchoolModel('personal', [])).toBeNull();
  });
});
