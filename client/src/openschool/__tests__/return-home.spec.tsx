import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import traditionalChinese from '~/locales/zh-Hant/translation.json';
import RouteErrorBoundary from '~/routes/RouteErrorBoundary';
import OpenSchoolReturnHome from '../OpenSchoolReturnHome';
import OAuthError from '~/components/OAuth/OAuthError';
import AuthLayout from '~/components/Auth/AuthLayout';
import english from '~/locales/en/translation.json';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useRouteError: () => ({ message: 'https://evil.example/?redirect=elsewhere' }),
}));
jest.mock('~/components/Banners', () => ({ Banner: () => null }));
jest.mock('~/components/Auth/BlinkAnimation', () => ({
  BlinkAnimation: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('~/components/Auth/SocialLoginRender', () => () => null);
jest.mock('~/components/Auth/Footer', () => () => null);

const expectFixedExit = () => {
  const link = screen.getByRole('link', { name: 'com_openschool_return_home' });
  expect(link).toHaveAttribute('href', 'https://openschool.langracetech.com');
  expect(link).not.toHaveAttribute('target');
  expect(link).not.toHaveAttribute('onclick');
};

const loginContent = 'Login content';
const errorContent = 'Error content';

describe('Fixed OpenSchool return exit', () => {
  it('works without startup config and ignores redirect query input', () => {
    expect.assertions(3);
    render(
      <MemoryRouter
        initialEntries={['/login?redirect_to=https://evil.example&returnUrl=javascript:alert(1)']}
      >
        <OpenSchoolReturnHome />
      </MemoryRouter>,
    );
    expectFixedExit();
  });

  it.each([false, true])(
    'remains visible on login while fetching=%s and config fails',
    (isFetching) => {
      render(
        <AuthLayout
          header="Login"
          isFetching={isFetching}
          startupConfig={undefined}
          startupConfigError={new Error('unavailable')}
          pathname="/login"
          error={null}
        >
          <p>{loginContent}</p>
        </AuthLayout>,
      );
      expectFixedExit();
      expect(screen.getByText('Login content')).toBeInTheDocument();
    },
  );

  it('is visible on an auth layout error outside login', () => {
    expect.assertions(3);
    render(
      <AuthLayout
        header="Error"
        isFetching={false}
        startupConfig={undefined}
        startupConfigError={null}
        pathname="/reset-password"
        error="com_auth_error_invalid_reset_token"
      >
        <p>{errorContent}</p>
      </AuthLayout>,
    );
    expectFixedExit();
  });

  it('is visible on a route error and preserves existing recovery actions', () => {
    render(<RouteErrorBoundary />);
    expectFixedExit();
    expect(screen.getByRole('button', { name: 'com_ui_refresh_page' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'com_ui_download_error_logs' })).toBeInTheDocument();
  });

  it('is visible on an OAuth error without changing the close action', () => {
    render(
      <MemoryRouter
        initialEntries={['/oauth/error?error=invalid_state&returnUrl=https://evil.example']}
      >
        <OAuthError />
      </MemoryRouter>,
    );
    expectFixedExit();
    expect(screen.getByRole('button', { name: 'com_ui_close_window' })).toBeInTheDocument();
  });

  it('provides English and Traditional Chinese labels', () => {
    expect(english.com_openschool_return_home).toBe('Return to OpenSchool');
    expect(traditionalChinese.com_openschool_return_home).toBe('返回開放學校');
  });
});
