import { LocalStorageKeys } from 'librechat-data-provider';

const a = '11111111-1111-7111-8111-111111111111';
const b = '22222222-2222-7222-8222-222222222222';
const token = (reference: string) =>
  `header.${btoa(JSON.stringify({ centralSession: { reference } }))}.signature`;
let scope: typeof import('./centralDraftScope');
beforeEach(() => {
  jest.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  scope = require('./centralDraftScope');
});
test('legacy storage is unchanged and central namespaces do not adopt legacy drafts', () => {
  const key = LocalStorageKeys.TEXT_DRAFT + 'new';
  expect(scope.scopedDraftKey(key)).toBe(key);
  expect(scope.activateCentralDraftScope(token(a))).toBe(true);
  expect(scope.centralDraftsWritable()).toBe(false);
  expect(scope.scopedDraftKey(key)).not.toBe(key);
  expect(scope.unscopedDraftKey(key)).toBeUndefined();
});
test('revoked A cleanup preserves B drafts and locks late A writes', () => {
  const key = LocalStorageKeys.TEXT_DRAFT + 'new';
  scope.activateCentralDraftScope(token(a));
  scope.unlockCentralDrafts();
  const ownKey = scope.scopedDraftKey(key);
  localStorage.setItem(ownKey, 'A');
  const otherKey = ownKey.replace(a, b);
  localStorage.setItem(otherKey, 'B');
  scope.clearCentralDrafts();
  expect(localStorage.getItem(ownKey)).toBeNull();
  expect(localStorage.getItem(otherKey)).toBe('B');
  expect(scope.centralDraftsWritable()).toBe(false);
});
test('account/session replacement refuses in-memory adoption and preserves B files', () => {
  scope.activateCentralDraftScope(token(a));
  scope.unlockCentralDrafts();
  const aKey = scope.scopedDraftKey(LocalStorageKeys.FILES_DRAFT + 'new');
  localStorage.setItem(aKey, 'A attachment');
  localStorage.setItem(aKey.replace(a, b), 'B attachment');
  expect(scope.activateCentralDraftScope(token(b))).toBe(false);
  expect(localStorage.getItem(aKey)).toBeNull();
  expect(localStorage.getItem(aKey.replace(a, b))).toBe('B attachment');
});
test('returning document checks previous marker and same-binding token does not relock', () => {
  sessionStorage.setItem('openschool.central.draft-scope', a);
  expect(scope.activateCentralDraftScope(token(b))).toBe(false);
});
test('same binding refresh preserves unlocked storage; hidden locks it', () => {
  scope.activateCentralDraftScope(token(a));
  scope.unlockCentralDrafts();
  scope.activateCentralDraftScope(token(a));
  expect(scope.centralDraftsWritable()).toBe(true);
  scope.lockCentralDrafts();
  expect(scope.centralDraftsWritable()).toBe(false);
});
