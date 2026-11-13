// Screenshots of the user guide (doc/images), on the demo project created by tools/captures.sh.
// Usage: node tools/captures.js <output dir> [base url] [fr|en]  (language of the interface and of the demo project names)
const { chromium } = require('playwright');
const OUT = process.argv[2], BASE = process.argv[3] || 'http://127.0.0.1:8767/';
const LANG = process.argv[4] === 'en' ? 'en' : 'fr';
// Labels the script clicks on, per language (exact texts of frontend/src/i18n)
const L = LANG === 'en'
  ? { ride: 'Ride 14 June', seq: 'Sequences', summary: 'Import', export: 'Export', sync: 'Sync', photo: 'Positions and direction', basemap: 'Background map' }
  : { ride: 'Sortie 14 juin', seq: 'Séquences', summary: 'Import', export: 'Export', sync: 'Synchro', photo: 'Positions et sens', basemap: 'Fond de carte' };
(async () => {
  const b = await chromium.launch(); const errors = [];
  const ctx = await b.newContext({ viewport: { width: 1280, height: 760 }, colorScheme: 'light', locale: LANG === 'en' ? 'en-GB' : 'fr-FR' });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  const wait = (ms = 700) => p.waitForTimeout(ms);
  const tiles = () => p.waitForFunction(() => window.__pssMap && window.__pssMap.areTilesLoaded(), null, { timeout: 20000 }).catch(() => {}).then(() => wait(800));
  const shot = async (name, opts = {}) => { await p.screenshot({ path: `${OUT}/${name}.png`, ...opts }); console.log('ok', name); };
  const go = async (n) => { await p.keyboard.press('Home'); for (let i = 0; i < Math.floor(n / 10); i++) await p.keyboard.press('Shift+ArrowRight'); for (let i = 0; i < n % 10; i++) await p.keyboard.press('ArrowRight'); await wait(); };

  await p.addInitScript((lang) => { try { localStorage.setItem('pss-basemap', 'osm'); localStorage.setItem('pss-follow', '1'); localStorage.setItem('pss-lang', lang); localStorage.setItem('pss-tips-seen', '1') } catch {} }, LANG);
  await p.goto(BASE); await p.waitForSelector('.project-name'); await wait();
  await shot('01-projets');

  await p.click(`.project-name:has-text("${L.ride}")`); await p.waitForSelector('.steps');
  await go(40); await p.evaluate(() => window.__pssMap.zoomTo(16.3, { duration: 0 })); await tiles();
  await shot('02-ecran');

  // Début / Fin in progress, on unclassified photos
  await go(335); await p.keyboard.press('d'); for (let i = 0; i < 18; i++) await p.keyboard.press('ArrowRight'); await wait(); await tiles();
  await shot('03-debut-fin');
  await p.keyboard.press('Escape');

  await p.click(`.step:has(.lab:text-is("${L.seq}"))`); await wait();
  await shot('04-sequences');

  await p.click(`.step:has(.lab:text-is("${L.summary}"))`); await wait();
  await shot('09-bilan');

  await p.click(`.step:has(.lab:text-is("${L.export}"))`); await wait();
  await shot('08-export');

  // satellite IGN for sync and positions
  await p.selectOption(`select[aria-label="${L.basemap}"]`, 'ign-ortho'); await wait(1000);
  await p.click(`.step:has(.lab:text-is("${L.sync}"))`); await wait(1500);
  await go(150); await p.evaluate(() => window.__pssMap.zoomTo(18, { duration: 0 })); await tiles();
  await shot('05-synchro');

  await p.click(`.step:has(.lab:text-is("${L.photo}"))`); await wait();
  await go(100); await p.keyboard.press('m'); await p.evaluate(() => window.__pssMap.zoomTo(18.5, { duration: 0 })); await tiles();
  const mk = await p.locator('.maplibregl-marker').last().boundingBox();
  if (mk) { const x = mk.x + mk.width / 2, y = mk.y + mk.height - 4; await p.mouse.move(x, y); await p.mouse.down(); await p.mouse.move(x + 40, y - 25, { steps: 8 }); await p.mouse.up(); await wait(1200); }
  await shot('06-positions');
  await p.keyboard.press('Control+z'); await wait(); await p.keyboard.press('m');

  // heading / orientation part of the photo panel
  await go(130); await wait(1500);
  await p.setViewportSize({ width: 1280, height: 1500 }); await wait(1200);
  const box = await p.evaluate(() => { const r = document.querySelector('details[data-section="travel"]').getBoundingClientRect(); return { x: r.x, y: r.y - 6, width: r.width, height: r.height + 12 } });
  await p.screenshot({ path: `${OUT}/07-cap.png`, clip: box }); console.log('ok 07-cap');
  await p.setViewportSize({ width: 1280, height: 760 }); await wait();

  await p.keyboard.press('?'); await wait(); await shot('11-raccourcis'); await p.keyboard.press('Escape'); await p.keyboard.press('?').catch(() => {}); await wait();
  if (await p.locator('.modal').count()) await p.keyboard.press('?');

  // Panoramax overlay (real data from the meta-catalogue)
  await p.selectOption(`select[aria-label="${L.basemap}"]`, 'osm'); await wait(800);
  await go(250); await p.click('button:has-text("Panoramax")'); await wait();
  await p.click('.map-legend button'); await wait(300); await tiles(); // legend open: age classes of the coverage
  await p.evaluate(() => window.__pssMap.jumpTo({ zoom: 16.5 })); await tiles(); await wait(2500);
  const pt = await p.evaluate(() => { const m = window.__pssMap; const fs = m.queryRenderedFeatures({ layers: ['pnx-pictures'] }); const r = m.getContainer().getBoundingClientRect();
    const f = fs.find(f => { const c = m.project(f.geometry.coordinates); return c.x > 360 && c.x < r.width - 150 && c.y > 150 && c.y < r.height - 150 }); if (!f) return null; const c = m.project(f.geometry.coordinates); return [c.x + r.left, c.y + r.top] });
  if (pt) { await p.mouse.move(pt[0], pt[1]); await p.waitForSelector('.pnx-popup'); await p.waitForFunction(() => !/…/.test(document.querySelector('.pnx-popup').innerText), null, { timeout: 15000 }).catch(() => {}); }
  console.log('popup', pt && await p.locator('.pnx-popup').innerText().catch(() => ''));
  await shot('10-panoramax');
  await p.click('.map-legend button'); await wait(300);
  await p.mouse.move(5, 300); await p.click('button:has-text("Panoramax")'); await wait();

  console.log('errors', JSON.stringify(errors)); await b.close();
})();
