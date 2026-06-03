/* REAL browser boot-test for the 3D build.
 * Launches the user's installed Chrome (headless, WebGL via SwiftShader), loads
 * game3d.html from file://, and verifies it actually runs: Three.js + the engine
 * load, no JS/console errors, the render loop steps the engine (proven by the
 * hint overlay auto-hiding after >0.5s of sim time), the WebGL canvas has a live
 * context, and the engine advances world.time. Saves a screenshot to eyeball.
 *
 * This is the part headless Node tests can't cover. It does NOT verify "feel"
 * (that needs a human at the controls) — it verifies the thing boots and renders.
 */
'use strict';
var puppeteer = require('puppeteer-core');
var path = require('path');
var fs = require('fs');

var CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
var PAGE = 'file://' + path.resolve(__dirname, '..', 'game3d.html');
var SHOT = path.resolve(__dirname, '..', 'boot3d.png');

(async function () {
  var out = { ok: false, steps: {}, consoleErrors: [], pageErrors: [] };
  var browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: [
        '--enable-unsafe-swiftshader',     // software WebGL in headless
        '--use-gl=angle', '--use-angle=swiftshader',
        '--no-sandbox', '--disable-dev-shm-usage',
        '--window-size=1280,800'
      ]
    });
    var page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    page.on('console', function (m) { if (m.type() === 'error') out.consoleErrors.push(m.text()); });
    page.on('pageerror', function (e) { out.pageErrors.push(String(e && e.message || e)); });
    page.on('requestfailed', function (r) {
      var u = r.url();
      if (/three/i.test(u)) out.consoleErrors.push('THREE CDN request failed: ' + u);
    });

    await page.goto(PAGE, { waitUntil: 'load', timeout: 30000 });

    // globals present?
    var globals = await page.evaluate(function () {
      return { three: !!window.THREE, engine: !!window.GTA3D, err: (document.getElementById('err') || {}).style ? document.getElementById('err').style.display : 'n/a' };
    });
    out.steps.threeLoaded = globals.three;
    out.steps.engineLoaded = globals.engine;
    out.steps.errOverlayHidden = (globals.err !== 'flex');

    // dismiss the start menu (New Game), then let the render loop run real time
    await page.evaluate(function () { if (window.__startGame) window.__startGame(); });
    await new Promise(function (r) { setTimeout(r, 2500); });

    // proof the loop ran & stepped the sim: the menu hides on start AND world.time advanced
    var run = await page.evaluate(function () {
      var menu = document.getElementById('menu');
      var cv = document.getElementById('c');
      var gl = cv && (cv.getContext('webgl2') || cv.getContext('webgl'));
      return {
        menuHidden: menu ? getComputedStyle(menu).display === 'none' : true,
        worldTime: (window.__ENG && window.__ENG.world) ? window.__ENG.world.time : 0,
        canvasW: cv ? cv.width : 0,
        canvasH: cv ? cv.height : 0,
        hasGL: !!gl,
        glLost: gl ? gl.isContextLost() : true
      };
    });
    out.steps.renderLoopRan = run.menuHidden && run.worldTime > 0.5;  // menu dismissed + sim advanced
    out.steps.canvasSized = run.canvasW > 0 && run.canvasH > 0;
    out.steps.webglLive = run.hasGL && !run.glLost;

    await page.screenshot({ path: SHOT });
    out.steps.screenshot = fs.existsSync(SHOT);
    out.shot = SHOT;

    out.ok = out.steps.threeLoaded && out.steps.engineLoaded && out.steps.errOverlayHidden &&
             out.steps.renderLoopRan && out.steps.canvasSized && out.steps.webglLive &&
             out.consoleErrors.length === 0 && out.pageErrors.length === 0;
  } catch (e) {
    out.fatal = String(e && e.stack || e);
  } finally {
    if (browser) try { await browser.close(); } catch (e) {}
  }
  fs.writeFileSync('/tmp/browser3d.json', JSON.stringify(out, null, 1));
  console.log(out.ok ? 'BROWSER_BOOT_OK' : 'BROWSER_BOOT_FAIL');
  process.exit(out.ok ? 0 : 1);
})();
