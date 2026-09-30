import { render, screen } from '@testing-library/react';
import { resolveTheme, validateThemeDefinition } from '@librechat/client';
import { openSchoolDestinations, openSchoolOrigin } from '../navigation';
import OpenSchoolLinks from '../OpenSchoolLinks';
import { openSchoolTheme } from '../theme';

const previousOrigin = process.env.VITE_OPENSCHOOL_BASE_URL;
afterEach(() => {
  if (previousOrigin === undefined) delete process.env.VITE_OPENSCHOOL_BASE_URL;
  else process.env.VITE_OPENSCHOOL_BASE_URL = previousOrigin;
});

describe('OpenSchool deployment navigation', () => {
  it('defaults to the public site with four fixed destinations', () => {
    delete process.env.VITE_OPENSCHOOL_BASE_URL;
    render(<OpenSchoolLinks />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);
    links.forEach((link, i) => {
      expect(link).toHaveAttribute(
        'href',
        `https://openschool.langracetech.com${openSchoolDestinations[i].path}`,
      );
      expect(link).not.toHaveAttribute('target');
    });
  });
  it('uses a configured local development origin without hardcoded local ports', () => {
    process.env.VITE_OPENSCHOOL_BASE_URL = 'http://127.0.0.1:15311';
    render(<OpenSchoolLinks />);
    expect(screen.getAllByRole('link')[0]).toHaveAttribute('href', 'http://127.0.0.1:15311/me');
  });
  it.each([
    'javascript:alert(1)',
    '//evil.test',
    'https://user:pass@example.com',
    'https://example.com/path',
    'https://example.com/?next=https://evil.test',
    'https://example.com/#x',
    'http://public.example.com',
    '',
    'not a URL',
  ])('rejects invalid deployment value %s', (value) => {
    expect(openSchoolOrigin(value)).toBeNull();
  });
  it('does not produce a partial or unsafe navigation for invalid configuration', () => {
    process.env.VITE_OPENSCHOOL_BASE_URL = 'javascript:alert(1)';
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
