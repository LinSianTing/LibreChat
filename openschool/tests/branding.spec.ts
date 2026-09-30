import { expect, test } from '@playwright/test';
import { seedConversations, seedMessages, withMongo } from '../../e2e/specs/mock/db';
import { getE2EUser } from '../../e2e/setup/user';

const conversationId = '17390000-0000-4000-8000-000000000001';
const title = 'Synthetic learning notes';
const marker = 'Synthetic transcript: explore a learning question together.';
test.beforeAll(async () => {
  const email = getE2EUser().email;
  await withMongo(async (db) => {
    await db.collection('messages').deleteMany({ conversationId });
    await db.collection('conversations').deleteMany({ conversationId });
  });
  await seedConversations(email, [{ conversationId, title, updatedAt: new Date() }]);
  await seedMessages(email, conversationId, [
    {
      messageId: '17390000-0000-4000-8000-000000000002',
      parentMessageId: '00000000-0000-0000-0000-000000000000',
      text: marker,
      isCreatedByUser: true,
      sender: 'User',
    },
  ]);
});

for (const width of [390, 1440]) {
  for (const scheme of ['light', 'dark']) {
    for (const lang of ['en', 'zh-Hant']) {
      test(`${width} ${scheme} ${lang}: branding, history and navigation`, async ({
        page,
        context,
      }, testInfo) => {
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript(
          ({ scheme, lang }) => {
            localStorage.setItem('color-theme', scheme);
            localStorage.setItem('lang', JSON.stringify(lang));
            localStorage.setItem('chatTitleInTab', 'true');
            localStorage.setItem('navVisible', 'true');
          },
          { scheme, lang },
        );
        await page.goto(`/c/${conversationId}`);
        await expect(page.getByText(marker, { exact: true })).toBeVisible();
        // Selecting persisted history exercises the production title helper.
        if (width < 768) await page.locator('#open-sidebar-button').click();
        const brand = page.getByRole('region', { name: 'OpenSchool', exact: true });
        await expect(brand).toBeVisible();
        if (width < 768) {
          await expect
            .poll(() => brand.evaluate((el) => Math.round(el.getBoundingClientRect().x)))
            .toBe(0);
        }
        await expect(brand.getByRole('link')).toHaveCount(4);
        const labels =
          lang === 'en'
            ? ['Return to workspace', 'Explore courses', 'My schedule', 'AI learning circles']
            : ['返回工作台', '探索課程', '我的課表', 'AI共學圈'];
        const paths = ['/me', '/courses', '/schedule', '/simulation/ai-circles'];
        for (let i = 0; i < paths.length; i++) {
          const link = brand.getByRole('link', { name: labels[i], exact: true });
          await expect(link).toHaveAttribute('href', `http://127.0.0.1:15311${paths[i]}`);
          expect(await link.getAttribute('target')).toBeNull();
        }
        expect(await page.locator('link[rel="icon"]').getAttribute('href')).toBe(
          'assets/openschool-mark.svg',
        );
        const icon = await page.request.get('/assets/openschool-mark.svg');
        expect(icon.ok()).toBeTruthy();
        expect(await icon.text()).toContain('開');
        expect(await page.locator('html').getAttribute('data-theme')).toBe('openschool-forest');
        const bg = await page
          .locator('html')
          .evaluate((el) => getComputedStyle(el).getPropertyValue('--surface-primary-alt').trim());
        expect(bg).toContain(scheme === 'dark' ? '22 31 26' : '243 246 243');
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBeTruthy();
        const linkColor = await brand
          .getByRole('link')
          .first()
          .evaluate((el) => getComputedStyle(el).color);
        expect(linkColor).toBe(scheme === 'dark' ? 'rgb(163, 181, 170)' : 'rgb(79, 97, 87)');
        await brand.getByRole('link').first().focus();
        await expect(brand.getByRole('link').first()).toBeFocused();
        await page.screenshot({
          path: testInfo.outputPath(`${width}-${scheme}-${lang}.png`),
          fullPage: true,
          animations: 'disabled',
        });
        if (width < 768) await page.getByTestId('close-sidebar-button').click();
        // History remains available after reload; the fixture is in this run's isolated database.
        await page.reload();
        await expect(page.getByText(marker, { exact: true })).toBeVisible();
        await expect(page).toHaveTitle(`${title} · OpenSchool-Chat`);
        expect(errors).toEqual([]);
        await page.goto('/c/new');
        await expect(page).toHaveTitle('OpenSchool-Chat');
        await page.goBack();
        await expect(page).toHaveTitle(`${title} · OpenSchool-Chat`);
        if (width === 1440 && lang === 'en' && scheme === 'light') {
          for (const path of paths) {
            const target = `http://127.0.0.1:15311${path}`;
            await page.route(target, (route) =>
              route.fulfill({ contentType: 'text/html', body: '<p>Synthetic destination</p>' }),
            );
            await brand.locator(`a[href="${target}"]`).click();
            await expect(page).toHaveURL(target);
            expect(context.pages()).toHaveLength(1);
            await page.goBack();
            await expect(page.getByText(marker, { exact: true })).toBeVisible();
          }
        }
        expect(context.pages()).toHaveLength(1);
      });
    }
  }
}

test('saved high contrast preference takes precedence over forest branding', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('color-theme', 'high-contrast-dark');
  });
  await page.goto(`/c/${conversationId}`);
  await expect(page.getByText(marker, { exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'high-contrast');
});
