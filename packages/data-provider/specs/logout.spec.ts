/** @jest-environment @happy-dom/jest-environment */
import { logout } from '../src/data-service';
import { getPendingLogoutToken, setPendingLogoutToken } from '../src/logout';
import axios from 'axios';

it('sends retained credential only to logout and preserves it on revoke failure', async () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 503 });
  global.fetch = fetchMock;
  setPendingLogoutToken('expired.signed.token');
  try {
    await expect(logout()).rejects.toThrow('incomplete');
    expect(getPendingLogoutToken()).toBe('expired.signed.token');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/auth/logout'), {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: 'Bearer expired.signed.token' },
    });
    expect(axios.defaults.headers.common.Authorization).toBeUndefined();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ redirect: 'http://localhost:15480/logout' }),
    });
    await expect(logout()).resolves.toHaveProperty('redirect');
  } finally {
    setPendingLogoutToken(undefined);
    global.fetch = originalFetch;
  }
});
