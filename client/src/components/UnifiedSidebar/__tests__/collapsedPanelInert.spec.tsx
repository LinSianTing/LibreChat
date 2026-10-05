import { render, screen } from '@testing-library/react';
import type { NavLink } from '~/common';
import Sidebar from '../Sidebar';

jest.mock('../ExpandedPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="rail" />,
}));
jest.mock('~/components/SidePanel/Nav', () => ({
  __esModule: true,
  default: () => <a href="https://openschool.langracetech.com/me">{'workspace'}</a>,
}));

const renderSidebar = (expanded: boolean) =>
  render(
    <Sidebar
      links={[] as NavLink[]}
      expanded={expanded}
      width={320}
      minWidth={240}
      maxWidth={480}
      onCollapse={jest.fn()}
      onExpand={jest.fn()}
      onLeaveInsights={jest.fn()}
      onResizeStart={jest.fn()}
      onResizeKeyboard={jest.fn()}
    />,
  );

describe('desktop sidebar panel contents', () => {
  it('are inert while collapsed, so no hidden link can be focused or clicked through', () => {
    const { container } = renderSidebar(false);
    const panel = container.querySelector('nav');
    expect(panel).toHaveAttribute('inert');
    expect(screen.queryByRole('link', { name: 'workspace' })).toBeNull();
  });

  it('are interactive while expanded', () => {
    const { container } = renderSidebar(true);
    expect(container.querySelector('nav')).not.toHaveAttribute('inert');
    expect(screen.getByRole('link', { name: 'workspace' })).toBeVisible();
  });
});
