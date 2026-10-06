/**
 * OpenSchool fork (see OPENSCHOOL.md): a refusal from the OpenSchool AI gateway carries the URL of
 * the OpenSchool page the reader can go back to. That text stays text; this module only offers a
 * separate link when the URL is exactly the one the deployment configured
 * (`OPENSCHOOL_RETURN_URL`, published post-login as `openschoolReturnUrl`), optionally followed by
 * `?circle=<code>`. Any other URL in an error — another origin, another path, extra query, a
 * fragment or credentials — is ignored, so error text can never choose where the link goes.
 */
import { useContext } from 'react';
import { useGetStartupConfig } from '~/data-provider';
import { ChatContext } from '~/Providers/ChatContext';
import { ErrorActions, ErrorBody } from './parts';
import { useLocalize } from '~/hooks';

/** The custom endpoint the OpenSchool AI gateway serves (same id as `useEndpoints`). */
export const OPENSCHOOL_ENDPOINT = 'OpenSchool';

/** Circle codes are lowercase letters, digits and hyphens (OpenSchool validates them the same way). */
const CIRCLE_QUERY = /^\?circle=[a-z0-9-]{1,64}$/;

/** URL-looking runs; prose punctuation (including full-width brackets) ends a candidate. */
const URL_CANDIDATE = /https?:\/\/[^\s<>"'`）)」』】，。、]+/g;

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The return link to offer for `text`, rebuilt from the configured URL rather than copied from
 * the text, or undefined when nothing in the text matches it exactly.
 */
export function findOpenSchoolReturnUrl(
  text: string | undefined,
  configured: string | undefined,
): string | undefined {
  if (text == null || configured == null) {
    return undefined;
  }
  const base = parseHttpUrl(configured);
  if (base == null || base.username || base.password || base.search || base.hash) {
    return undefined;
  }
  for (const candidate of text.match(URL_CANDIDATE) ?? []) {
    const url = parseHttpUrl(candidate);
    if (
      url == null ||
      url.origin !== base.origin ||
      url.pathname !== base.pathname ||
      url.username ||
      url.password ||
      url.hash
    ) {
      continue;
    }
    if (url.search !== '' && !CIRCLE_QUERY.test(url.search)) {
      continue;
    }
    return `${base.origin}${base.pathname}${url.search}`;
  }
  return undefined;
}

/**
 * Only the chat surface offers the link: search results and shared links render errors too, and a
 * shared link's viewer is not the person the refusal was for.
 */
export function useOpenSchoolReturnUrl(text: string | undefined): string | undefined {
  const inChat = useContext(ChatContext) != null;
  const { data: startupConfig } = useGetStartupConfig({ enabled: inChat });
  return inChat ? findOpenSchoolReturnUrl(text, startupConfig?.openschoolReturnUrl) : undefined;
}

/** A real link (new tab, no opener), so the chat stays where it was. */
export function OpenSchoolReturnLink({ href }: { href: string }) {
  const localize = useLocalize();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="openschool-return-link"
      className="inline-flex items-center rounded-md border border-border-medium px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary"
    >
      {localize('com_openschool_return_to_circle')}
    </a>
  );
}

/**
 * A refusal from the OpenSchool gateway already explains itself in the reader's language (no
 * permission, no quota left, ...). Leading it with LibreChat's English "could not complete this
 * request (status 403)" made readers think Chat was broken, so for this endpoint the gateway's
 * own message is the whole error. Callers keep the generic copy when there is no message.
 */
export function OpenSchoolGatewayError({
  detail,
  returnUrl,
}: {
  detail: string;
  returnUrl?: string;
}) {
  return (
    <ErrorBody>
      <div className="whitespace-pre-wrap" data-testid="openschool-gateway-error">
        {detail}
      </div>
      {returnUrl != null && (
        <ErrorActions>
          <OpenSchoolReturnLink href={returnUrl} />
        </ErrorActions>
      )}
    </ErrorBody>
  );
}

/** Whether the failure came from the OpenSchool endpoint and carries the gateway's own message. */
export const isOpenSchoolGatewayMessage = (
  endpoint: string | undefined,
  detail: string | undefined,
): detail is string => endpoint === OPENSCHOOL_ENDPOINT && detail != null && detail.trim() !== '';
