import { render, screen } from '@testing-library/react';
import { resolveTheme, validateThemeDefinition } from '@librechat/client';
import type { TStartupConfig } from 'librechat-data-provider';
import { openSchoolDestinations, openSchoolOrigin } from '../navigation';
import OpenSchoolLinks from '../OpenSchoolLinks';
import { openSchoolTheme } from '../theme';

const previousOrigin = process.env.VITE_OPENSCHOOL_BASE_URL;
let mockStartupData: Pick<TStartupConfig, 'openschoolReturnUrl'> | undefined;

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(() => ({ data: mockStartupData })),
}));

beforeEach(() => {
  mockStartupData = undefined;
  process.env.VITE_OPENSCHOOL_BASE_URL = 'https://stale-build.example';
});

afterEach(() => {
  if (previousOrigin === undefined) delete process.env.VITE_OPENSCHOOL_BASE_URL;
  else process.env.VITE_OPENSCHOOL_BASE_URL = previousOrigin;
});

describe('OpenSchool deployment navigation', () => {
  it.each([
    'https://openschool.langracetech.com',
    'https://school.example:8443',
    'http://127.0.0.1:15311',
    'http://localhost:5199',
    'http://[::1]:15311',
  ])('derives all four same-tab destinations from runtime origin %s', (origin) => {
    mockStartupData = { openschoolReturnUrl: `${origin}/simulation/ai-circles` };
    render(<OpenSchoolLinks />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);
    links.forEach((link, i) => {
      expect(link).toHaveAttribute('href', `${origin}${openSchoolDestinations[i].path}`);
      expect(link).not.toHaveAttribute('target');
    });
  });
  it('hides links while startup config is unavailable and follows subsequent runtime values', () => {
    const { rerender } = render(<OpenSchoolLinks />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    for (const origin of ['http://127.0.0.1:15311', 'https://school.example']) {
      mockStartupData = { openschoolReturnUrl: `${origin}/simulation/ai-circles` };
      rerender(<OpenSchoolLinks />);
      expect(screen.getAllByRole('link')[0]).toHaveAttribute('href', `${origin}/me`);
    }
    mockStartupData = {};
    rerender(<OpenSchoolLinks />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
  it.each([undefined, 'https://openschool.langracetech.com'])(
    'does not fall back to the build-time value %s when runtime config is absent',
    (buildOrigin) => {
      if (buildOrigin === undefined) delete process.env.VITE_OPENSCHOOL_BASE_URL;
      else process.env.VITE_OPENSCHOOL_BASE_URL = buildOrigin;
      mockStartupData = {};
      render(<OpenSchoolLinks />);
      expect(screen.queryAllByRole('link')).toHaveLength(0);
    },
  );
  it('extracts only the origin from a configured return path', () => {
    expect(openSchoolOrigin('https://school.example/simulation/ai-circles')).toBe(
      'https://school.example',
    );
  });
  it.each([
    'javascript:alert(1)',
    '//evil.test',
    'https://user:pass@example.com',
    'https://example.com/?next=https://evil.test',
    'https://example.com/#x',
    'http://public.example.com',
    'http://localhost.evil.test/simulation/ai-circles',
    'ftp://example.com/simulation/ai-circles',
    'https://example.com/simulation/ai-circles?circle=pine',
    'https://example.com/simulation/ai-circles#x',
    undefined,
    '',
    'not a URL',
  ])('hides all links for invalid or missing runtime value %s', (value) => {
    expect(openSchoolOrigin(value)).toBeNull();
    mockStartupData = { openschoolReturnUrl: value };
    render(<OpenSchoolLinks />);
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });
  it('normalizes HTTPS origin and accepts IPv6 loopback', () => {
    expect(openSchoolOrigin('https://school.example:8443/')).toBe('https://school.example:8443');
    expect(openSchoolOrigin('http://[::1]:15311')).toBe('http://[::1]:15311');
  });
});

describe('OpenSchool canonical theme', () => {
  it('uses valid versioned semantic tokens in both modes', () => {
    expect(validateThemeDefinition(openSchoolTheme)).toEqual([]);
    for (const mode of ['light', 'dark'] as const) {
      const theme = resolveTheme(openSchoolTheme, mode);
      expect(theme).toBeDefined();
    }
    expect(openSchoolTheme.modes.light?.colors?.['rgb-link']).toBe('31 95 74');
    expect(openSchoolTheme.modes.dark?.colors?.['rgb-link']).toBe('127 205 169');
  });
});
