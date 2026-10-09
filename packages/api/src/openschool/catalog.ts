import type { CircleScope } from './admission';

export interface CentralModelCatalog {
  ids: string[];
  names: Record<string, string>;
  circleIds: Record<string, string>;
}

const modelPattern = /^(personal|circle-[a-z0-9-]{1,64})$/;
const circlePattern =
  /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function circleId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value !== value.trim() || !circlePattern.test(value)) {
    return undefined;
  }
  return value.toLowerCase();
}

function trustedName(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const name = value.trim();
  // eslint-disable-next-line no-control-regex -- Display names must not carry control characters.
  if (name.length < 1 || name.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    return undefined;
  }
  return name;
}

/** Internal parser for a fresh authenticated Central response, never request/project data. */
export function parseCentralModelCatalog(data: unknown): CentralModelCatalog {
  if (
    !record(data) ||
    data.object !== 'list' ||
    !Array.isArray(data.data) ||
    data.data.length > 1000
  ) {
    throw new Error('Invalid central model response');
  }
  const ids = new Set<string>();
  const names: Record<string, string> = {};
  const circleIds: Record<string, string> = {};
  const unusable = new Set<string>();
  for (const entry of data.data) {
    if (
      !record(entry) ||
      typeof entry.id !== 'string' ||
      entry.id !== entry.id.trim() ||
      !modelPattern.test(entry.id)
    ) {
      throw new Error('Invalid central model response');
    }
    const id = entry.id;
    ids.add(id);
    const name = trustedName(entry.name);
    if (name !== undefined && !Object.prototype.hasOwnProperty.call(names, id)) {
      names[id] = name;
    }
    if (id === 'personal' || unusable.has(id)) {
      continue;
    }
    const guid = circleId(entry.openschool_circle_id);
    if (
      guid === undefined ||
      (Object.prototype.hasOwnProperty.call(circleIds, id) && circleIds[id] !== guid)
    ) {
      // Any missing/invalid/conflicting duplicate poisons this ID for the entire response.
      // A later valid row must never restore it, irrespective of row ordering.
      delete circleIds[id];
      unusable.add(id);
      continue;
    }
    circleIds[id] = guid;
  }
  return { ids: [...ids], names, circleIds };
}

/** Internal projection only; the gateway wrapper must fetch this user's catalog on every call. */
export function resolveCentralModelScope(
  catalog: CentralModelCatalog,
  model: string,
): { kind: 'resolved'; value: CircleScope } | { kind: 'unknown' } {
  if (
    model === 'personal' ||
    !catalog.ids.includes(model) ||
    !Object.prototype.hasOwnProperty.call(catalog.circleIds, model)
  ) {
    return { kind: 'unknown' };
  }
  const guid = circleId(catalog.circleIds[model]);
  if (guid === undefined) {
    return { kind: 'unknown' };
  }
  return { kind: 'resolved', value: { endpoint: 'OpenSchool', model, circleId: guid } };
}
