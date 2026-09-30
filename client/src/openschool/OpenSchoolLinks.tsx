import { openSchoolDestinations, openSchoolOrigin } from './navigation';
import { DEFAULT_APP_TITLE } from '~/utils/documentTitle';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

export default function OpenSchoolLinks() {
  const localize = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const origin = openSchoolOrigin(startupConfig?.openschoolReturnUrl);
  if (!origin) return null;
  return (
    <section aria-label="OpenSchool" className="shrink-0 border-b border-border-light p-3">
      <div className="mb-2 flex items-center gap-2 px-2 text-sm font-semibold text-text-primary">
        <img src="assets/openschool-mark.svg" alt="" width={28} height={28} />
        <span>{DEFAULT_APP_TITLE}</span>
      </div>
      <div className="space-y-0.5">
        {openSchoolDestinations.map(({ path, label }) => (
          <a
            key={path}
            href={`${origin}${path}`}
            className="block rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring-primary"
          >
            {localize(label)}
          </a>
        ))}
      </div>
    </section>
  );
}
