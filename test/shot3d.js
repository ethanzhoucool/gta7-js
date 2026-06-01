/* Capture gameplay screenshots from the real 3D build for visual review.
 * Drives synthetic input through the page (pointer-lock can't engage headless, so
 * we poke the engine's input by dispatching key events and nudging camYaw), waits
 * for the camera to settle, and saves a few PNGs. */
'use strict';
var puppeteer = require('puppeteer-core');
var path = require('path');

var CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
var PAGE = 'file://' + path.resolve(__dirname, '..', 'game3d.html');
var DIR = path.resolve(__dirname, '..');

(async function () {
  var browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
           '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800']
  });
  var page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  var errs = [];
  page.on('pageerror', function (e) { errs.push(String(e.message || e)); });
  await page.goto(PAGE, { waitUntil: 'load', timeout: 30000 });

  // Drive the engine directly via its exposed instance: place the player in a car
  // and feed input so we get a moving, populated scene to look at.
  await page.evaluate(function () {
    // expose a hook: the IIFE doesn't export, but window.GTA3D + a fresh engine won't
    // match the rendered one. Instead simulate held keys the renderer reads.
    function press(code, down) {
      document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code: code, bubbles: true }));
    }
    window.__press = press;
  });

  // shot A: on-foot, after a short settle (camera framing of the character + city)
  await new Promise(function (r) { setTimeout(r, 1500); });
  await page.screenshot({ path: path.join(DIR, 'shot-foot.png') });

  // walk forward a couple seconds so the camera trails and the city scrolls
  await page.evaluate(function () { window.__press('KeyW', true); });
  await new Promise(function (r) { setTimeout(r, 1800); });
  await page.screenshot({ path: path.join(DIR, 'shot-walk.png') });
  await page.evaluate(function () { window.__press('KeyW', false); });

  // enter the nearest car (F) and drive, to show the in-car chase cam over the city
  await page.evaluate(function () { window.__press('KeyF', true); });
  await new Promise(function (r) { setTimeout(r, 60); });
  await page.evaluate(function () { window.__press('KeyF', false); window.__press('KeyW', true); });
  await new Promise(function (r) { setTimeout(r, 2200); });
  await page.screenshot({ path: path.join(DIR, 'shot-drive.png') });
  await page.evaluate(function () { window.__press('KeyW', false); });

  console.log('SHOTS_DONE errs=' + errs.length);
  await browser.close();
  process.exit(0);
})();
