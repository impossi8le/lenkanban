// @ts-check
const { test, expect } = require('@playwright/test');

const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const BASE_URL = 'http://localhost:3555';

test.describe('kanban-v2 smoke (localhost)', () => {
  test('full flow: auth -> project -> task chat -> admin', async ({ page }) => {
    test.skip(!EMAIL || !PASSWORD, 'E2E_EMAIL/E2E_PASSWORD are not set');

    // 1. Sign in
    await page.goto(`${BASE_URL}/sign-in`, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/(dashboard|projects)/, { timeout: 10000 });

    // 2. Navigate to projects
    await page.goto(`${BASE_URL}/projects`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

    // 3. Open first project
    const firstProject = page.locator('a[href^="/projects/"]').first();
    await expect(firstProject).toBeVisible();
    await firstProject.click();
    await expect(page.getByRole('heading', { name: 'Project Board' })).toBeVisible({ timeout: 10000 });

    // 4. Open first task and test chat
    const firstTaskCard = page.locator('[data-dnd-kit-draggable]').first();
    const taskCount = await firstTaskCard.count();
    
    if (taskCount > 0) {
      await firstTaskCard.click();
      
      // Wait for task dialog to open
      await expect(page.getByRole('heading', { level: 2 })).toBeVisible({ timeout: 5000 });
      
      // Check chat panel exists
      const chatPanel = page.locator('[class*="TaskChatPanel"]').or(page.getByText(/Чат задачи/));
      await expect(chatPanel.first()).toBeVisible({ timeout: 5000 });
      
      // Verify chat is NOT showing "offline"
      const offlineIndicator = page.getByText(/offline/i);
      await expect(offlineIndicator).not.toBeVisible({ timeout: 3000 });
      
      // Send a test message
      const messageInput = page.getByPlaceholder(/Напишите сообщение|Write a message/i);
      if (await messageInput.count() > 0) {
        const testMessage = `E2E test ${Date.now()}`;
        await messageInput.fill(testMessage);
        await messageInput.press('Enter');
        
        // Wait for message to appear
        await expect(page.getByText(testMessage)).toBeVisible({ timeout: 5000 });
        
        // Verify author is NOT "Demo User"
        const demoUserLabel = page.getByText('Demo User');
        await expect(demoUserLabel).not.toBeVisible();
        
        // Reload page and verify message persists
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByText(testMessage)).toBeVisible({ timeout: 5000 });
      }
      
      // Close task dialog
      const closeButton = page.getByRole('button', { name: /close|закрыть/i }).first();
      if (await closeButton.count() > 0) {
        await closeButton.click();
      } else {
        await page.keyboard.press('Escape');
      }
    }

    // 5. Test admin access (if user is admin)
    const adminLink = page.getByRole('link', { name: 'Admin' });
    if (await adminLink.count() > 0) {
      await adminLink.click();
      await expect(page).toHaveURL(/\/admin\/(users|projects)/, { timeout: 5000 });
      await expect(page.getByText(/Admin/)).toBeVisible();
    }
  });
});
