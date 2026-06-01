/* Headless simulation harness for GTA 7: JS.
 *
 * Stubs the canvas/2D context, instantiates the real game, drives it through
 * thousands of update+render ticks under realistic input (walking, driving,
 * shooting, earning a wanted level, dying & respawning), and asserts the whole
 * thing never throws and never leaves an invalid state. This exercises the same
 * code paths the browser would, minus pixels — so logic/runtime bugs surface
 * here instead of on screen.
 */
'use strict';

var assert = require('assert');
var GTA = require('../game.js');

/* --- Stub a 2D canvas context: every method is a no-op, props are settable. --- */
function makeStubCtx() {
  var noop = function () { return { width: 0, addColorStop: function () {} }; };
  var ctx = {};
  var methods = [
    'save', 'restore', 'translate', 'rotate', 'scale', 'beginPath', 'closePath',
    'moveTo', 'lineTo', 'arc', 'rect', 'fill', 'stroke', 'clip', 'fillRect',
    'strokeRect', 'clearRect', 'fillText', 'strokeText', 'setLineDash',
    'measureText', 'createLinearGradient', 'createRadialGradient', 'drawImage',
    'quadraticCurveTo', 'bezierCurveTo', 'ellipse', 'arcTo'
  ];
  methods.forEach(function (m) { ctx[m] = noop; });
  // settable style props are just left as plain assignments; no traps needed
  return ctx;
}

function makeStubCanvas(w, h) {
  var ctx = makeStubCtx();
  return {
    width: w, height: h,
    getContext: function () { return ctx; },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: w, height: h }; },
    addEventListener: function () {},
    removeEventListener: function () {}
  };
}

/* --- Invariant checks run after every tick --- */
function finite(v) { return typeof v === 'number' && isFinite(v); }

function checkInvariants(api, tickInfo) {
  var g = api.game;
  var ctx = '[tick ' + tickInfo.i + ' phase ' + tickInfo.phase + '] ';

  assert.ok(['menu', 'play', 'wasted'].indexOf(g.state) >= 0, ctx + 'bad state: ' + g.state);

  if (g.player) {
    assert.ok(finite(g.player.x) && finite(g.player.y), ctx + 'player pos not finite');
    assert.ok(finite(g.player.angle), ctx + 'player angle not finite');
    assert.ok(g.player.hp >= 0 && g.player.hp <= 100, ctx + 'player hp out of range: ' + g.player.hp);
    // player must stay within the world
    assert.ok(g.player.x >= -1 && g.player.x <= 56 * 56 + 1, ctx + 'player x oob: ' + g.player.x);
    assert.ok(g.player.y >= -1 && g.player.y <= 56 * 56 + 1, ctx + 'player y oob: ' + g.player.y);
  }

  assert.ok(g.wanted >= 0 && g.wanted <= 5, ctx + 'wanted out of range: ' + g.wanted);
  assert.ok(g.money >= 0, ctx + 'money negative: ' + g.money);

  // dual protagonists exist once play has started (not during the menu)
  if (g.player) {
    assert.ok(g.chars && g.chars.length === 2, ctx + 'expected 2 protagonists');
    for (var c = 0; c < g.chars.length; c++) {
      assert.ok(finite(g.chars[c].x) && finite(g.chars[c].y) && finite(g.chars[c].hp),
        ctx + 'char ' + c + ' has non-finite field');
      assert.ok(g.chars[c].hp >= 0 && g.chars[c].hp <= 100, ctx + 'char ' + c + ' hp oob: ' + g.chars[c].hp);
    }
    assert.strictEqual(g.player, g.chars[g.active], ctx + 'player must be the active protagonist');
  }
  // law-system fields finite
  assert.ok(finite(g.lkpX) && finite(g.lkpY) && finite(g.searchTimer), ctx + 'law fields non-finite');
  // social feed bounded
  assert.ok(g.feed.length <= 8, ctx + 'feed leak: ' + g.feed.length);

  // entity collections must not explode (leak) or contain bad data
  assert.ok(g.bullets.length < 5000, ctx + 'bullet leak: ' + g.bullets.length);
  assert.ok(g.particles.length < 8000, ctx + 'particle leak: ' + g.particles.length);
  assert.ok(g.police.length <= 12, ctx + 'too many police: ' + g.police.length);

  var i;
  for (i = 0; i < g.cars.length; i++) {
    assert.ok(finite(g.cars[i].x) && finite(g.cars[i].y) && finite(g.cars[i].angle) && finite(g.cars[i].speed),
      ctx + 'car ' + i + ' has non-finite field');
  }
  for (i = 0; i < g.bullets.length; i++) {
    assert.ok(finite(g.bullets[i].x) && finite(g.bullets[i].y), ctx + 'bullet ' + i + ' pos not finite');
  }
  for (i = 0; i < g.police.length; i++) {
    assert.ok(finite(g.police[i].x) && finite(g.police[i].y), ctx + 'police ' + i + ' pos not finite');
  }
  for (i = 0; i < g.peds.length; i++) {
    assert.ok(finite(g.peds[i].x) && finite(g.peds[i].y), ctx + 'ped ' + i + ' pos not finite');
  }
}

