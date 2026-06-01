/* Visual verification for the escalated police response (helicopter + SWAT) and a
 * burning car — states the normal screenshot harness can't reach because pointer-lock
 * (and thus a real wanted level) doesn't engage headless. We reach into the running
 * engine via window.__ENG, force the state, let it render, and save screenshots. */
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
  await new Promise(function (r) { setTimeout(r, 600); });

  // force a 4-star response and spawn a chopper + a SWAT foot officer next to the player
  var info = await page.evaluate(function () {
    var eng = window.__ENG; if (!eng) return { err: 'no __ENG' };
    var W = eng.world;
    W.player.inCar = false;
    W.wanted = 5; W.lkpValid = true; W.lkpX = W.player.x; W.lkpZ = W.player.z;
    // run enough steps for a heli to spawn and descend, plus a SWAT deploy.
    // god-mode the player each step so it survives the 5-star onslaught for the photo.
    for (var i = 0; i < 360; i++) { W.wanted = 5; W.lkpX = W.player.x; W.lkpZ = W.player.z; W.player.hp = W.player.maxHp; W.player.armor = 100; eng.step(1 / 60, {}); }
    // guarantee at least one SWAT on foot near the player for the shot
    if (!W.peds.some(function (p) { return p.cop && p.swat && p.alive; })) {
      W.peds.push({ kind: 'ped', x: W.player.x + 6, z: W.player.z + 4, yaw: 0, dir: 0, speed: 0, think: 1, hp: 130, alive: true,
        tough: false, hostile: false, panic: 0, stun: 0, launchVx: 0, launchVz: 0, witness: false, reportTimer: 0, reportLevel: 0,
        cop: true, swat: true, fireCd: 99, strafeSign: 1, strafeFlip: 99, color: 0x20242b, id: 91234 });
    }
    W.player.hp = W.player.maxHp;
    // point the camera UP toward a circling chopper so we can eyeball the mesh
    var h0 = W.helis[0];
    if (h0 && window.__setCam) window.__setCam(Math.atan2(h0.x - W.player.x, h0.z - W.player.z), -0.55);
    eng.step(1 / 60, {});
    return { helis: W.helis.length, swat: W.peds.filter(function (p) { return p.cop && p.swat && p.alive; }).length,
      heliY: W.helis[0] ? +W.helis[0].y.toFixed(1) : null, wanted: W.wanted, state: W.state };
  });

  await new Promise(function (r) { setTimeout(r, 400); });
  await page.screenshot({ path: path.join(DIR, 'shot-heli.png') });

  console.log('HELI_SHOT ' + JSON.stringify(info) + ' errs=' + errs.length);
  require('fs').writeFileSync('/tmp/helishot.json', JSON.stringify({ info: info, errs: errs }));
  await browser.close();
  process.exit(errs.length || info.err ? 1 : 0);
})();
