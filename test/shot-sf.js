/* Visual check for the SF map: load game3d.html, place the player at a few vantage
 * points (near the orange bridge, in downtown, on a pier) and save screenshots so the
 * bay water, bridge, pastel low-rise vs glass downtown, and piers can be eyeballed. */
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

  async function shot(name, setup) {
    var info = await page.evaluate(function (setup) {
      var eng = window.__ENG; if (!eng) return { err: 'no __ENG' };
      var W = eng.world, K = eng.constants, TILE = K.TILE;
      W.timeOfDay = 0.5; W.weather = 'clear';   // force bright noon so the city is visible
      // eslint-disable-next-line no-eval
      var s = eval('(' + setup + ')'); s(W, K, TILE);
      for (var i = 0; i < 4; i++) eng.step(1 / 60, {});
      return { x: +W.player.x.toFixed(0), z: +W.player.z.toFixed(0), y: +W.player.y.toFixed(0) };
    }, setup.toString());
    await new Promise(function (r) { setTimeout(r, 450); });
    await page.screenshot({ path: path.join(DIR, name) });
    return info;
  }

  // camPitch semantics: + = look up, − = look down.
  // 1) stand on the SF shore looking NORTH across the strait at the Golden Gate bridge + Marin
  var a = await shot('shot-sf-bridge.png', function (W, K, TILE) {
    var cx = (K.BRIDGE_X0 + K.BRIDGE_X1) / 2 * TILE;
    W.player.inCar = false; W.player.x = cx; W.player.z = (K.CHANNEL_Z1 + 1) * TILE; W.player.y = 0;
    if (window.__setCam) window.__setCam(Math.PI, 0.08); // face north, slight up to catch the towers
  });
  // 2) ON the bridge, looking south toward the SF skyline (proves it's a drivable deck)
  var b = await shot('shot-sf-onbridge.png', function (W, K, TILE) {
    var cx = (K.BRIDGE_X0 + K.BRIDGE_X1) / 2 * TILE;
    W.player.inCar = false; W.player.x = cx; W.player.z = (K.CHANNEL_Z0 + K.CHANNEL_Z1) / 2 * TILE; W.player.y = 0;
    if (window.__setCam) window.__setCam(0, 0.05); // face south along the deck
  });
  // 3) downtown: stand near the hero tower and look UP at the skyline
  var c = await shot('shot-sf-downtown.png', function (W, K, TILE) {
    var ht = W._heroTowers ? W._heroTowers.sales : { x: 62, z: 38 };
    W.player.inCar = false;
    W.player.x = (ht.x - 4) * TILE; W.player.z = (ht.z + 4) * TILE; W.player.y = 0;
    if (window.__setCam) window.__setCam(Math.PI * 1.5, 0.5); // look up toward the towers
  });
  // 4) a residential street — show road + sidewalks + peds walking the sides + varied buildings
  var d = await shot('shot-sf-street.png', function (W, K, TILE) {
    var eng = window.__ENG; for (var k = 0; k < 220; k++) eng.step(1 / 60, {}); // let peds settle onto sidewalks
    W.player.inCar = false; W.player.x = 16 * TILE + 7; W.player.z = 56 * TILE + 7; W.player.y = 0; // SF SW grid
    if (window.__setCam) window.__setCam(Math.PI * 0.5, -0.12); // look east down the street, slightly down
  });
  // 6) a storefront from across the street — the shop should be built INTO a building, not floating
  var f = await shot('shot-sf-storefront.png', function (W, K, TILE) {
    var gun = null; for (var i = 0; i < W.shops.length; i++) if (W.shops[i].type === 'gun') gun = W.shops[i];
    var dx = gun.dirx || 0, dz = gun.dirz != null ? gun.dirz : -1; // building→road (away from facade)
    var px = gun.x + dx * 6 + (-dz) * 9, pz = gun.z + dz * 6 + dx * 9; // stand off to the side, in the street
    W.player.inCar = false; W.player.x = px; W.player.z = pz; W.player.y = 0;
    if (window.__setCam) window.__setCam(Math.atan2(gun.bx - px, gun.bz - pz), 0.12); // look diagonally at the facade + sign
  });
  // 5) INSIDE the gun shop — should read as a gun shop (counter, wall gun racks)
  var e = await shot('shot-sf-gunshop.png', function (W, K, TILE) {
    var IN = window.__ENG._internal, gun = null;
    for (var i = 0; i < W.shops.length; i++) if (W.shops[i].type === 'gun') gun = W.shops[i];
    W.player.inCar = false; W.player.x = gun.x; W.player.z = gun.z; W.player.y = 0;
    IN.enterShop(gun);
    if (window.__setCam) window.__setCam(Math.PI, 0.12); // face the back counter + gun racks
  });

  console.log('SF_SHOTS ' + JSON.stringify({ a: a, b: b, c: c }) + ' errs=' + errs.length);
  if (errs.length) console.log('ERRS ' + JSON.stringify(errs.slice(0, 5)));
  await browser.close();
  process.exit(errs.length ? 1 : 0);
})();