/* --- Drive the simulation --- */
function run() {
  var canvas = makeStubCanvas(960, 540);
  var api = GTA.createGame(canvas, {});
  var g = api.game;
  var STEP = 1 / 60;
  var SEARCH_GIVEUP = 8.0; // mirror of the game constant, for the evasion test

  var totalTicks = 0;
  function step(phase, n, before) {
    for (var i = 0; i < n; i++) {
      if (before) before(i);
      api.update(STEP);
      api.render();
      totalTicks++;
      checkInvariants(api, { i: totalTicks, phase: phase });
    }
  }

  // 1) Menu idle (no player yet): must render & update without throwing.
  step('menu', 120);
  assert.strictEqual(g.player, null, 'player should not exist in menu');

  // 2) Start the game.
  api.startPlay();
  assert.strictEqual(g.state, 'play', 'should be playing');
  assert.ok(g.player, 'player should exist after start');
  var startCars = g.cars.length;
  assert.ok(startCars > 0, 'cars should be populated');
  assert.ok(g.peds.length > 0, 'peds should be populated');

  // 3) Walk around on foot in all directions, aiming the mouse.
  var dirs = ['KeyW', 'KeyD', 'KeyS', 'KeyA'];
  for (var d = 0; d < dirs.length; d++) {
    g.keys = {}; g.keys[dirs[d]] = true;
    g.mouse.x = (d % 2) * 960; g.mouse.y = (d % 3) * 270;
    step('walk-' + dirs[d], 60);
  }
  g.keys = {};

  // 4) Shoot on foot in view of a witness. Per the GTA-accurate witness model,
  //    heat only rises after a bystander who SAW it reports — not instantly.
  var w4 = g.peds[0];
  w4.x = g.player.x; w4.y = g.player.y; w4.alive = true; w4.witness = false; // co-located => LOS guaranteed
  g.wanted = 0;
  g.mouse.down = true;
  g.mouse.x = g.player.x - 5000; g.mouse.y = g.player.y; // fire away from the witness
  step('shoot-foot', Math.ceil(4 / STEP)); // > REPORT_DELAY so the report lands
  g.mouse.down = false;
  assert.ok(g.wanted >= 1, 'witnessed gunfire should raise wanted (was ' + g.wanted + ')');

  // 5) Walk over to a car (enter reach is small), then drive hard into the city.
  var target = g.cars[0];
  g.player.x = target.x + 20; // within enter reach of that car
  g.player.y = target.y;
  api._internal.tryEnterExit();
  assert.ok(g.player.inCar, 'player should be in a car after enter');
  assert.ok(g.playerCar, 'playerCar should be set');

  // floor it forward + steering, repeatedly slamming geometry
  for (var seg = 0; seg < 8; seg++) {
    g.keys = {}; g.keys['KeyW'] = true;
    if (seg % 2 === 0) g.keys['KeyD'] = true; else g.keys['KeyA'] = true;
    step('drive-' + seg, 80);
  }
  // reverse
  g.keys = {}; g.keys['KeyS'] = true;
  step('reverse', 80);

  // 6) Drive-by shooting while moving.
  g.keys = {}; g.keys['KeyW'] = true;
  g.mouse.down = true; g.mouse.x = 200; g.mouse.y = 100;
  step('driveby', 120);
  g.mouse.down = false;

  // 7) Exit the car. (Guard against the rare case where the player died to police
  //    during the drive-by and respawned on foot — re-enter a car first.)
  g.keys = {};
  if (!g.player.inCar) {
    var rc = g.cars[0];
    g.player.x = rc.x + 20; g.player.y = rc.y;
    api._internal.tryEnterExit();
  }
  if (g.player.inCar) api._internal.tryEnterExit();
  assert.ok(!g.player.inCar, 'player should be out of the car after exit');

  // 8) Crank the wanted level to the max and let police engage for a while.
  var addWanted = null;
  // raise heat by repeatedly shooting + running peds; just shoot a lot
  g.mouse.down = true;
  for (var w = 0; w < 8; w++) { g.mouse.x = (w * 137) % 960; step('heat-' + w, 60); }
  g.mouse.down = false;
  step('police-engage', 600); // let cops spawn, chase, shoot, get destroyed
  assert.ok(g.police.length <= 12, 'police count sane: ' + g.police.length);

  // 9) Force death: drain HP and confirm WASTED -> respawn cycle works.
  g.player.hp = 1;
  g.player.hp = 0;
  // trigger the wasted path through the damage handler
  // (simulate a police bullet finishing the job)
  api.game.player.hp = 5;
  // run with heavy police fire; also directly drop hp to ensure wasted triggers
  var sawWasted = false, sawRespawn = false;
  for (var t = 0; t < 400; t++) {
    if (g.state === 'play') { g.player.hp = Math.max(0, g.player.hp - 1); }
    api.update(STEP); api.render(); totalTicks++;
    checkInvariants(api, { i: totalTicks, phase: 'death-cycle' });
    if (g.state === 'wasted') sawWasted = true;
    if (sawWasted && g.state === 'play') { sawRespawn = true; break; }
  }
  assert.ok(sawWasted, 'should have entered WASTED state');
  assert.ok(sawRespawn, 'should have respawned back into play');
  assert.ok(g.player.hp > 0, 'player should have hp after respawn: ' + g.player.hp);

  // 9b) GTA6-systems coverage: verbs, witnesses/LOS, character swap, heist, water.
  // restart cleanly into play for deterministic system tests
  api = GTA.createGame(makeStubCanvas(960, 540), {});
  g = api.game;
  api.startPlay();
  assert.ok(g.chars.length === 2, 'two protagonists after start');
  var jason = g.chars[0], lucia = g.chars[1];

  // line-of-sight helper sanity: a point has LOS to itself
  assert.strictEqual(api._internal.lineOfSight(g.player.x, g.player.y, g.player.x, g.player.y), true,
    'LOS to self should be true');

  // verbs beyond violence: place a ped next to the active char and rob/greet it
  var victim = g.peds[0];
  victim.x = g.player.x + 20; victim.y = g.player.y; victim.alive = true; victim.robbedCd = 0;
  var moneyBefore = g.money;
  api._internal.robNearestPed();
  assert.ok(g.money >= moneyBefore, 'robbing should not lose money');
  victim.x = g.player.x + 20; victim.y = g.player.y; victim.robbedCd = 0;
  api._internal.greetNearestPed();
  api._internal.antagonizeNearestPed();
  step('verbs', 20);

  // witness system: a crime with a witness in LOS should eventually raise wanted
  g.wanted = 0; g.lkpValid = false;
  var witness = g.peds[1];
  witness.x = g.player.x; witness.y = g.player.y; witness.alive = true; witness.witness = false; // co-located => LOS guaranteed
  api._internal.commitCrime(2, g.player.x, g.player.y);
  assert.ok(witness.witness === true, 'a ped in range+LOS should become a witness');
  step('witness-report', Math.ceil(4 / STEP)); // let the report timer elapse
  assert.ok(g.wanted >= 1, 'an un-silenced witness should raise wanted (got ' + g.wanted + ')');

  // evasion: simulate perfect hiding (no cop ever gets eyes on us) -> heat decays.
  // (clear police every tick so a freshly-spawned unit can't re-spot us)
  g.seen = false;
  var wBefore = g.wanted;
  step('evade', Math.ceil((SEARCH_GIVEUP + 1.5) / STEP), function () {
    g.police.length = 0; g.seen = false;                 // perfect hiding: no cop ever sees us
    g.lkpX = g.player.x; g.lkpY = g.player.y; g.lkpValid = true; // search our spot => spawns stay > sight away
    for (var wi = 0; wi < g.peds.length; wi++) g.peds[wi].witness = false; // no pending reports
  });
  assert.ok(g.wanted < wBefore || wBefore === 0, 'hiding should shed heat (was ' + wBefore + ', now ' + g.wanted + ')');

  // dual-protagonist switch
  var activeBefore = g.active;
  api._internal.switchChar();
  assert.strictEqual(g.active, 1 - activeBefore, 'switchChar should flip active protagonist');
  assert.strictEqual(g.player, g.chars[g.active], 'player should track active protagonist');
  step('post-switch', 30);

  // water hazard: standing in deep water should drain HP
  var waterTile = null;
  for (var ty = 0; ty < 56 && !waterTile; ty++) {
    for (var tx = 0; tx < 56; tx++) {
      if (api._internal.tileTypeAt(tx * 56 + 28, ty * 56 + 28) === 3) { waterTile = { x: tx * 56 + 28, y: ty * 56 + 28 }; break; }
    }
  }
  if (waterTile) {
    g.player.inCar = false; g.playerCar = null;
    g.player.x = waterTile.x; g.player.y = waterTile.y; g.player.hp = 100;
    var hpBeforeWater = g.player.hp;
    g.keys = {}; // stand still in the water
    step('drown', 40);
    assert.ok(g.player.hp < hpBeforeWater, 'deep water should hurt the player (hp ' + g.player.hp + ')');
  }

  // heist: rob the bank, confirm the escape state + alert
  if (g.heist) {
    g.heist.state = 'ready'; g.heist.cooldown = 0;
    g.player.inCar = false; g.playerCar = null;
    g.player.x = g.heist.x; g.player.y = g.heist.y; g.player.hp = 100;
    var robbed = api._internal.tryHeist();
    assert.ok(robbed === true, 'tryHeist should succeed when standing on the bank');
    assert.strictEqual(g.heist.state, 'escaping', 'heist should enter escaping state');
    assert.ok(g.wanted >= 3, 'bank job should trigger a 3-star alert (got ' + g.wanted + ')');
    step('heist-escape', 120);
  }

  // 10) Long soak: random inputs for many ticks to flush out edge cases.
  var seed = 12345;
  function lcg() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  for (var s = 0; s < 3000; s++) {
    if (s % 23 === 0) {
      g.keys = {};
      if (lcg() < 0.7) g.keys['KeyW'] = true;
      if (lcg() < 0.4) g.keys['KeyA'] = true;
      if (lcg() < 0.4) g.keys['KeyD'] = true;
      if (lcg() < 0.2) g.keys['KeyS'] = true;
      g.mouse.down = lcg() < 0.5;
      g.mouse.x = lcg() * 960; g.mouse.y = lcg() * 540;
      if (lcg() < 0.05) api._internal.tryEnterExit();
    }
    api.update(STEP); api.render(); totalTicks++;
    checkInvariants(api, { i: totalTicks, phase: 'soak' });
  }

  // 11) Tiny + huge dt robustness.
  api.update(0);
  api.update(0.25);
  api.update(1.0); // clamped internally only in frame(); update should still be finite
  checkInvariants(api, { i: ++totalTicks, phase: 'dt-extremes' });

  console.log('PASS — ' + totalTicks + ' ticks simulated with no errors.');
  console.log('  final: state=' + g.state + ' hp=' + (g.player ? g.player.hp : 'n/a') +
              ' money=$' + g.money + ' wanted=' + g.wanted +
              ' kills=' + g.kills + ' cars=' + g.cars.length +
              ' peds=' + g.peds.length + ' police=' + g.police.length +
              ' bullets=' + g.bullets.length + ' particles=' + g.particles.length);
}

try {
  run();
  process.exit(0);
} catch (e) {
  console.error('FAIL — ' + (e && e.message ? e.message : e));
  console.error(e && e.stack ? e.stack : '');
  process.exit(1);
}
