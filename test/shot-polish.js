/* One-off vantage shots for the visual overhaul: aerial roofs, night street
 * (streetlights + lit windows + headlights), and a close-up of the car model. */
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
  page.on('console', function (m) { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.goto(PAGE, { waitUntil: 'load', timeout: 30000 });
  await new Promise(function (r) { setTimeout(r, 700); });
  await page.evaluate(function () { if (window.__startGame) window.__startGame(); });

  async function shot(name, setup) {
    await page.evaluate(function (setup) {
      var eng = window.__ENG; var W = eng.world, K = eng.constants, TILE = K.TILE;
      // eslint-disable-next-line no-eval
      var s = eval('(' + setup + ')'); s(W, K, TILE);
      for (var i = 0; i < 4; i++) eng.step(1 / 60, {});
    }, setup.toString());
    await new Promise(function (r) { setTimeout(r, 450); });
    await page.screenshot({ path: path.join(DIR, name) });
  }

  // 1) noon aerial over midtown — roofs must read as roofs, not black window grids
  await shot('shot-sf-aerial.png', function (W, K, TILE) {
    W.timeOfDay = 0.5; W.weather = 'clear';
    W.player.inCar = false; W.player.x = 40 * TILE; W.player.z = 56 * TILE; W.player.y = 60;
    if (window.__setCam) window.__setCam(Math.PI * 0.25, -0.85);
  });
  // 2) night street — lamp glow, lit windows, parked cars
  await shot('shot-sf-night.png', function (W, K, TILE) {
    W.timeOfDay = 0.0; W.weather = 'clear';
    W.player.inCar = false; W.player.x = 41 * TILE; W.player.z = 58 * TILE; W.player.y = 0;
    if (window.__setCam) window.__setCam(0, 0.02);
  });
  // 3) dusk close-up of a car the player stands next to
  await shot('shot-sf-car.png', function (W, K, TILE) {
    W.timeOfDay = 0.78; W.weather = 'clear';
    var c = W.cars[0];
    if (c) { W.player.x = c.x + 4; W.player.z = c.z + 5; }
    W.player.inCar = false; W.player.y = 0;
    if (window.__setCam) window.__setCam(Math.PI * 0.85, -0.12);
  });
  console.log('POLISH_SHOTS errs=' + errs.length + (errs.length ? ' ' + errs.join(' | ') : ''));
  await browser.close();
})();
