import { render, screen } from '@testing-library/react';
import type { TStartupConfig } from 'librechat-data-provider';
import OpenSchoolRailLink from '../OpenSchoolRailLink';

let mockStartupData: Pick<TStartupConfig, 'openschoolReturnUrl'> | undefined;

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(() => ({ data: mockStartupData })),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));

beforeEach(() => {
  mockStartupData = {
    openschoolReturnUrl: 'https://openschool.langracetech.com/simulation/ai-circles',
  };
});

describe('OpenSchool workspace link in the collapsed sidebar rail', () => {
  it('links the collapsed rail to the platform workspace with an accessible name', () => {
    render(<OpenSchoolRailLink collapsed />);
    const link = screen.getByRole('link', { name: 'com_openschool_workspace' });
    expect(link).toHaveAttribute('href', 'https://openschool.langracetech.com/me');
    expect(link).not.toHaveAttribute('target');
  });

  it('is not repeated while the full panel (with its own link) is open', () => {
    render(<OpenSchoolRailLink collapsed={false} />);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('renders nothing until the server provides a valid return origin', () => {
    mockStartupData = undefined;
    const { rerender } = render(<OpenSchoolRailLink collapsed />);
    expect(screen.queryByRole('link')).toBeNull();
    mockStartupData = { openschoolReturnUrl: 'javascript:alert(1)' };
    rerender(<OpenSchoolRailLink collapsed />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
