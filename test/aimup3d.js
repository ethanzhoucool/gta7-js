/* Regression test for vertical aiming in the REAL renderer (not just the engine).
 * The old third-person rig always looked DOWN at the player, so the screen-center aim
 * ray could never point up and you couldn't aim at a chopper overhead. This boots the
 * actual game in headless Chrome, raises the look pitch, and asserts solveAim() now
 * produces a genuine upward firing pitch — and that a heli overhead can be locked. */
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
  page.on('pageerror', function (e) { out.errs.push('page: ' + String(e.message || e)); });
  page.on('console', function (m) { if (m.type() === 'error') out.errs.push('console: ' + m.text()); });
  await page.goto(PAGE, { waitUntil: 'load', timeout: 30000 });
  await new Promise(function (r) { setTimeout(r, 700); });

  // helper: deterministically aim + converge the camera + solve (no rAF-timing race)
  async function aimSolve(yaw, pitch) {
    return await page.evaluate(function (y, p) { return window.__aimSolve(y, p); }, yaw, pitch);
  }

  // 1) looking UP must yield a positive firing pitch (the old rig clamped this to ~0)
  var up = await aimSolve(0, 0.6);
  out.steps.looksUp = up.pitch > 0.4;
  var upMore = await aimSolve(0, 1.0);
  out.steps.looksUpMore = upMore.pitch > 0.8;
  // 2) looking roughly level keeps fire flat (ground combat unchanged)
  var lvl = await aimSolve(0, -0.18);
  out.steps.levelStaysFlat = Math.abs(lvl.pitch) < 0.35;
  out.raw = { up: up.pitch, upMore: upMore.pitch, lvl: lvl.pitch };

  // 3) end-to-end: spawn a chopper overhead, aim up at it, and confirm bullets damage it
  out.steps.heliTakesDamage = await page.evaluate(function () {
    var eng = window.__ENG, W = eng.world, C = eng.constants;
    // flatten to an all-road grid + clear peds so bullets aren't eaten by buildings/water
    for (var z = 0; z < C.MAP; z++) for (var x = 0; x < C.MAP; x++) W.grid[z][x] = C.T_ROAD;
    for (var pi = 0; pi < W.peds.length; pi++) W.peds[pi].alive = false;
    var ax = 560, az = 700;   // clearly on the SF landmass
    W.player.inCar = false; W.player.x = ax; W.player.z = az; W.wanted = 4; W.lkpValid = true; W.lkpX = ax; W.lkpZ = az;
    for (var i = 0; i < 600 && W.helis.length === 0; i++) { W.player.x = ax; W.player.z = az; W.wanted = 4; eng.step(1 / 60, {}); }
    if (!W.helis.length) return false;
    var hp0 = W.helis[0].hp;
    // fire straight at the chopper using the engine's own muzzle math (renderer solve is
    // covered by steps 1–2). Pin it overhead and shred it with a pitched-up SMG burst.
    W.player.weapon = 'smg'; W.player.weapons.smg = true; W.player.ammo = 999999;
    var hz = az + 34, hy = 24, yaw = Math.atan2(0, hz - az), pitch = Math.atan2(hy - 1.1, hz - az);
    for (var j = 0; j < 200 && W.helis.length; j++) {
      W.player.x = ax; W.player.z = az; if (W.helis[0]) { W.helis[0].x = ax; W.helis[0].z = hz; W.helis[0].y = hy; }
      W.fireCd = 0; eng.step(1 / 60, { shoot: true, aimYaw: yaw, aimPitch: pitch });
    }
    return W.helis.length === 0 || W.helis[0].hp < hp0;
  });

  await browser.close();
  out.ok = out.errs.length === 0 && out.steps.looksUp && out.steps.looksUpMore &&
    out.steps.levelStaysFlat && out.steps.heliTakesDamage;
  require('fs').writeFileSync('/tmp/aimup.json', JSON.stringify(out, null, 1));
  console.log((out.ok ? 'AIMUP_OK ' : 'AIMUP_FAIL ') + JSON.stringify(out.steps) + ' errs=' + out.errs.length);
  if (!out.ok && out.errs.length) console.log(JSON.stringify(out.errs.slice(0, 4)));
  process.exit(out.ok ? 0 : 1);
})();
