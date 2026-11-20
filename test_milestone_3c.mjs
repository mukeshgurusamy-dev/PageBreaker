import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = path.resolve('_test_shots');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function getHudText(page) {
  return page.evaluate(() => document.body.innerText);
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);

  // 1. Calibration Arena + 1.6x Stickman
  await page.screenshot({ path: path.join(OUT_DIR, '01_arena_16x.png') });
  console.log('STEP 1 Arena HUD:', (await getHudText(page)).replace(/\s+/g, ' ').slice(0, 180));

  // 2. Test Free Flight in Arena (Space double-tap + hold)
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.keyboard.press('Space');
  await page.waitForTimeout(120);
  await page.keyboard.down('Space');
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(950);
  const flightHud = await getHudText(page);
  await page.screenshot({ path: path.join(OUT_DIR, '02_arena_flight.png') });
  await page.keyboard.up('Space');
  await page.keyboard.up('KeyD');
  console.log('STEP 2 Flight active:', flightHud.includes('Free Flight'), 'Scale text:', flightHud.match(/Hero [\d.]+×|Micro [\d.]+×/)?.[0]);

  // 3. Load 2026 Bastion (Intact Act I)
  await page.getByRole('button', { name: /Load Site \/ Era/i }).click();
  await page.getByRole('button', { name: '2026 Bastion' }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('Intact · Break') || document.body.innerText.includes('Floating Arena'),
    null,
    { timeout: 15000 },
  );
  await page.waitForTimeout(450);
  const intactHud = await getHudText(page);
  await page.screenshot({ path: path.join(OUT_DIR, '03_bastion_intact.png') });
  console.log('STEP 3 Bastion intact:', intactHud.includes('Intact · Break'), intactHud.match(/Vaults \d+\/\d+/)?.[0]);

  // 4. Wait for clean cosmic floating transition
  await page.waitForFunction(
    () => document.body.innerText.includes('Floating Arena'),
    null,
    { timeout: 8000 },
  );
  await page.waitForTimeout(1050);
  await page.screenshot({ path: path.join(OUT_DIR, '04_bastion_floating_cosmic.png') });
  console.log('STEP 4 Floating Arena active');

  // 5. Fly high above header to verify camera headroom fix (no top clipping)
  await page.keyboard.press('Space');
  await page.waitForTimeout(100);
  await page.keyboard.down('Space');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT_DIR, '05_bastion_sky_flight.png') });
  await page.keyboard.up('Space');
  console.log('STEP 5 Sky Flight captured');

  // 6. Reset to spawn, attack with J to breach the nearby Cyber-Vault card, then enter it once cleanly
  await page.keyboard.press('KeyR');
  await page.waitForTimeout(600);
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.keyboard.press('KeyJ');
  await page.waitForTimeout(400);
  await page.keyboard.press('KeyE');
  await page.waitForTimeout(900);

  let enteredVault = (await getHudText(page)).includes('Micro 0.38×');
  if (!enteredVault) {
    // Descend gently into the breached cyan doorway ring without re-toggling KeyE
    for (let attempt = 0; attempt < 10; attempt++) {
      await page.keyboard.down('KeyS');
      await page.waitForTimeout(220);
      await page.keyboard.up('KeyS');
      await page.keyboard.press('KeyJ');
      await page.waitForTimeout(280);
      const txt = await getHudText(page);
      if (txt.includes('Micro 0.38×')) {
        enteredVault = true;
        break;
      }
    }
  }

  await page.waitForTimeout(1200);
  const insideVaultHud = await getHudText(page);
  await page.screenshot({ path: path.join(OUT_DIR, '06_cyber_vault_inside.png') });
  console.log('STEP 6 Entered Cyber-Vault:', enteredVault, 'Scale:', insideVaultHud.match(/Hero [\d.]+×|Micro [\d.]+×/)?.[0]);

  if (enteredVault) {
    await page.keyboard.press('KeyJ');
    await page.waitForTimeout(450);
    const coreHud = await getHudText(page);
    await page.screenshot({ path: path.join(OUT_DIR, '06b_cyber_vault_action.png') });
    console.log('STEP 6b Vault Core/Orbs:', coreHud.match(/Vaults\s+\d+\/\d+/)?.[0], coreHud.match(/Orbs\s+\d+/)?.[0], 'Scale:', coreHud.match(/Hero [\d.]+×|Micro [\d.]+×/)?.[0]);

    // Exit Vault with KeyE
    await page.keyboard.press('KeyE');
    await page.waitForTimeout(1100);
    const exitedHud = await getHudText(page);
    await page.screenshot({ path: path.join(OUT_DIR, '07_vault_exited.png') });
    console.log('STEP 7 Exited Vault scale:', exitedHud.match(/Hero [\d.]+×|Micro [\d.]+×/)?.[0]);
  }

  // 8. Test 1998 Terminal & https://example.com
  await page.getByRole('button', { name: /Load Site \/ Era/i }).click();
  await page.getByRole('button', { name: '1998 Terminal' }).click();
  await page.waitForTimeout(4200);
  await page.screenshot({ path: path.join(OUT_DIR, '08_1998_floating.png') });
  console.log('STEP 8 1998 Terminal captured');

  await page.getByRole('button', { name: /Load Site \/ Era/i }).click();
  await page.locator('input[placeholder="https://example.com"]').fill('https://example.com');
  await page.getByRole('button', { name: /Capture URL/i }).click();
  await page.waitForFunction(
    () => document.body.innerText.includes('Example Domain'),
    null,
    { timeout: 20000 },
  );
  await page.waitForTimeout(4200);
  await page.screenshot({ path: path.join(OUT_DIR, '09_example_com.png') });
  console.log('STEP 9 example.com captured');

  console.log('CONSOLE_ERRORS:', JSON.stringify(consoleErrors));
  console.log('PAGE_ERRORS:', JSON.stringify(pageErrors));

  await browser.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
