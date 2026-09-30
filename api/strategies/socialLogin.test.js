const { logger } = require('@librechat/data-schemas');
const { ErrorTypes } = require('librechat-data-provider');
const { createSocialUser, handleExistingUser } = require('./process');
const socialLogin = require('./socialLogin');
const { findUser } = require('~/models');
const { resolveAppConfigForUser } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config');

jest.mock('@librechat/data-schemas', () => {
  const actualModule = jest.requireActual('@librechat/data-schemas');
  return {
    ...actualModule,
    logger: {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
    },
  };
});

jest.mock('./process', () => ({
  createSocialUser: jest.fn(),
  handleExistingUser: jest.fn(),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: jest.fn().mockReturnValue(true),
  isEmailDomainAllowed: jest.fn().mockReturnValue(true),
  resolveAppConfigForUser: jest.fn().mockResolvedValue({
    fileStrategy: 'local',
    balance: { enabled: false },
  }),
}));

jest.mock('~/models', () => ({
  findUser: jest.fn(),
  updateUser: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({
    fileStrategy: 'local',
    balance: { enabled: false },
  }),
}));

describe('socialLogin', () => {
  const mockGetProfileDetails = ({ profile }) => ({
    email: profile.emails[0].value,
    id: profile.id,
    avatarUrl: profile.photos?.[0]?.value || null,
    username: profile.name?.givenName || 'user',
    name: `${profile.name?.givenName || ''} ${profile.name?.familyName || ''}`.trim(),
    emailVerified: profile.emails[0].verified || false,
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Finding users by provider ID', () => {
    it('should find user by provider ID (googleId) when email has changed', async () => {
      const provider = 'google';
      const googleId = 'google-user-123';
      const oldEmail = 'old@example.com';
      const newEmail = 'new@example.com';

      const existingUser = {
        _id: 'user123',
        email: oldEmail,
        provider: 'google',
        googleId: googleId,
      };

      findUser.mockResolvedValueOnce(existingUser).mockResolvedValueOnce(null);

      const mockProfile = {
        id: googleId,
        emails: [{ value: newEmail, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'John', familyName: 'Doe' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails);
      const callback = jest.fn();

      await loginFn(null, null, null, mockProfile, callback);

      expect(findUser).toHaveBeenNthCalledWith(1, { googleId: googleId });
      expect(findUser).toHaveBeenCalledTimes(1);

      expect(handleExistingUser).toHaveBeenCalledWith(
        existingUser,
        'https://example.com/avatar.png',
        expect.any(Object),
        newEmail,
      );

      expect(callback).toHaveBeenCalledWith(null, existingUser);
    });

    it('should find user by provider ID (facebookId) when using Facebook', async () => {
      const provider = 'facebook';
      const facebookId = 'fb-user-456';
      const email = 'user@example.com';

      const existingUser = {
        _id: 'user456',
        email: email,
        provider: 'facebook',
        facebookId: facebookId,
      };

      findUser.mockResolvedValue(existingUser);

      const mockProfile = {
        id: facebookId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/fb-avatar.png' }],
        name: { givenName: 'Jane', familyName: 'Smith' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails);
      const callback = jest.fn();

      await loginFn(null, null, null, mockProfile, callback);

      expect(findUser).toHaveBeenCalledWith({ facebookId: facebookId });
      expect(findUser.mock.calls[0]).toEqual([{ facebookId: facebookId }]);

      expect(handleExistingUser).toHaveBeenCalledWith(
        existingUser,
        'https://example.com/fb-avatar.png',
        expect.any(Object),
        email,
      );

      expect(callback).toHaveBeenCalledWith(null, existingUser);
    });

    it('should fallback to finding user by email if not found by provider ID', async () => {
      const provider = 'google';
      const googleId = 'google-user-789';
      const email = 'user@example.com';

      const existingUser = {
        _id: 'user789',
        email: email,
        provider: 'google',
        googleId: 'old-google-id',
      };

      findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);

      const mockProfile = {
        id: googleId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'Bob', familyName: 'Johnson' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails);
      const callback = jest.fn();

      await loginFn(null, null, null, mockProfile, callback);

      expect(findUser).toHaveBeenNthCalledWith(1, { googleId: googleId });
      expect(findUser).toHaveBeenNthCalledWith(2, { email: email });
      expect(findUser).toHaveBeenCalledTimes(2);

      expect(logger.warn).toHaveBeenCalledWith(
        `[${provider}Login] User found by email: ${email} but not by ${provider}Id`,
      );

      expect(handleExistingUser).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(null, existingUser);
    });

    it('does not migrate the provider id on the chat path (only admin path migrates)', async () => {
      const { updateUser } = require('~/models');
      const provider = 'google';
      const googleId = 'google-user-chat';
      const email = 'chat@example.com';

      const existingUser = {
        _id: 'chatUser',
        email: email,
        provider: 'google',
      };

      findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);

      const mockProfile = {
        id: googleId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'Chat', familyName: 'User' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails);
      const callback = jest.fn();

      await loginFn(null, null, null, mockProfile, callback);

      expect(updateUser).not.toHaveBeenCalled();
      expect(handleExistingUser).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(null, existingUser);
    });

    it('migrates the missing provider id when finding by email fallback (admin path)', async () => {
      const { updateUser } = require('~/models');
      const provider = 'google';
      const googleId = 'google-user-789';
      const email = 'admin@example.com';

      const existingUser = {
        _id: 'admin789',
        email: email,
        provider: 'google',
      };

      findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);

      const mockProfile = {
        id: googleId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'Admin', familyName: 'User' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails, { existingUsersOnly: true });
      const callback = jest.fn();

      await loginFn(null, null, null, mockProfile, callback);

      expect(updateUser).toHaveBeenCalledWith('admin789', { googleId });
      expect(existingUser.googleId).toBe(googleId);
      expect(handleExistingUser).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(null, existingUser);
    });

    it('blocks migration via email fallback for a tenanted user (no tenant scope in OAuth callback)', async () => {
      const { updateUser } = require('~/models');
      const provider = 'google';
      const googleId = 'google-user-cross';
      const email = 'admin@tenantb.example.com';

      const tenantedUser = {
        _id: 'tenant-b-user',
        email: email,
        provider: 'google',
        tenantId: 'tenant-b',
      };

      findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(tenantedUser);

      const mockProfile = {
        id: googleId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'Admin', familyName: 'User' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails, { existingUsersOnly: true });
      const callback = jest.fn();

      await loginFn(null, null, null, mockProfile, callback);

      expect(updateUser).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ code: ErrorTypes.AUTH_FAILED }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Admin migrate blocked for tenanted user'),
      );
    });

    it('rejects the admin email fallback when stored provider id differs from the current sub', async () => {
      const provider = 'google';
      const googleId = 'google-user-new';
      const email = 'admin@example.com';

      const existingUser = {
        _id: 'admin789',
        email: email,
        provider: 'google',
        googleId: 'google-user-old',
      };

      findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);

      const mockProfile = {
        id: googleId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'Admin', familyName: 'User' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails, { existingUsersOnly: true });
      const callback = jest.fn();

      await loginFn(null, null, null, mockProfile, callback);

      expect(logger.warn).toHaveBeenCalledWith(
        `[${provider}Login] Rejected admin email fallback for ${email}: stored ${provider}Id does not match`,
      );
      expect(handleExistingUser).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ code: ErrorTypes.AUTH_FAILED }),
      );
    });

    it('should create new user if not found by provider ID or email', async () => {
      const provider = 'google';
      const googleId = 'google-new-user';
      const email = 'newuser@example.com';

      const newUser = {
        _id: 'newuser123',
        email: email,
        provider: 'google',
        googleId: googleId,
      };

      findUser.mockResolvedValue(null);
      createSocialUser.mockResolvedValue(newUser);

      const mockProfile = {
        id: googleId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'New', familyName: 'User' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails);
      const callback = jest.fn();

      await loginFn(null, null, null, mockProfile, callback);

      expect(findUser).toHaveBeenCalledTimes(2);

      expect(createSocialUser).toHaveBeenCalledWith({
        email: email,
        avatarUrl: 'https://example.com/avatar.png',
        provider: provider,
        providerKey: 'googleId',
        providerId: googleId,
        username: 'New',
        name: 'New User',
        emailVerified: true,
        appConfig: expect.any(Object),
      });

      expect(callback).toHaveBeenCalledWith(null, newUser);
    });
  });

  describe('Error handling', () => {
    it('should return error if user exists with different provider', async () => {
      const provider = 'google';
      const googleId = 'google-user-123';
      const email = 'user@example.com';

      const existingUser = {
        _id: 'user123',
        email: email,
        provider: 'local',
      };

      findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);

      const mockProfile = {
        id: googleId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'John', familyName: 'Doe' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails);
      const callback = jest.fn();

      await loginFn(null, null, null, mockProfile, callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          code: ErrorTypes.AUTH_FAILED,
          provider: 'local',
        }),
      );

      expect(logger.info).toHaveBeenCalledWith(
        `[${provider}Login] User ${email} already exists with provider local`,
      );
    });
  });

  describe('Tenant-scoped config', () => {
    it('should call resolveAppConfigForUser for tenant user', async () => {
      const provider = 'google';
      const googleId = 'google-tenant-user';
      const email = 'tenant@example.com';

      const existingUser = {
        _id: 'userTenant',
        email,
        provider: 'google',
        googleId,
        tenantId: 'tenant-b',
        role: 'USER',
      };

      findUser.mockResolvedValue(existingUser);

      const mockProfile = {
        id: googleId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'Tenant', familyName: 'User' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails);
      const callback = jest.fn();

      await loginFn(null, null, null, mockProfile, callback);

      expect(resolveAppConfigForUser).toHaveBeenCalledWith(getAppConfig, existingUser);
    });

    it('should use baseConfig for non-tenant user without calling resolveAppConfigForUser', async () => {
      const provider = 'google';
      const googleId = 'google-new-tenant';
      const email = 'new@example.com';

      findUser.mockResolvedValue(null);
      createSocialUser.mockResolvedValue({
        _id: 'newUser',
        email,
        provider: 'google',
        googleId,
      });

      const mockProfile = {
        id: googleId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'New', familyName: 'User' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails);
      const callback = jest.fn();

      await loginFn(null, null, null, mockProfile, callback);

      expect(resolveAppConfigForUser).not.toHaveBeenCalled();
      expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    });

    it('should block login when tenant config restricts the domain', async () => {
      const { isEmailDomainAllowed } = require('@librechat/api');
      const provider = 'google';
      const googleId = 'google-tenant-blocked';
      const email = 'blocked@example.com';

      const existingUser = {
        _id: 'userBlocked',
        email,
        provider: 'google',
        googleId,
        tenantId: 'tenant-restrict',
        role: 'USER',
      };

      findUser.mockResolvedValue(existingUser);
      resolveAppConfigForUser.mockResolvedValue({
        registration: { allowedDomains: ['other.com'] },
      });
      isEmailDomainAllowed.mockReturnValueOnce(true).mockReturnValueOnce(false);

      const mockProfile = {
        id: googleId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'Blocked', familyName: 'User' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails);
      const callback = jest.fn();

      await loginFn(null, null, null, mockProfile, callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Email domain not allowed' }),
      );
    });

    it('does not forward the refresh token as authInfo for non-google providers', async () => {
      const provider = 'github';
      const githubId = 'gh-user-123';
      const email = 'user@example.com';

      const existingUser = {
        _id: 'ghUser',
        email,
        provider: 'github',
        githubId,
      };

      findUser.mockResolvedValue(existingUser);

      const mockProfile = {
        id: githubId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'GitHub', familyName: 'User' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails);
      const callback = jest.fn();

      await loginFn(null, 'github-refresh-token', null, mockProfile, callback);

      expect(callback).toHaveBeenCalledWith(null, existingUser);
      expect(callback).not.toHaveBeenCalledWith(null, existingUser, expect.anything());
    });

    it('passes the IdP refresh token through as authInfo when present', async () => {
      const provider = 'google';
      const googleId = 'google-with-refresh';
      const email = 'admin@example.com';

      const existingUser = {
        _id: 'userRefresh',
        email,
        provider: 'google',
        googleId,
        role: 'ADMIN',
      };

      findUser.mockResolvedValue(existingUser);

      const mockProfile = {
        id: googleId,
        emails: [{ value: email, verified: true }],
        photos: [{ value: 'https://example.com/avatar.png' }],
        name: { givenName: 'Admin', familyName: 'User' },
      };

      const loginFn = socialLogin(provider, mockGetProfileDetails);
      const callback = jest.fn();

      await loginFn(null, 'idp-refresh-token', null, mockProfile, callback);

      expect(callback).toHaveBeenCalledWith(null, existingUser, {
        refreshToken: 'idp-refresh-token',
      });
    });
  });

  describe('OpenSchool fork: Google chat eligibility', () => {
    const url = 'http://school:8080/ai-gateway/v1/chat-access';
    const profile = {
      id: 'verified-google-sub',
      emails: [{ value: 'invited@example.com', verified: true }],
      name: { givenName: 'Invited', familyName: 'Adult' },
    };
    const user = {
      _id: 'invited-user',
      email: profile.emails[0].value,
      provider: 'google',
      googleId: profile.id,
      role: 'USER',
    };
    let originalEnv;
    let fetchSpy;

    const login = (callback, options = {}, details = profile, provider = 'google') =>
      socialLogin(provider, mockGetProfileDetails, options)(
        'private-access-token',
        'private-refresh-token',
        'private-id-token',
        details,
        callback,
      );

    const expectDenied = (callback) => {
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ code: ErrorTypes.AUTH_FAILED }),
      );
      expect(handleExistingUser).not.toHaveBeenCalled();
      expect(createSocialUser).not.toHaveBeenCalled();
      expect(require('~/models').updateUser).not.toHaveBeenCalled();
    };

    beforeEach(() => {
      originalEnv = { ...process.env };
      process.env.OPENSCHOOL_CHAT_ACCESS_URL = url;
      process.env.OPENSCHOOL_GATEWAY_KEY = 'private-gateway-key';
      process.env.OPENSCHOOL_STRICT_SOCIAL_ID = 'true';
      process.env.ALLOW_SOCIAL_REGISTRATION = 'true';
      findUser.mockReset().mockResolvedValue(null);
      createSocialUser.mockReset().mockResolvedValue({ ...user });
      const { isEnabled, isEmailDomainAllowed } = require('@librechat/api');
      isEnabled.mockImplementation((value) => value === 'true');
      isEmailDomainAllowed.mockReturnValue(true);
      fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        status: 200,
        json: async () => ({ allowed: true }),
      });
    });

    afterEach(() => {
      process.env = originalEnv;
      fetchSpy.mockRestore();
      jest.useRealTimers();
      require('@librechat/api').isEnabled.mockReturnValue(true);
    });

    it.each(['existing', 'new'])(
      'checks and allows an invited %s user before writes',
      async (kind) => {
        if (kind === 'existing') {
          findUser.mockResolvedValue({ ...user });
        }
        let resolveResponse;
        fetchSpy.mockReturnValue(new Promise((resolve) => (resolveResponse = resolve)));
        const callback = jest.fn();
        const pending = login(callback);
        // Flush the config and identity lookup promises, without resolving the eligibility request.
        await new Promise((resolve) => setImmediate(resolve));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledWith(url, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer private-gateway-key',
            'X-OpenSchool-Google-Sub': profile.id,
            'X-Forwarded-Proto': 'https',
          },
          signal: expect.any(AbortSignal),
          redirect: 'error',
        });
        expect(callback).not.toHaveBeenCalled();
        expect(handleExistingUser).not.toHaveBeenCalled();
        expect(createSocialUser).not.toHaveBeenCalled();
        resolveResponse({ status: 200, json: async () => ({ allowed: true, role: 'ADMIN' }) });
        await pending;
        expect(callback).toHaveBeenCalledWith(null, user, {
          refreshToken: 'private-refresh-token',
        });
        if (kind === 'new') {
          expect(createSocialUser).toHaveBeenCalledTimes(1);
          expect(createSocialUser.mock.calls[0][0]).not.toHaveProperty('role');
          expect(createSocialUser.mock.calls[0][0].providerId).toBe(profile.id);
        } else {
          expect(handleExistingUser).toHaveBeenCalledTimes(1);
        }
      },
    );

    describe.each(['existing', 'new'])('%s user fail-closed responses', (kind) => {
      beforeEach(() => {
        if (kind === 'existing') {
          findUser.mockResolvedValue({ ...user });
        }
      });

      it.each([
        ['denied', 200, { allowed: false }],
        ['missing decision', 200, {}],
        ['truthy string', 200, { allowed: 'true' }],
        ['truthy number', 200, { allowed: 1 }],
        ['null', 200, null],
        ['array', 200, [{ allowed: true }]],
        ['primitive', 200, true],
        ['other success status', 201, { allowed: true }],
        ['empty response', 204, null],
        ['redirect', 302, { allowed: true }],
        ['unauthorized', 401, { allowed: true }],
        ['forbidden', 403, { allowed: true }],
        ['outage', 503, { allowed: true }],
      ])('denies %s without retry or writes', async (_label, status, body) => {
        fetchSpy.mockResolvedValue({ status, json: async () => body });
        const callback = jest.fn();
        await login(callback);
        expectDenied(callback);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      it.each(['network', 'json'])('sanitizes a %s failure', async (failure) => {
        const error = new Error(
          `${profile.id} ${user.email} private-gateway-key private-access-token private-id-token private-refresh-token`,
        );
        if (failure === 'network') {
          fetchSpy.mockRejectedValue(error);
        } else {
          fetchSpy.mockResolvedValue({
            status: 200,
            json: async () => {
              throw error;
            },
          });
        }
        const callback = jest.fn();
        await login(callback);
        expectDenied(callback);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith('[googleLogin] OpenSchool chat access denied');
        expect(logger.error).not.toHaveBeenCalled();
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-');
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(profile.id);
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(user.email);
        expect(callback.mock.calls[0][0].message).toBe(ErrorTypes.AUTH_FAILED);
      });

      it.each(['request', 'body'])('bounds a stalled %s to 5s and aborts it', async (phase) => {
        jest.useFakeTimers();
        const stalled = new Promise(() => {});
        fetchSpy.mockReturnValue(
          phase === 'request' ? stalled : Promise.resolve({ status: 200, json: () => stalled }),
        );
        const callback = jest.fn();
        const pending = login(callback);
        await jest.advanceTimersByTimeAsync(4999);
        expect(callback).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        await pending;
        expectDenied(callback);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][1].signal.aborted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
      });
    });

    it.each(['different-sub', undefined])(
      'rejects email-only collision (%s) before the gate',
      async (storedId) => {
        findUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...user, googleId: storedId });
        const callback = jest.fn();
        await login(callback);
        expectDenied(callback);
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );

    it.each([undefined, '', ' '])(
      'denies missing/blank gateway key (%s) without a request',
      async (key) => {
        if (key === undefined) {
          delete process.env.OPENSCHOOL_GATEWAY_KEY;
        } else {
          process.env.OPENSCHOOL_GATEWAY_KEY = key;
        }
        const callback = jest.fn();
        await login(callback);
        expectDenied(callback);
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );

    it.each([undefined, '', 123, ' padded '])(
      'denies invalid verified subject (%s)',
      async (id) => {
        const callback = jest.fn();
        await login(callback, {}, { ...profile, id });
        expectDenied(callback);
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );

    it('denies an unverified Google email', async () => {
      const callback = jest.fn();
      await login(callback, {}, { ...profile, emails: [{ value: user.email, verified: false }] });
      expectDenied(callback);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('does not override disabled social registration', async () => {
      process.env.ALLOW_SOCIAL_REGISTRATION = 'false';
      const callback = jest.fn();
      await login(callback);
      expectDenied(callback);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it.each([undefined, ''])(
      'preserves upstream behavior without a gate URL (%s)',
      async (urlValue) => {
        if (urlValue === undefined) {
          delete process.env.OPENSCHOOL_CHAT_ACCESS_URL;
        } else {
          process.env.OPENSCHOOL_CHAT_ACCESS_URL = urlValue;
        }
        delete process.env.OPENSCHOOL_GATEWAY_KEY;
        const callback = jest.fn();
        await login(callback);
        expect(createSocialUser).toHaveBeenCalledTimes(1);
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );

    it('does not gate other social providers', async () => {
      const callback = jest.fn();
      await login(callback, {}, profile, 'github');
      expect(createSocialUser).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('cannot authorize a new user through the unchanged admin login path', async () => {
      const callback = jest.fn();
      await login(callback, { existingUsersOnly: true });
      expect(callback).toHaveBeenCalledWith(null, false, { message: 'User does not exist' });
      expect(createSocialUser).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('leaves existing admin login handling outside the gate', async () => {
      findUser.mockResolvedValue({ ...user });
      const callback = jest.fn();
      await login(callback, { existingUsersOnly: true });
      expect(handleExistingUser).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('OpenSchool fork: OPENSCHOOL_STRICT_SOCIAL_ID', () => {
    const provider = 'google';
    const email = 'same@example.com';
    const profileFor = (id) => ({
      id,
      emails: [{ value: email, verified: true }],
      photos: [{ value: null }],
      name: { givenName: 'Other', familyName: 'Person' },
    });
    const original = process.env.OPENSCHOOL_STRICT_SOCIAL_ID;

    afterEach(() => {
      if (original === undefined) {
        delete process.env.OPENSCHOOL_STRICT_SOCIAL_ID;
      } else {
        process.env.OPENSCHOOL_STRICT_SOCIAL_ID = original;
      }
    });

    it('refuses an account found only by email when a different provider ID logs in', async () => {
      process.env.OPENSCHOOL_STRICT_SOCIAL_ID = 'true';
      const { updateUser } = require('~/models');
      const existingUser = { _id: 'userA', email, provider: 'google', googleId: 'sub-A' };
      findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);
      const callback = jest.fn();

      await socialLogin(provider, mockGetProfileDetails)(
        null,
        null,
        null,
        profileFor('sub-B'),
        callback,
      );

      const [error, user] = callback.mock.calls[0];
      expect(error.code).toBe(ErrorTypes.AUTH_FAILED);
      expect(user).toBeUndefined();
      expect(handleExistingUser).not.toHaveBeenCalled();
      expect(createSocialUser).not.toHaveBeenCalled();
      expect(updateUser).not.toHaveBeenCalled();
      expect(existingUser.googleId).toBe('sub-A');
    });

    it('refuses an account without any provider ID that shares the email', async () => {
      process.env.OPENSCHOOL_STRICT_SOCIAL_ID = 'TRUE';
      const localUser = { _id: 'userL', email, provider: 'google' };
      findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(localUser);
      const callback = jest.fn();

      await socialLogin(provider, mockGetProfileDetails)(
        null,
        null,
        null,
        profileFor('sub-C'),
        callback,
      );

      expect(callback.mock.calls[0][0].code).toBe(ErrorTypes.AUTH_FAILED);
      expect(handleExistingUser).not.toHaveBeenCalled();
    });

    it('still continues the account whose provider ID matches', async () => {
      process.env.OPENSCHOOL_STRICT_SOCIAL_ID = 'true';
      const existingUser = { _id: 'userA', email, provider: 'google', googleId: 'sub-A' };
      findUser.mockResolvedValueOnce(existingUser);
      const callback = jest.fn();

      await socialLogin(provider, mockGetProfileDetails)(
        null,
        null,
        null,
        profileFor('sub-A'),
        callback,
      );

      expect(findUser).toHaveBeenCalledTimes(1);
      expect(handleExistingUser).toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(null, existingUser);
    });

    it('keeps the upstream email fallback when the variable is unset or not "true"', async () => {
      for (const value of [undefined, '', 'false', '1', 'yes']) {
        jest.clearAllMocks();
        if (value === undefined) {
          delete process.env.OPENSCHOOL_STRICT_SOCIAL_ID;
        } else {
          process.env.OPENSCHOOL_STRICT_SOCIAL_ID = value;
        }
        const existingUser = { _id: 'userA', email, provider: 'google', googleId: 'sub-A' };
        findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);
        const callback = jest.fn();

        await socialLogin(provider, mockGetProfileDetails)(
          null,
          null,
          null,
          profileFor('sub-B'),
          callback,
        );

        expect(callback).toHaveBeenCalledWith(null, existingUser);
      }
    });

    it('leaves the admin path (existingUsersOnly) to the upstream handling', async () => {
      process.env.OPENSCHOOL_STRICT_SOCIAL_ID = 'true';
      const { updateUser } = require('~/models');
      const existingUser = { _id: 'admin1', email, provider: 'google' };
      findUser.mockResolvedValueOnce(null).mockResolvedValueOnce(existingUser);
      const callback = jest.fn();

      await socialLogin(provider, mockGetProfileDetails, { existingUsersOnly: true })(
        null,
        null,
        null,
        profileFor('sub-admin'),
        callback,
      );

      expect(updateUser).toHaveBeenCalledWith('admin1', { googleId: 'sub-admin' });
      expect(callback).toHaveBeenCalledWith(null, existingUser);
    });
  });
});
