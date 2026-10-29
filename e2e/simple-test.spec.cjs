// @ts-check
const { test, expect } = require('@playwright/test');

test('simple navigation test', async ({ page }) => {
  await page.goto('https://kanban.lenremontn8n.ru/sign-in', { 
    waitUntil: 'domcontentloaded',
    timeout: 30000 
  });
  
  await page.screenshot({ path: 'test-results/sign-in-page.png' });
  
  const title = await page.title();
  console.log('Page title:', title);
  
  const emailInput = page.locator('input[type="email"]');
  const passwordInput = page.locator('input[type="password"]');
  
  console.log('Email input count:', await emailInput.count());
  console.log('Password input count:', await passwordInput.count());
  
  expect(await emailInput.count()).toBeGreaterThan(0);
  expect(await passwordInput.count()).toBeGreaterThan(0);
});
