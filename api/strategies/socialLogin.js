/* OpenSchool fork patch: OPENSCHOOL_STRICT_SOCIAL_ID (see OPENSCHOOL.md on branch openschool/main). LibreChat is MIT licensed. */
const { logger } = require('@librechat/data-schemas');
const { ErrorTypes } = require('librechat-data-provider');
const { isEnabled, isEmailDomainAllowed, resolveAppConfigForUser } = require('@librechat/api');
const { createSocialUser, handleExistingUser } = require('./process');
const { getAppConfig } = require('~/server/services/Config');
const { findUser, updateUser } = require('~/models');

/** OpenSchool fork: opt-in, off unless the env var is exactly "true" (case-insensitive). */
const isStrictSocialId = () =>
  String(process.env.OPENSCHOOL_STRICT_SOCIAL_ID ?? '')
    .trim()
    .toLowerCase() === 'true';

/** OpenSchool deployment contract: one request, including body parsing, within five seconds. */
const hasOpenSchoolChatAccess = async (url, subject, emailVerified) => {
  const key = process.env.OPENSCHOOL_GATEWAY_KEY;
  if (
    !key?.trim() ||
    typeof subject !== 'string' ||
    !subject ||
    subject.trim() !== subject ||
    emailVerified !== true
  ) {
    return false;
  }

  const controller = new AbortController();
  let timer;
  try {
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
        controller.abort();
      }, 5000);
    });
    const eligibility = async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'X-OpenSchool-Google-Sub': subject,
          'X-Forwarded-Proto': 'https',
        },
        signal: controller.signal,
        redirect: 'error',
      });
      if (response.status !== 200) {
        return false;
      }
      const body = await response.json();
      return (
        body !== null && typeof body === 'object' && !Array.isArray(body) && body.allowed === true
      );
    };
    return await Promise.race([eligibility(), deadline]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
};

