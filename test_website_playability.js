import { chromium } from 'playwright';
import fs from 'fs';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl'],
  });

  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  const pageErrors = [];
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  console.log('Navigating to http://localhost:3000...');
  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  if (!fs.existsSync('_test_shots')) {
    fs.mkdirSync('_test_shots');
  }

  // 1. Initial Playground Arena
  await page.screenshot({ path: '_test_shots/01_arena.png' });
  console.log('01_arena.png captured');

  // 2. Open Site Drawer and load 1998 Terminal
  console.log('Loading 1998 Retro Terminal...');
  const loadButton = page.locator('button:has-text("Load Site / Era")');
  await loadButton.click();
  await page.waitForTimeout(400);

  const retroBtn = page.locator('button:has-text("1998 Terminal")');
  await retroBtn.click();

  // Wait for baking to complete
  await page.waitForFunction(() => {
    const el = document.querySelector('header');
    return el && el.textContent && el.textContent.toLowerCase().includes('cybergrid');
  }, { timeout: 12000 });
  await page.waitForTimeout(1500);

  await page.screenshot({ path: '_test_shots/02_1998_terminal_spawn.png' });
  console.log('02_1998_terminal_spawn.png captured');

  // 3. Test Parkour & Drop-Through on 1998 Terminal
  console.log('Testing stickman parkour & drop-through on 1998 Terminal...');
  const canvas = page.locator('canvas');
  await canvas.focus();

  // Run right
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(400);
  await page.keyboard.up('KeyD');

  // Jump
  await page.keyboard.press('Space');
  await page.waitForTimeout(300);

  // Drop through ledge: hold S + Space
  await page.keyboard.down('KeyS');
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  await page.keyboard.up('KeyS');

  await page.screenshot({ path: '_test_shots/03_1998_terminal_dropped.png' });
  console.log('03_1998_terminal_dropped.png captured');

  // 4. Switch to 2016 Responsive Portal
  console.log('Loading 2016 Nimbus Cloud Portal...');
  const loadButton2 = page.locator('button:has-text("Load Site / Era")');
  await loadButton2.click();
  await page.waitForTimeout(300);
  const portalBtn = page.locator('button:has-text("2016 Portal")');
  await portalBtn.click();

  await page.waitForFunction(() => {
    const el = document.querySelector('header');
    return el && el.textContent && el.textContent.toLowerCase().includes('nimbus');
  }, { timeout: 12000 });
  await page.waitForTimeout(1500);

  await page.screenshot({ path: '_test_shots/04_2016_portal.png' });
  console.log('04_2016_portal.png captured');

  // Drop through on 2016 Portal
  await canvas.focus();
  await page.keyboard.down('KeyS');
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  await page.keyboard.up('KeyS');

  await page.screenshot({ path: '_test_shots/05_2016_portal_dropped.png' });
  console.log('05_2016_portal_dropped.png captured');

  // 5. Switch to 2026 Bastion
  console.log('Loading 2026 Bastion...');
  const loadButton3 = page.locator('button:has-text("Load Site / Era")');
  await loadButton3.click();
  await page.waitForTimeout(300);
  const bastionBtn = page.locator('button:has-text("2026 Bastion")');
  await bastionBtn.click();

  await page.waitForFunction(() => {
    const el = document.querySelector('header');
    return el && el.textContent && el.textContent.toLowerCase().includes('aether');
  }, { timeout: 12000 });
  await page.waitForTimeout(1500);

  await page.screenshot({ path: '_test_shots/06_2026_bastion.png' });
  console.log('06_2026_bastion.png captured');

  // Toggle to 3D angled view (V)
  await canvas.focus();
  await page.keyboard.press('KeyV');
  await page.waitForTimeout(800);

  await page.screenshot({ path: '_test_shots/07_2026_bastion_3d_angled.png' });
  console.log('07_2026_bastion_3d_angled.png captured');

  console.log('Test Summary:');
  console.log('Console errors:', consoleErrors.length, consoleErrors);
  console.log('Page errors:', pageErrors.length, pageErrors);

  await browser.close();
}

main().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
