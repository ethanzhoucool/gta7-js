/* Mobile touch test: emulates a touch phone in headless Chrome, loads game3d.html,
 * and verifies the touch HUD appears and that synthesized touches drive the SAME
 * input the engine reads (movement keys, look yaw, fire/aim/action edges). */
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
           '--no-sandbox', '--disable-dev-shm-usage', '--window-size=412,915', '--touch-events=enabled']
  });
  var page = await browser.newPage();
  // emulate a phone (touch + portrait)
  await page.emulate({
    viewport: { width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile'
  });
  page.on('console', function (m) { if (m.type() === 'error') out.errs.push('console: ' + m.text()); });
  page.on('pageerror', function (e) { out.errs.push('page: ' + String(e.message || e)); });
  await page.goto(PAGE, { waitUntil: 'load', timeout: 30000 });
  await new Promise(function (r) { setTimeout(r, 800); });

  // 1) touch HUD is shown and pointer-lock was bypassed (locked forced true)
  out.steps.touchHudVisible = await page.evaluate(function () {
    return document.body.classList.contains('touch') &&
      getComputedStyle(document.getElementById('touchUI')).display === 'block' &&
      !!document.querySelector('#tFire');
  });

  // helper: dispatch a touch sequence at CSS coords
  async function touchSeq(id, pts) {
    await page.evaluate(function (id, pts) {
      function mk(type, list) {
        var touches = list.map(function (p) {
          return new Touch({ identifier: id, target: document.getElementById('touchUI') || document.body, clientX: p.x, clientY: p.y });
        });
        var ev = new TouchEvent(type, { bubbles: true, cancelable: true, touches: touches, changedTouches: touches, targetTouches: touches });
        (document.getElementById('touchUI') || document.body).dispatchEvent(ev);
      }
      mk('touchstart', [pts[0]]);
      for (var i = 1; i < pts.length; i++) mk('touchmove', [pts[i]]);
      mk('touchend', [pts[pts.length - 1]]);
    }, id, pts);
  }

  // 2) left-half drag (move stick) pushed UP → the touch handler sets the FORWARD key.
  out.steps.moveStickSetsForward = await page.evaluate(function () {
    var TUI = document.getElementById('touchUI');
    function mk(type, x, y) { var t = new Touch({ identifier: 1, target: TUI, clientX: x, clientY: y }); TUI.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: [t], changedTouches: [t], targetTouches: [t] })); }
    mk('touchstart', 100, 760); mk('touchmove', 100, 560); // lower-left, pushed up = forward
    var fwd = window.__probe().keys['KeyW'] === true;
    mk('touchend', 100, 560);
    return fwd;
  });

  // 3) right-half drag → camera yaw changes (look), via the touch handler only
  out.steps.lookTurnsCamera = await page.evaluate(function () {
    var TUI = document.getElementById('touchUI'); var y0 = window.__probe().camYaw;
    function mk(type, x, y) { var t = new Touch({ identifier: 3, target: TUI, clientX: x, clientY: y }); TUI.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: [t], changedTouches: [t], targetTouches: [t] })); }
    mk('touchstart', 320, 400); mk('touchmove', 360, 400); mk('touchmove', 410, 400); // drag right
    var moved = Math.abs(window.__probe().camYaw - y0) > 0.001;
    mk('touchend', 410, 400);
    return moved;
  });

  // 4) hold FIRE button → touch handler sets mouseDown, and a bullet spawns through buildInput()
  out.steps.fire = await page.evaluate(function () {
    var W = window.__ENG.world; W.bullets.length = 0; W.player.inCar = false; W.fireCd = 0;
    var b = document.getElementById('tFire').getBoundingClientRect();
    var TUI = document.getElementById('touchUI');
    function mk(type, x, y) { var t = new Touch({ identifier: 2, target: TUI, clientX: x, clientY: y }); TUI.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: [t], changedTouches: [t], targetTouches: [t] })); }
    mk('touchstart', b.left + b.width / 2, b.top + b.height / 2); // hold fire -> sets mouseDown
    var down = window.__probe().mouseDown === true;
    // deterministically push touch input through buildInput()+step(). Reset W.fireCd
    // before each step so a competing rAF frame()'s cooldown can't starve all our shots.
    var got = 0;
    for (var i = 0; i < 12 && got === 0; i++) { W.fireCd = 0; window.__stepWithInput(); got = W.bullets.filter(function (x) { return x.team === 'player'; }).length; }
    mk('touchend', b.left + b.width / 2, b.top + b.height / 2);
    return down && got > 0;
  });

  // 5) ENTER button sets the carjack edge
  out.steps.enterEdge = await page.evaluate(function () {
    var b = document.getElementById('tEnter').getBoundingClientRect();
    var TUI = document.getElementById('touchUI');
    function mk(type, x, y) { var t = new Touch({ identifier: 5, target: TUI, clientX: x, clientY: y }); TUI.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: [t], changedTouches: [t], targetTouches: [t] })); }
    mk('touchstart', b.left + b.width / 2, b.top + b.height / 2);
    var set = window.__probe().justF === true;
    mk('touchend', b.left + b.width / 2, b.top + b.height / 2);
    return set;
  });

  await browser.close();
  out.ok = out.errs.length === 0 && out.steps.touchHudVisible === true &&
    out.steps.moveStickSetsForward === true && out.steps.lookTurnsCamera === true &&
    out.steps.fire === true && out.steps.enterEdge === true;
  require('fs').writeFileSync('/tmp/mobile.json', JSON.stringify(out, null, 1));
  console.log((out.ok ? 'MOBILE_OK ' : 'MOBILE_FAIL ') + JSON.stringify(out.steps) + ' errs=' + out.errs.length);
  process.exit(out.ok ? 0 : 1);
})();