const socialLogin =
  (provider, getProfileDetails, options = {}) =>
  async (accessToken, refreshToken, idToken, profile, cb) => {
    try {
      const { email, id, avatarUrl, username, name, emailVerified } = getProfileDetails({
        idToken,
        profile,
      });

      const baseConfig = await getAppConfig({ baseOnly: true });
      if (!isEmailDomainAllowed(email, baseConfig?.registration?.allowedDomains)) {
        logger.error(
          `[${provider}Login] Authentication blocked - email domain not allowed [Email: ${email}]`,
        );
        const error = new Error(ErrorTypes.AUTH_FAILED);
        error.code = ErrorTypes.AUTH_FAILED;
        error.message = 'Email domain not allowed';
        return cb(error);
      }

      const providerKey = `${provider}Id`;
      let existingUser = null;

      /** First try to find user by provider ID (e.g., googleId, facebookId) */
      if (id && typeof id === 'string') {
        existingUser = await findUser({ [providerKey]: id });
      }
      const foundByProviderId = Boolean(existingUser);

      /** If not found by provider ID, try finding by email */
      if (!existingUser) {
        existingUser = await findUser({ email: email?.trim() });
        if (existingUser) {
          logger.warn(`[${provider}Login] User found by email: ${email} but not by ${providerKey}`);
        }
      }

      /**
       * OpenSchool fork (see OPENSCHOOL.md): the same email is not proof of the same person.
       * With OPENSCHOOL_STRICT_SOCIAL_ID=true a regular social login only continues an account whose
       * provider ID matches exactly; an account found only by email is refused, never taken over or
       * re-linked. The admin path (existingUsersOnly) keeps the upstream handling.
       */
      if (existingUser && !foundByProviderId && !options.existingUsersOnly && isStrictSocialId()) {
        logger.warn(
          `[${provider}Login] Refused email-only match: ${providerKey} differs or is missing (OPENSCHOOL_STRICT_SOCIAL_ID)`,
        );
        const error = new Error(ErrorTypes.AUTH_FAILED);
        error.code = ErrorTypes.AUTH_FAILED;
        return cb(error);
      }

      const chatAccessUrl = process.env.OPENSCHOOL_CHAT_ACCESS_URL;
      if (
        provider === 'google' &&
        !options.existingUsersOnly &&
        chatAccessUrl &&
        !(await hasOpenSchoolChatAccess(chatAccessUrl, id, emailVerified))
      ) {
        logger.warn('[googleLogin] OpenSchool chat access denied');
        const error = new Error(ErrorTypes.AUTH_FAILED);
        error.code = ErrorTypes.AUTH_FAILED;
        return cb(error);
      }

      const appConfig = existingUser?.tenantId
        ? await resolveAppConfigForUser(getAppConfig, existingUser)
        : baseConfig;

      if (!isEmailDomainAllowed(email, appConfig?.registration?.allowedDomains)) {
        logger.error(
          `[${provider}Login] Authentication blocked - email domain not allowed [Email: ${email}]`,
        );
        const error = new Error(ErrorTypes.AUTH_FAILED);
        error.code = ErrorTypes.AUTH_FAILED;
        error.message = 'Email domain not allowed';
        return cb(error);
      }

      const passResult = (user) =>
        refreshToken && provider === 'google' ? cb(null, user, { refreshToken }) : cb(null, user);

      if (existingUser?.provider === provider) {
        if (
          options.existingUsersOnly &&
          id &&
          existingUser[providerKey] &&
          existingUser[providerKey] !== id
        ) {
          logger.warn(
            `[${provider}Login] Rejected admin email fallback for ${email}: stored ${providerKey} does not match`,
          );
          const error = new Error(ErrorTypes.AUTH_FAILED);
          error.code = ErrorTypes.AUTH_FAILED;
          return cb(error);
        }
        if (options.existingUsersOnly && id && !existingUser[providerKey]) {
          if (existingUser.tenantId) {
            logger.warn(
              `[${provider}Login] Admin migrate blocked for tenanted user ${email}: no tenant scope in OAuth callback`,
            );
            const tenantError = new Error(ErrorTypes.AUTH_FAILED);
            tenantError.code = ErrorTypes.AUTH_FAILED;
            return cb(tenantError);
          }
          await updateUser(existingUser._id, { [providerKey]: id });
          const verified = await findUser({ _id: existingUser._id, [providerKey]: id });
          if (!verified) {
            logger.warn(
              `[${provider}Login] Admin migrate superseded by concurrent write, denying: ${email}`,
            );
            const concurrentError = new Error(ErrorTypes.AUTH_FAILED);
            concurrentError.code = ErrorTypes.AUTH_FAILED;
            return cb(concurrentError);
          }
          existingUser[providerKey] = id;
        }
        await handleExistingUser(existingUser, avatarUrl, appConfig, email);
        return passResult(existingUser);
      } else if (existingUser) {
        logger.info(
          `[${provider}Login] User ${email} already exists with provider ${existingUser.provider}`,
        );
        const error = new Error(ErrorTypes.AUTH_FAILED);
        error.code = ErrorTypes.AUTH_FAILED;
        error.provider = existingUser.provider;
        return cb(error);
      }

      if (options.existingUsersOnly) {
        logger.error(
          `[${provider}Login] Admin auth blocked - user does not exist [Email: ${email}]`,
        );
        return cb(null, false, { message: 'User does not exist' });
      }

      const ALLOW_SOCIAL_REGISTRATION = isEnabled(process.env.ALLOW_SOCIAL_REGISTRATION);
      if (!ALLOW_SOCIAL_REGISTRATION) {
        logger.error(
          `[${provider}Login] Registration blocked - social registration is disabled [Email: ${email}]`,
        );
        const error = new Error(ErrorTypes.AUTH_FAILED);
        error.code = ErrorTypes.AUTH_FAILED;
        error.message = 'Social registration is disabled';
        return cb(error);
      }

      const newUser = await createSocialUser({
        email,
        avatarUrl,
        provider,
        providerKey: `${provider}Id`,
        providerId: id,
        username,
        name,
        emailVerified,
        appConfig,
      });
      return passResult(newUser);
    } catch (err) {
      logger.error(`[${provider}Login]`, err);
      return cb(err);
    }
  };

module.exports = socialLogin;
