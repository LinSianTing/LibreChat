import { TooltipAnchor } from '@librechat/client';
import { openSchoolDestinations, openSchoolOrigin } from './navigation';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

/** Workspace return in the collapsed desktop rail, where the full OpenSchool links are inert. */
export default function OpenSchoolRailLink({ collapsed }: { collapsed: boolean }) {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const origin = openSchoolOrigin(startupConfig?.openschoolReturnUrl);
  if (!collapsed || !origin) return null;
  const { path, label } = openSchoolDestinations[0];
  return (
    <TooltipAnchor
      side="right"
      description={localize(label)}
      render={
        <a
          href={`${origin}${path}`}
          aria-label={localize(label)}
          className="flex h-9 w-9 items-center justify-center rounded-lg transition-colors hover:bg-surface-hover"
        >
          <img src="assets/openschool-mark.svg" alt="" width={20} height={20} />
        </a>
      }
    />
  );
}
