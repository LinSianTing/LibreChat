const cookies = require('cookie');

// Deliberately bypass requireJwtAuth: that middleware may refresh CloudFront cookies.
// This endpoint only reads/verifies the original token and the current browser session.
module.exports =
  ({ centralSSO, ...deps }) =>
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!centralSSO.enabled()) return res.sendStatus(404);
    try {
      const bearer = /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? '');
      if (!bearer) return res.sendStatus(401);
      const parsed = cookies.parse(req.headers.cookie ?? '');
      await centralSSO.checkBrowserTokens(bearer[1], parsed.refreshToken, deps);
      return res.sendStatus(204);
    } catch (error) {
      const rejected =
        error?.status === 401 ||
        error?.status === 403 ||
        ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error?.name);
      return res.sendStatus(rejected ? 401 : 503);
    }
  };
