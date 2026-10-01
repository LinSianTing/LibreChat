import { Button } from '@librechat/client';
import { useLocalize } from '~/hooks';

/** Fixed OpenSchool exit, also available without startup config or authentication. */
export default function OpenSchoolReturnHome() {
  const localize = useLocalize();
  return (
    <Button asChild variant="outline">
      <a href="https://openschool.langracetech.com">{localize('com_openschool_return_home')}</a>
    </Button>
  );
}
