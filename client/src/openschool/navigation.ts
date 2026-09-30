/** Trusted deployment origin; never sourced from URL queries or user profiles. */
export function openSchoolOrigin(value: string | undefined): string | null {
  if (value === undefined) return 'https://openschool.langracetech.com';
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
export const openSchoolDestinations = [
  { path: '/me', label: 'com_openschool_workspace' },
  { path: '/courses', label: 'com_openschool_courses' },
  { path: '/schedule', label: 'com_openschool_schedule' },
  { path: '/simulation/ai-circles', label: 'com_openschool_circles' },
] as const;
