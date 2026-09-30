import { chromium } from '@playwright/test';
import type { FullConfig } from '@playwright/test';
import { getE2EUser } from '../../e2e/setup/user';

/** Isolated synthetic harness only; OS Chrome language must not change the setup selectors. */
export default async function setup(config: FullConfig) {
  const user = getE2EUser();
  const { baseURL, storageState } = config.projects[0].use;
  if (!baseURL || typeof storageState !== 'string') throw new Error('Missing isolated test setup');
  if (baseURL !== 'http://127.0.0.1:15312') {
    throw new Error('Branding QA only accepts the isolated 127.0.0.1:15312 harness');
  }
  const browser = await chromium.launch({ channel: process.env.E2E_CHROMIUM_CHANNEL || 'chrome' });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('lang', JSON.stringify('en'));
      localStorage.setItem('navVisible', 'true');
    });
    await page.goto(`${baseURL}/register`);
    await page.getByLabel('Full name').fill(user.name);
    await page.getByLabel('Email').fill(user.email);
    await page.getByTestId('password').fill(user.password);
    await page.getByTestId('confirm_password').fill(user.password);
    await page.getByLabel('Submit registration').click();
    await page.waitForURL(`${baseURL}/c/new`);
    await page.goto(`${baseURL}/login`);
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill(user.password);
    await page.getByTestId('login-button').click();
    await page.waitForURL(`${baseURL}/c/new`);
    await page.context().storageState({ path: storageState });
  } finally {
    await browser.close();
  }
}
