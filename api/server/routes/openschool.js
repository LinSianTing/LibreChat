const express = require('express');
const { requireJwtAuth, requireSameOrigin } = require('~/server/middleware');

const router = express.Router();
const ID = /^[a-f0-9]{64}$/;
const MODEL = /^(personal|circle-[a-z0-9-]{1,64})$/;
const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 5000;

router.post('/handoff', requireJwtAuth, requireSameOrigin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const fail = (status) => res.status(status).json({ code: 'OPENSCHOOL_HANDOFF_FAILED' });
  if (process.env.OPENSCHOOL_PROMPT_HANDOFF_ENABLED?.toLowerCase() !== 'true') {
    return fail(404);
  }
  const subject = req.user?.googleId;
  if (typeof subject !== 'string' || !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(subject)) {
    return fail(403);
  }
  // A JSON POST with the existing JWT and origin guard; never trust browser identity/config.
  if (!req.get('origin') || !req.is('application/json')) {
    return fail(403);
  }
  try {
    const origin = new URL(req.get('origin')).origin;
    const allowed = [
      process.env.DOMAIN_CLIENT,
      process.env.DOMAIN_SERVER,
      `${req.protocol}://${req.get('host')}`,
    ]
      .filter(Boolean)
      .map((value) => new URL(value).origin);
    if (origin === 'null' || !allowed.includes(origin)) {
      return fail(403);
    }
  } catch {
    return fail(403);
  }
  const body = req.body;
  if (!body || Object.keys(body).length !== 1 || typeof body.id !== 'string' || !ID.test(body.id)) {
    return fail(400);
  }
  let url;
  const key = process.env.OPENSCHOOL_HANDOFF_GATEWAY_KEY;
  try {
    url = new URL(process.env.OPENSCHOOL_HANDOFF_GATEWAY_URL);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.endsWith('/ai-gateway/v1/prompt-handoff/consume') ||
      !key ||
      /[\r\n]/.test(key)
    ) {
      return fail(503);
    }
  } catch {
    return fail(503);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url.href, {
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        'X-OpenSchool-Google-Sub': subject,
        ...(process.env.DOMAIN_CLIENT?.startsWith('https://')
          ? { 'X-Forwarded-Proto': 'https' }
          : {}),
      },
      body: JSON.stringify({ id: body.id }),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return fail([400, 403, 404, 503].includes(response.status) ? response.status : 503);
    }
    if (!response.headers.get('content-type')?.includes('application/json') || !response.body) {
      await response.body?.cancel();
      return fail(503);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) {
        controller.abort();
        return fail(503);
      }
      chunks.push(Buffer.from(chunk));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const expiry = Date.parse(payload.expiresAtUtc);
    if (
      typeof payload.prompt !== 'string' ||
      payload.prompt.trim() === '' ||
      payload.prompt.length > 6000 ||
      typeof payload.model !== 'string' ||
      !MODEL.test(payload.model) ||
      typeof payload.expiresAtUtc !== 'string' ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > Date.now() + 10 * 60 * 1000
    ) {
      return fail(404);
    }
    return res.json({
      prompt: payload.prompt,
      model: payload.model,
      expiresAtUtc: payload.expiresAtUtc,
    });
  } catch {
    // No retry: a lost response may already have consumed the single-use draft.
    // Do not log the exception, subject, ID, body or upstream error response.
    return fail(503);
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
