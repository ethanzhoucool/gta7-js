/* End-to-end in-browser playtest: boots the real 3D build in headless Chrome and
 * drives each gameplay loop through the LIVE engine (window.__ENG), asserting each
 * one actually produces its reward/state in a running renderer — not just in Node.
 * This is the "does it actually work when you play it" check. */
'use strict';
var puppeteer = require('puppeteer-core');
var path = require('path');
var CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
var PAGE = 'file://' + path.resolve(__dirname, '..', 'game3d.html');

(async function () {
  var out = { steps: {}, errs: [] };
  var browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
           '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,800']
  });
  var page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('console', function (m) { if (m.type() === 'error') out.errs.push('console: ' + m.text()); });
  page.on('pageerror', function (e) { out.errs.push('page: ' + String(e.message || e)); });
  await page.goto(PAGE, { waitUntil: 'load', timeout: 30000 });
  await new Promise(function (r) { setTimeout(r, 600); });

  // Drive each loop through the live engine and report whether it paid out / fired.
  out.steps = await page.evaluate(function () {
    var eng = window.__ENG, W = eng.world, IN = eng._internal, S = 1 / 60;
    function clearPeds() { for (var i = 0; i < W.peds.length; i++) W.peds[i].alive = false; }
    function flatGrid() { for (var z = 0; z < 40; z++) for (var x = 0; x < 40; x++) W.grid[z][x] = 0; }
    var r = {};

    // courier: accept at a depot, "drive" to the drop, confirm payout + cash popup
    (function () {
      var dep = W.jobDepots[0]; W.player.inCar = false; W.player.x = dep.x; W.player.z = dep.z;
      var m0 = W.money; IN.acceptJob();
      var hadJob = !!W.job;
      W.player.x = W.job.dropX; W.player.z = W.job.dropZ; eng.step(S, {});
      r.courier = hadJob && W.money > m0 && W.popups.length > 0;
    })();

    // store robbery in the live renderer
    (function () {
      W.player.inCar = false; W.player.x = W.stores[0].x; W.player.z = W.stores[0].z; W.wanted = 0; W.stores[0].cooldown = 0;
      var m0 = W.money; var ok = IN.robStore();
      r.store = ok && W.money > m0;
    })();

    // weapons: buy + switch + the shotgun actually fires multiple pellets
    (function () {
      W.money = 99999; IN.giveWeapon('shotgun'); IN.switchWeapon('shotgun');
      W.bullets.length = 0; W.fireCd = 0;
      IN.fireWeapon({ aimYaw: 0 });
      r.shotgunPellets = W.bullets.filter(function (b) { return b.team === 'player'; }).length;
      r.weaponSwitch = (W.player.weapon === 'shotgun');
    })();

    // vigilante: spawn a fugitive, kill it, confirm bounty + chain
    (function () {
      W.vigilanteCd = 0; W.wanted = 0; var ok = IN.startVigilante();
      var m0 = W.money; var t = IN.findPedById(W.vigilante.pedId); t.hp = 0; IN.killPed(t, true); eng.step(S, {});
      r.vigilante = ok && W.money > m0;
    })();

    // gang turf: walk into a zone, clear it, confirm capture
    (function () {
      flatGrid();
      var z = W.zones[0]; W.player.inCar = false; W.player.x = z.x; W.player.z = z.z; W.wanted = 0;
      eng.step(S, {}); // triggers aggro + spawns a gang wave
      var spawned = W.peds.filter(function (p) { return p.gang === z.id && p.alive; }).length;
      for (var i = 0; i < W.peds.length; i++) if (W.peds[i].gang === z.id) W.peds[i].hp = 0, IN.killPed(W.peds[i], true);
      for (var k = 0; k < 5; k++) { W.player.x = z.x; W.player.z = z.z; eng.step(S, {}); }
      r.gangSpawned = spawned > 0;
      r.gangCaptured = z.owned === true;
    })();

    // heli at 4 stars (live)
    (function () {
      W.player.inCar = false; W.wanted = 4; W.lkpValid = true; W.lkpX = W.player.x; W.lkpZ = W.player.z;
      for (var k = 0; k < 600 && W.helis.length === 0; k++) { W.wanted = 4; W.lkpX = W.player.x; W.lkpZ = W.player.z; W.player.hp = W.player.maxHp; eng.step(S, {}); }
      r.heli = W.helis.length > 0;
    })();

    // day/night + weather actually move
    (function () {
      var t0 = W.timeOfDay; for (var k = 0; k < 120; k++) eng.step(S, {});
      r.dayNightMoves = Math.abs(W.timeOfDay - t0) > 0;
    })();

    return r;
  });

  out.ok = out.errs.length === 0 && Object.keys(out.steps).every(function (k) {
    var v = out.steps[k]; return (typeof v === 'number') ? v > 0 : v === true;
  });
  require('fs').writeFileSync('/tmp/playtest.json', JSON.stringify(out, null, 1));
  console.log((out.ok ? 'PLAYTEST_OK ' : 'PLAYTEST_FAIL ') + JSON.stringify(out.steps) + ' errs=' + out.errs.length);
  await browser.close();
  process.exit(out.ok ? 0 : 1);
})();
