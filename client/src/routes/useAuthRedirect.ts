import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { buildLoginRedirectUrl } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';
import { captureHandoff, safeHandoffParams } from '~/hooks/Input/openschoolHandoff';

export default function useAuthRedirect() {
  const { user, roles, isAuthenticated } = useAuthContext();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (isAuthenticated) {
        return;
      }

      const params = new URLSearchParams(location.search);
      const handoff = params.has('os_handoff');
      if (handoff) {
        captureHandoff(params);
      }
      navigate(
        buildLoginRedirectUrl(
          handoff ? '/c/new' : location.pathname,
          handoff ? `?${safeHandoffParams(params)}` : location.search,
          handoff ? '' : location.hash,
        ),
        {
          replace: true,
        },
      );
    }, 300);

    return () => {
      clearTimeout(timeout);
    };
  }, [isAuthenticated, navigate, location]);

  return {
    user,
    roles,
    isAuthenticated,
  };
}
