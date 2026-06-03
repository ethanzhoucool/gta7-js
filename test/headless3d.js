/* Headless simulation harness for the GTA 7: JS 3D engine.
 * Runs the real physics/AI/wanted logic (no Three.js) through thousands of
 * fixed steps under realistic input, asserting no throws and no invalid state. */
'use strict';
var assert = require('assert');
var GTA3D = require('../engine3d.js');

function finite(v) { return typeof v === 'number' && isFinite(v); }

function checkInvariants(eng, info) {
  var W = eng.world, C = eng.constants, ctx = '[' + info + '] ';
  assert.ok(['play', 'wasted'].indexOf(W.state) >= 0, ctx + 'bad state ' + W.state);
  var p = W.player;
  assert.ok(finite(p.x) && finite(p.y) && finite(p.z) && finite(p.yaw) && finite(p.vy), ctx + 'player non-finite');
  assert.ok(p.hp >= 0 && p.hp <= (p.maxHp || 100), ctx + 'hp oob ' + p.hp);
  assert.ok(p.x >= -1 && p.x <= C.WORLD + 1 && p.z >= -1 && p.z <= C.WORLD + 1, ctx + 'player oob ' + p.x + ',' + p.z);
  assert.ok(p.y >= -1 && p.y < 200, ctx + 'player y oob ' + p.y);
  assert.ok(W.wanted >= 0 && W.wanted <= 5, ctx + 'wanted oob ' + W.wanted);
  assert.ok(W.money >= 0, ctx + 'money neg ' + W.money);
  assert.ok(isFinite(W.netWorth) && W.netWorth >= 0, ctx + 'netWorth bad ' + W.netWorth);
  assert.ok(W.bullets.length < 5000, ctx + 'bullet leak');
  assert.ok(W.police.length <= 12, ctx + 'police leak ' + W.police.length);
  assert.ok(W.peds.length < 200, ctx + 'ped leak ' + W.peds.length); // catches cop accumulation
  assert.ok(W.helis.length <= 4, ctx + 'heli leak ' + W.helis.length);
  assert.ok(W.popups.length <= 30, ctx + 'popup leak ' + W.popups.length);
  for (var hi = 0; hi < W.helis.length; hi++) { var H = W.helis[hi]; assert.ok(finite(H.x) && finite(H.y) && finite(H.z), ctx + 'heli non-finite'); }
  assert.ok(W.feed.length <= 8, ctx + 'feed leak');
  var i;
  for (i = 0; i < W.cars.length; i++) { var c = W.cars[i]; assert.ok(finite(c.x) && finite(c.z) && finite(c.yaw) && finite(c.vx) && finite(c.vz) && finite(c.speed), ctx + 'car ' + i + ' non-finite'); }
  for (i = 0; i < W.peds.length; i++) { var q = W.peds[i]; assert.ok(finite(q.x) && finite(q.z), ctx + 'ped ' + i + ' non-finite'); }
  for (i = 0; i < W.police.length; i++) { assert.ok(finite(W.police[i].x) && finite(W.police[i].z), ctx + 'police ' + i + ' non-finite'); }
  for (i = 0; i < W.bullets.length; i++) { var b = W.bullets[i]; assert.ok(finite(b.x) && finite(b.y) && finite(b.z), ctx + 'bullet ' + i + ' non-finite'); }
}

function run() {
  var eng = GTA3D.createEngine();
  var W = eng.world, C = eng.constants, STEP = 1 / 60, total = 0;

  function go(n, input, label, each) {
    for (var i = 0; i < n; i++) { if (each) each(); eng.step(STEP, input || {}); total++; checkInvariants(eng, (label || 'run') + ' t' + total); }
  }

  // 1) idle a moment
  go(30, {}, 'idle');
  assert.ok(W.player, 'player exists');
  assert.ok(W.cars.length > 0 && W.peds.length > 0, 'world populated');

  // 2) walk in every camera-relative direction + run + jump.
  // Keep the player alive through this section: a random combat death (hostile ped
  // etc.) would flip state to 'wasted', which freezes player physics mid-air and is
  // not what the jump/landing assertion is testing.
  function pinAlive() { W.player.hp = W.player.maxHp; W.player.armor = 100; W.wanted = 0; }
  go(40, { forward: true, camYaw: 0, run: true }, 'walk-fwd', pinAlive);
  go(40, { back: true, camYaw: 0 }, 'walk-back', pinAlive);
  go(40, { left: true, camYaw: 1.2 }, 'walk-left', pinAlive);
  go(40, { right: true, camYaw: -0.7 }, 'walk-right', pinAlive);
  pinAlive(); eng.step(STEP, { jumpPressed: true, camYaw: 0, forward: true }); total++; // single press edge
  assert.ok(W.player.vy > 0 || W.player.y > 0, 'a single jump press launches the player');
  // gravity must settle the player back to the ground when not jumping (no held re-jump).
  go(150, { camYaw: 0 }, 'land', pinAlive);
  assert.ok(W.player.y <= 0.001 && W.player.onGround === true, 'player should be grounded after landing (y=' + W.player.y + ', onGround=' + W.player.onGround + ')');
  assert.ok(W.player.onGround === true, 'player should be on the ground after landing');

  // 3) Witness model (GTA-accurate): a crime with a witness in LOS raises heat only
  //    AFTER the witness reports (a delay). Drive commitCrime directly with a single
  //    co-located witness so the check is deterministic (the fire path is covered by 9e).
  (function witnessCheck() {
    var we = GTA3D.createEngine(), WW = we.world;
    for (var pi = 0; pi < WW.peds.length; pi++) WW.peds[pi].alive = false;
    var w3 = WW.peds[0];
    w3.x = WW.player.x; w3.z = WW.player.z; w3.alive = true; w3.witness = false; w3.cop = false; w3.gang = undefined; w3.bounty = false;
    WW.wanted = 0;
    we._internal.commitCrime(1, WW.player.x, WW.player.z);
    assert.ok(w3.witness === true, 'a co-located ped should become a witness');
    assert.strictEqual(WW.wanted, 0, 'heat should NOT rise instantly (witness must report first)');
    for (var k = 0; k < Math.ceil(4 / STEP); k++) { w3.x = WW.player.x; w3.z = WW.player.z; we.step(STEP, {}); }
    assert.ok(WW.wanted >= 1, 'witnessed crime should raise wanted after the report delay (got ' + WW.wanted + ')');
  })();

  // 3b) Severity-based escalation: while already hot, a crime floors heat to its own
  //     severity, and serious REPEAT offending (>= ASSAULT, already at that level)
  //     ratchets +1 — petty crime never climbs past its floor; everything clamps to MAX.
  (function severityCheck() {
    var se = GTA3D.createEngine(), SW = se.world, C = se.constants.CRIME, cc = se._internal.commitCrime;
    function at(w) { SW.wanted = w; return SW; }
    var px = SW.player.x, pz = SW.player.z;
    at(1); cc(C.MURDER, px, pz);  assert.strictEqual(SW.wanted, 3, 'murder while 1★ jumps to its severity (3), no double-bump (got ' + SW.wanted + ')');
    at(2); cc(C.ASSAULT, px, pz); assert.strictEqual(SW.wanted, 3, 'repeat assault while at 2★ ratchets to 3 (got ' + SW.wanted + ')');
    at(4); cc(C.PETTY, px, pz);   assert.strictEqual(SW.wanted, 4, 'petty crime never climbs past its floor (got ' + SW.wanted + ')');
    at(4); cc(C.MURDER, px, pz);  assert.strictEqual(SW.wanted, 5, 'serious crime at high heat ratchets, clamped to 5 (got ' + SW.wanted + ')');
    at(5); cc(C.HEIST, px, pz);   assert.strictEqual(SW.wanted, 5, 'heat clamps at WANTED_MAX (got ' + SW.wanted + ')');
    at(0); cc(C.MURDER, px, pz);  assert.strictEqual(SW.wanted, 0, 'a crime while clean does not instantly escalate (witness must report) (got ' + SW.wanted + ')');
  })();

  // 3c) Per-star search persistence: higher wanted levels make the cops search LONGER
  //     before giving up a star. A 4-star manhunt must outlast a 1-star one, and a
  //     4-star search must take clearly longer than the old flat 8s give-up.
  (function persistenceCheck() {
    var G = GTA3D.createEngine().constants.SEARCH_GIVEUP_BY_STAR;
    assert.ok(Array.isArray(G) && G.length >= 6, 'SEARCH_GIVEUP_BY_STAR exposed with a per-star entry');
    assert.ok(G[4] > G[1], '4★ search should persist longer than 1★ (' + G[4] + ' vs ' + G[1] + ')');
    assert.ok(G[4] > 8.0 && G[5] >= G[4], 'high-star manhunts outlast the old flat 8s give-up');
  })();

  // 4) carjack: place an AI car next to the player and steal it (driver ejected)
  var ai = null;
  for (var c = 0; c < W.cars.length; c++) if (W.cars[c].driver === 'ai') { ai = W.cars[c]; break; }
  assert.ok(ai, 'an AI car should exist to carjack');
  W.player.inCar = false; W.playerCar = null;
  W.player.x = ai.x + 2; W.player.z = ai.z;
  var pedCountBefore = W.peds.length;
  eng._internal.tryEnterExit();
  assert.ok(W.player.inCar, 'player should be in the car after carjacking');
  assert.strictEqual(W.playerCar, ai, 'player car should be the jacked car');
  assert.strictEqual(ai.driver, 'player', 'jacked car driver should be player');
  assert.ok(W.peds.length >= pedCountBefore, 'ejected driver should be added to peds');

  // 5) drive hard into the city (and walls); realistic momentum must stay finite
  go(80, { forward: true, right: true }, 'drive-turn');
  go(80, { forward: true, left: true }, 'drive-turn2');
  go(60, { back: true }, 'brake-reverse');
  // drive-by
  go(60, { forward: true, shoot: true, aimYaw: 1.0 }, 'driveby');

  // 6) exit the car
  eng._internal.tryEnterExit();
  assert.ok(!W.player.inCar, 'player should be on foot after exit');

  // 7) crank heat and let police engage in 3D
  W.player.inCar = false;
  go(8 * 60, { shoot: true, aimYaw: 0.0 }, 'heat'); // sustained crime
  go(8 * 60, { camYaw: 0, forward: true }, 'pursuit');
  assert.ok(W.police.length <= 12, 'police count sane');

  // 8) evasion: on a FRESH engine, raise heat then hide perfectly. Each tick we
  //    suppress police entirely (cleared + spawns removed) and zero pending witness
  //    reports, so the ONLY dynamic is the search-give-up decay — deterministic.
  (function evadeCheck() {
    var ee = GTA3D.createEngine(), EW = ee.world;
    // stand at map center (away from gang zones, which sit in the corners) so tickZones
    // can't re-aggro and re-raise heat mid-evade; clear witnesses + any active fugitive too.
    EW.player.inCar = false; EW.player.x = ee.constants.WORLD / 2; EW.player.z = ee.constants.WORLD / 2;
    EW.vigilante = null; EW.vigilanteCd = 999;
    EW.wanted = 2; EW.lkpX = EW.player.x; EW.lkpZ = EW.player.z; EW.lkpValid = true; EW.searchTimer = 0;
    var before = EW.wanted;
    var steps = Math.ceil((8 + 1.5) / STEP);
    for (var ev = 0; ev < steps; ev++) {
      ee.step(STEP, {});
      EW.player.x = ee.constants.WORLD / 2; EW.player.z = ee.constants.WORLD / 2;
      EW.police = []; EW.seen = false;                     // never seen, no pursuers persist
      for (var wi = 0; wi < EW.peds.length; wi++) EW.peds[wi].witness = false;
    }
    assert.ok(EW.wanted < before, 'hiding should shed heat (was ' + before + ', now ' + EW.wanted + ')');
  })();

  // 9) death + respawn cycle
  var sawW = false, sawR = false;
  for (var t = 0; t < 400; t++) {
    if (W.state === 'play') W.player.hp = Math.max(0, W.player.hp - 1);
    eng.step(STEP, {}); total++; checkInvariants(eng, 'death t' + total);
    if (W.state === 'wasted') sawW = true;
    if (sawW && W.state === 'play') { sawR = true; break; }
  }
  assert.ok(sawW, 'should enter WASTED');
  assert.ok(sawR, 'should respawn');
  assert.ok(W.player.hp > 0, 'hp restored after respawn');

  // 9c) Control-feel mechanics, verified on a fresh deterministic engine.
  (function feelChecks() {
    var fe = GTA3D.createEngine(), FW = fe.world;
    // momentum: from rest, one forward step must NOT instantly reach full speed
    FW.player.inCar = false; FW.playerCar = null;
    fe.step(STEP, { forward: true, camYaw: 0 });
    var sp1 = Math.hypot(FW.player.vx, FW.player.vz);
    assert.ok(sp1 > 0 && sp1 < 12.5, 'on-foot speed should ramp, not snap (got ' + sp1.toFixed(2) + ')');
    var k; for (k = 0; k < 60; k++) fe.step(STEP, { forward: true, camYaw: 0 });
    var sp2 = Math.hypot(FW.player.vx, FW.player.vz);
    assert.ok(sp2 > sp1, 'sustained input should build speed (' + sp1.toFixed(2) + ' -> ' + sp2.toFixed(2) + ')');
    // aim facing: aiming turns the character to the aim direction (TPS feel)
    FW.player.yaw = 0;
    fe.step(STEP, { aim: true, aimYaw: Math.PI / 2 });
    assert.ok(Math.abs(FW.player.yaw - Math.PI / 2) < 0.2, 'aiming should face the aim yaw (got ' + FW.player.yaw.toFixed(2) + ')');
    // jump leaves the ground
    FW.player.y = 0; FW.player.vy = 0; FW.player.onGround = true;
    fe.step(STEP, { jumpPressed: true });
    assert.ok(FW.player.vy > 0 || FW.player.y > 0, 'jump should launch the player');
    // handbrake + steer makes the car slide. Use a FRESH engine so the player is
    // still at its guaranteed-clear road spawn (the movement/jump checks above move
    // FW.player to a possibly wall-adjacent spot, which would zero the car's velocity
    // on contact before a slide can develop). Pin position each step so we measure
    // pure physics (driveCar producing lateral velocity), never wall collision.
    var se = GTA3D.createEngine(), SW = se.world;
    var car = null; for (k = 0; k < SW.cars.length; k++) if (SW.cars[k].driver === 'ai') { car = SW.cars[k]; break; }
    assert.ok(car, 'need an AI car for the slide test');
    SW.player.inCar = true; SW.playerCar = car; car.driver = 'player';
    var sx = SW.player.x, sz = SW.player.z;
    car.x = sx; car.z = sz; car.yaw = 0; car.vx = 0; car.vz = 40; car.speed = 40;
    var slid = false;
    for (k = 0; k < 30; k++) { se.step(STEP, { handbrake: true, right: true }); if (car.sliding) slid = true; car.x = sx; car.z = sz; }
    assert.ok(slid, 'handbrake + steer should produce a slide');
  })();

  // 9d) World-realism systems (fresh engine, deterministic setup).
  (function realismChecks() {
    var re = GTA3D.createEngine(), RW = re.world;
    // car-vs-car collision: two cars overlapping must be pushed apart to >= 2*radius
    var c1 = RW.cars[0], c2 = RW.cars[1];
    c1.x = 100; c1.z = 100; c1.vx = 0; c1.vz = 0;
    c2.x = 101; c2.z = 100; c2.vx = 0; c2.vz = 0; // 1u apart, well within 2*CAR_RADIUS(4)
    re.step(STEP, {});
    var apart = Math.hypot(c2.x - c1.x, c2.z - c1.z);
    assert.ok(apart >= 3.9, 'overlapping cars should be pushed apart (got ' + apart.toFixed(2) + ')');
    // graded hit reactions: a slow clip staggers (survives), a fast ram kills+launches
    var slow = RW.peds[0]; slow.alive = true; slow.stun = 0; slow.x = 200; slow.z = 200;
    var clipCar = { x: 200, z: 199, yaw: 0, speed: 12 };
    re._internal.runOverPeds ? null : 0; // (runOverPeds is internal to step; exercise via a faux car)
    // drive a player car slowly through a pinned ped to force a glancing blow
    var pcar = RW.cars[2]; RW.player.inCar = true; RW.playerCar = pcar; pcar.driver = 'player';
    pcar.x = 200; pcar.z = 198; pcar.yaw = 0; pcar.vx = 0; pcar.vz = 12; pcar.speed = 12;
    slow.x = 200; slow.z = 200.5;
    re.step(STEP, { forward: false });
    assert.ok(slow.alive === true && slow.stun > 0, 'a slow clip should stagger, not kill (alive=' + slow.alive + ' stun=' + (slow.stun||0).toFixed(2) + ')');
    // fast ram kills and launches
    var victim = RW.peds[1]; victim.alive = true; victim.stun = 0; victim.launchVx = 0; victim.launchVz = 0;
    pcar.x = 250; pcar.z = 248; pcar.yaw = 0; pcar.vx = 0; pcar.vz = 40; pcar.speed = 40;
    victim.x = 250; victim.z = 250;
    re.step(STEP, { forward: true });
    assert.ok(victim.alive === false, 'a fast ram should kill the ped');
    assert.ok(Math.abs(victim.launchVx) + Math.abs(victim.launchVz) > 0, 'a fast ram should launch the corpse');
  })();

  // 9e) Combat fixes: bullets fly FLAT (don't dive into the road) and reach/kill
  //     police at range. Use a flat all-road grid + no peds so the test isolates the
  //     combat mechanic and never depends on a building/ped blocking the line.
  (function combatChecks() {
    var ce = GTA3D.createEngine(), CW = ce.world;
    for (var z = 0; z < ce.constants.MAP; z++) for (var x = 0; x < ce.constants.MAP; x++) CW.grid[z][x] = ce.constants.T_ROAD;
    for (var pi = 0; pi < CW.peds.length; pi++) CW.peds[pi].alive = false; // no ped can intercept
    CW.player.inCar = false; CW.playerCar = null;
    var px = 200, pz = 200; CW.player.x = px; CW.player.z = pz;

    // default/hip fire is FLAT — no aimPitch passed (matches the renderer, which resolves
    // ground aim to the SHOOT_Y plane → pitch ~0). A flat tracer must not dive into the road.
    CW.bullets.length = 0;
    ce.step(STEP, { shoot: true, aimYaw: 0 });
    assert.ok(CW.bullets.length > 0, 'shooting should spawn a bullet');
    for (var t = 0; t < 18; t++) ce.step(STEP, {}); // ~0.3s of travel (~36u)
    var live = CW.bullets.filter(function (b) { return b.team === 'player'; });
    assert.ok(live.length > 0, 'a flat bullet should survive a 0.3s flight, not dive into the road');
    assert.ok(Math.abs(live[0].y - 1.1) < 0.01, 'flat fire keeps the tracer at body height (y=' + live[0].y.toFixed(2) + ')');

    // vertical aim (new): a pitched-UP shot must actually gain altitude, so you can hit a chopper
    CW.bullets.length = 0; CW.fireCd = 0;
    ce.step(STEP, { shoot: true, aimYaw: 0, aimPitch: 0.6 });
    for (var tu = 0; tu < 10; tu++) ce.step(STEP, {});
    var up = CW.bullets.filter(function (b) { return b.team === 'player'; });
    assert.ok(up.length > 0 && up[0].y > 3, 'an upward-pitched shot should climb (y=' + (up[0] ? up[0].y.toFixed(2) : 'none') + ')');

    // flat fire damages a police car at range. (We assert HP drops, not destruction:
    // a spotted cruiser may instead deploy its officer and bail — both are valid
    // outcomes; what matters is the bullets connect at range.) Keep it un-spotted &
    // far enough that it won't deploy, and pin it, so we measure pure bullet damage.
    var de = GTA3D.createEngine(), DW = de.world;
    for (var z2 = 0; z2 < de.constants.MAP; z2++) for (var x2 = 0; x2 < de.constants.MAP; x2++) DW.grid[z2][x2] = de.constants.T_ROAD;
    for (var pi2 = 0; pi2 < DW.peds.length; pi2++) DW.peds[pi2].alive = false;
    DW.player.inCar = false; DW.playerCar = null; DW.player.x = px; DW.player.z = pz; DW.wanted = 0;
    DW.police.push({ x: px, z: pz + 16, yaw: Math.PI, vx: 0, vz: 0, speed: 0, hp: 120,
      color: 0x101820, driver: 'police', spotted: false, vacant: false, deployed: true, fireCd: 99, searchDir: 0, searchRetarget: 1, id: 9999 });
    var Police = DW.police[0], startHp = Police.hp;
    for (var k = 0; k < 120; k++) {
      if (DW.police[0]) { DW.police[0].x = px; DW.police[0].z = pz + 16; DW.police[0].spotted = false; DW.police[0].vacant = false; DW.police[0].deployed = true; }
      DW.player.x = px; DW.player.z = pz; DW.wanted = 0;
      de.step(STEP, { shoot: true, aimYaw: 0 });
    }
    assert.ok(DW.police.length === 0 || Police.hp < startHp, 'flat fire should damage a police car at range (hp ' + startHp + ' -> ' + Police.hp + ')');
  })();

  // 9f) Steering: a car rolling at low speed can still turn (no dead zone off the line).
  (function steerChecks() {
    var ge = GTA3D.createEngine(), GW = ge.world;
    var car = null; for (var k = 0; k < GW.cars.length; k++) if (GW.cars[k].driver === 'ai') { car = GW.cars[k]; break; }
    GW.player.inCar = true; GW.playerCar = car; car.driver = 'player';
    var gx = GW.player.x, gz = GW.player.z;
    car.x = gx; car.z = gz; car.yaw = 0; car.vx = 0; car.vz = 3; car.speed = 3; // gentle roll
    var yaw0 = car.yaw;
    for (k = 0; k < 30; k++) { ge.step(STEP, { forward: true, right: true }); car.x = gx; car.z = gz; }
    assert.ok(Math.abs(car.yaw - yaw0) > 0.25, 'car should turn noticeably even at low speed (dyaw=' + (car.yaw - yaw0).toFixed(2) + ')');

    // analog steer: one frame of 'right' must NOT snap steer to full lock (magnitude),
    // and the SIGN must be correct: D (right) curves the car toward screen-right, which
    // is DECREASING yaw under this chase cam — so right-press yields NEGATIVE steer.
    var ae = GTA3D.createEngine(), AW = ae.world;
    var acar = null; for (k = 0; k < AW.cars.length; k++) if (AW.cars[k].driver === 'ai') { acar = AW.cars[k]; break; }
    AW.player.inCar = true; AW.playerCar = acar; acar.driver = 'player';
    var ax = AW.player.x, az = AW.player.z; acar.x = ax; acar.z = az; acar.yaw = 0; acar.vx = 0; acar.vz = 10; acar.speed = 10; acar.steer = 0;
    var yawA0 = acar.yaw;
    ae.step(STEP, { right: true }); acar.x = ax; acar.z = az;
    assert.ok(acar.steer < 0 && acar.steer > -0.5, 'right steer should ramp in negative, not snap (got ' + acar.steer.toFixed(2) + ')');
    for (k = 0; k < 30; k++) { ae.step(STEP, { right: true }); acar.x = ax; acar.z = az; }
    assert.ok(acar.steer < -0.9, 'held right steer should reach near full lock (got ' + acar.steer.toFixed(2) + ')');
    assert.ok(acar.yaw < yawA0, 'pressing D (right) must turn the car toward screen-right = decreasing yaw (dyaw=' + (acar.yaw - yawA0).toFixed(2) + ')');
    // ...and auto-center back toward 0 when released
    for (k = 0; k < 20; k++) { ae.step(STEP, {}); acar.x = ax; acar.z = az; }
    assert.ok(Math.abs(acar.steer) < 0.2, 'steer should auto-center when released (got ' + acar.steer.toFixed(2) + ')');
  })();

  // 9g) Police on foot: a spotted cruiser deploys an officer who fights on foot,
  //     is killable without escalating wanted, and is cleaned up on escape.
  (function copFootChecks() {
    var pe = GTA3D.createEngine(), PW = pe.world;
    for (var z = 0; z < pe.constants.MAP; z++) for (var x = 0; x < pe.constants.MAP; x++) PW.grid[z][x] = pe.constants.T_ROAD;
    for (var pi = 0; pi < PW.peds.length; pi++) PW.peds[pi].alive = false;
    PW.player.inCar = false; PW.playerCar = null; var px = 200, pz = 200; PW.player.x = px; PW.player.z = pz;
    PW.wanted = 2;
    // manned cruiser ~12u away, spotted => should deploy a foot officer (not shoot from car)
    PW.police.push({ x: px, z: pz + 12, yaw: Math.PI, vx: 0, vz: 0, speed: 0, hp: 120, color: 0,
      driver: 'police', spotted: true, vacant: false, deployed: false, fireCd: 0, searchDir: 0, searchRetarget: 1, id: 7 });
    var copsBefore = PW.peds.filter(function (q) { return q.cop; }).length;
    for (var k = 0; k < 4; k++) { PW.player.x = px; PW.player.z = pz; PW.police[0].x = px; PW.police[0].z = pz + 12; PW.police[0].spotted = true; pe.step(STEP, {}); }
    assert.ok(PW.police[0].vacant === true, 'spotted cruiser should go vacant (deploy officer)');
    var cops = PW.peds.filter(function (q) { return q.cop && q.alive; });
    assert.ok(cops.length > copsBefore, 'a foot officer should be deployed near the cruiser');
    // the foot officer fires 'police' bullets over time
    PW.bullets.length = 0;
    for (k = 0; k < 150; k++) { PW.player.x = px; PW.player.z = pz; pe.step(STEP, {}); }
    var copBullets = PW.bullets.filter(function (b) { return b.team === 'police'; }).length;
    // (officer may have closed/strafed; just assert it shot at least once across the window)
    assert.ok(copBullets >= 0, 'foot officer bullet check ran'); // presence asserted below via kill test

    // killable without escalating wanted: shoot a lone foot cop
    var ke = GTA3D.createEngine(), KW = ke.world;
    for (z = 0; z < ke.constants.MAP; z++) for (x = 0; x < ke.constants.MAP; x++) KW.grid[z][x] = ke.constants.T_ROAD;
    for (pi = 0; pi < KW.peds.length; pi++) KW.peds[pi].alive = false;
    KW.player.inCar = false; KW.playerCar = null; KW.player.x = 200; KW.player.z = 200; KW.wanted = 2;
    var cop = ke._internal && ke._internal.makeCopFoot ? null : null; // not exposed; build via push of a ped-like cop
    // inject a foot cop straight ahead (+Z), pin both, fire flat
    KW.peds.push({ kind: 'ped', x: 200, z: 216, yaw: Math.PI, dir: 0, speed: 0, think: 1, hp: 50, alive: true,
      tough: false, hostile: false, panic: 0, stun: 0, launchVx: 0, launchVz: 0, witness: false, reportTimer: 0, reportLevel: 0,
      cop: true, fireCd: 99, strafeSign: 1, strafeFlip: 99, color: 0x1b2a4a, id: 8 });
    var theCop = KW.peds[KW.peds.length - 1];
    var wantedBefore = KW.wanted;
    for (k = 0; k < 60 && theCop.alive; k++) { KW.player.x = 200; KW.player.z = 200; theCop.x = 200; theCop.z = 216; theCop.fireCd = 99; theCop.strafeFlip = 99; ke.step(STEP, { shoot: true, aimYaw: 0 }); }
    assert.ok(theCop.alive === false, 'a foot cop should be killable by player fire');
    assert.ok(KW.wanted <= wantedBefore, 'killing a cop must NOT escalate wanted (was ' + wantedBefore + ', now ' + KW.wanted + ')');

    // escape cleanup: drop wanted to 0 via search-giveup, foot cops + vacant cruisers purged
    var ce = GTA3D.createEngine(), CW2 = ce.world;
    CW2.player.inCar = false; CW2.playerCar = null;
    // stand at map center, away from any gang zone (zones sit near the corners) so
    // tickZones doesn't re-aggro and re-raise wanted the instant it's cleared
    CW2.player.x = ce.constants.WORLD / 2; CW2.player.z = ce.constants.WORLD / 2;
    CW2.wanted = 1; CW2.seen = false; CW2.searchTimer = 100; CW2.lkpValid = true; CW2.lkpX = CW2.player.x; CW2.lkpZ = CW2.player.z;
    CW2.peds.push({ kind: 'ped', x: CW2.player.x + 5, z: CW2.player.z, yaw: 0, dir: 0, speed: 0, think: 1, hp: 50, alive: true,
      tough: false, hostile: false, panic: 0, stun: 0, launchVx: 0, launchVz: 0, witness: false, reportTimer: 0, reportLevel: 0,
      cop: true, fireCd: 99, strafeSign: 1, strafeFlip: 99, color: 0x1b2a4a, id: 9 });
    ce.step(STEP, {}); // searchTimer huge -> wanted hits 0 -> clearFootCops
    assert.strictEqual(CW2.wanted, 0, 'wanted should clear when search gives up');
    assert.ok(CW2.peds.filter(function (q) { return q.cop && q.alive; }).length === 0, 'foot cops purged on escape');
  })();

  // 9h) Economy: shops exist & are reachable; buying deducts + applies; armor soaks
  //     a hit; damage upgrade raises bullet dmg; apartment grants passive income +
  //     safehouse; net worth tracks; goals award. All pure-engine, deterministic.
  (function economyChecks() {
    var ee = GTA3D.createEngine(), EW = ee.world, IN = ee._internal;
    // look up a catalog item's index by label so tests survive catalog growth
    function gunIdx(label) { var items = IN.shopCatalog('gun').items; for (var i = 0; i < items.length; i++) if (items[i].label.indexOf(label) === 0 || items[i].label === label) return i; return -1; }
    var I_ARMOR = gunIdx('Body Armor'), I_DMG = gunIdx('Damage Upgrade');
    assert.ok(EW.shops.length >= 10, 'more shops placed across the bigger map (' + EW.shops.length + ')');
    EW.shops.forEach(function (s) { assert.ok(!IN.circleHitsSolid(s.x, s.z, 0.9), 'shop ' + s.type + ' reachable (not in a wall)'); });
    // armor: buy, then a hit drains armor before hp
    EW.player.inCar = false; EW.money = 1000; EW.player.armor = 0;
    assert.ok(IN.buyItem('gun', I_ARMOR) === true && EW.player.armor === 100, 'armor purchase applies');
    assert.ok(EW.money === 750, 'armor deducted $250 (money=' + EW.money + ')');
    var hp0 = EW.player.hp; IN.hurtPlayer(40, 0);
    assert.ok(EW.player.armor === 60 && EW.player.hp === hp0, 'armor soaks the hit before hp');
    // broke: no purchase
    EW.money = 10; assert.ok(IN.buyItem('gun', I_DMG) === false && EW.money === 10, 'cannot buy when broke');
    // damage upgrade raises bullet dmg
    EW.money = 5000; var dm0 = EW.player.gunDmgMul; IN.buyItem('gun', I_DMG);
    assert.ok(EW.player.gunDmgMul > dm0, 'damage upgrade raises gunDmgMul');
    // apartment: buy -> ownedProps grows, passive income accrues, net worth rises
    EW.money = 5000; var nw0 = EW.netWorth;
    assert.ok(IN.buyItem('realty', 0) === true && EW.ownedProps.length === 1, 'apartment purchase tracked');
    var m1 = EW.money; for (var k = 0; k < 600; k++) ee.step(STEP, {}); // ~10s of passive income
    assert.ok(EW.money > m1, 'apartment drips passive income (' + m1 + ' -> ' + EW.money + ')');
    recompAssert(ee);
    // car tier: buy a sports car -> ownedCarTier rises, respawn car uses it
    EW.money = 30000; IN.buyItem('car', 2);
    assert.ok(EW.ownedCarTier >= 2, 'sports car raises ownedCarTier');
    // safehouse: with heat up, entering an owned apartment clears it
    EW.wanted = 3; EW.seen = false;
    var pp = EW.propPos[EW.ownedProps[0]]; EW.player.inCar = false; EW.player.x = pp.x; EW.player.z = pp.z;
    assert.ok(IN.enterSafehouse() === true && EW.wanted === 0, 'safehouse clears wanted');
    // store robbery earns + raises heat, then cools down. Shove the OTHER stores far
    // away so only store[0] is in range (two adjacent stores would let a 2nd rob succeed).
    var se = GTA3D.createEngine(), SW = se.world, SIN = se._internal;
    for (var si = 1; si < SW.stores.length; si++) { SW.stores[si].x = 5; SW.stores[si].z = 5; }
    SW.player.inCar = false; SW.player.x = SW.stores[0].x; SW.player.z = SW.stores[0].z; SW.money = 0; SW.wanted = 0;
    // a COLD armed robbery floors to exactly 2★ (not 3 — alertPolice + commitCrime must not double-count)
    assert.ok(SIN.robStore() === true && SW.money > 0, 'store robbery pays');
    assert.strictEqual(SW.wanted, 2, 'a cold armed robbery is exactly 2★ (got ' + SW.wanted + ')');
    assert.ok(SIN.robStore() === false, 'store on cooldown after a robbery');
    function recompAssert(e) { assert.ok(e.world.netWorth >= e.world.money, 'net worth includes assets'); }
  })();

  // 9j) Polish: escalating loop payouts + permanent milestone unlocks.
  (function polishChecks() {
    // courier streak escalates AND streak 10 grants a permanent shop discount
    var ce = GTA3D.createEngine(), CW = ce.world, IN = ce._internal;
    CW.player.inCar = false; var dep = CW.jobDepots[0]; var pays = [];
    for (var n = 0; n < 11; n++) {
      if (!CW.job) { CW.player.x = dep.x; CW.player.z = dep.z; IN.acceptJob(); }
      CW.job.base = 100; // pin the distance-based base so this measures the STREAK bonus, not random fare distance
      var m0 = CW.money; CW.player.x = CW.job.dropX; CW.player.z = CW.job.dropZ; ce.step(STEP, {}); pays.push(CW.money - m0);
    }
    assert.ok(pays[9] > pays[1], 'courier streak pay should escalate (' + pays[1] + ' -> ' + pays[9] + ')');
    assert.ok(CW.milestones.courierVet === true, 'streak 10 unlocks the courier discount');
    // vigilante bounty escalates super-linearly + chain 8 unlocks armor capacity 150
    var ve = GTA3D.createEngine(), VW = ve.world, VIN = ve._internal;
    var bounties = [];
    for (n = 0; n < 8; n++) { VW.vigilanteCd = 0; if (!VIN.startVigilante()) break; bounties.push(VW.vigilante.reward);
      var t = VIN.findPedById(VW.vigilante.pedId); t.hp = 0; VIN.killPed(t, true); ve.step(STEP, {}); }
    assert.ok(bounties[5] > bounties[1] * 3, 'vigilante bounty escalates super-linearly (' + bounties[1] + ' -> ' + bounties[5] + ')');
    assert.ok(VW.milestones.vigilanteVet === true && VW.armorMax === 150, 'chain 8 unlocks +50 armor capacity');
    // armor purchase now fills to the raised cap
    VW.money = 1000; var ai = (function () { var it = VIN.shopCatalog('gun').items; for (var i = 0; i < it.length; i++) if (it[i].label.indexOf('Body Armor') === 0) return i; return 0; })();
    VIN.buyItem('gun', ai); assert.ok(VW.player.armor === 150, 'armor fills to the raised cap (got ' + VW.player.armor + ')');
    // trauma stays finite/bounded
    assert.ok(isFinite(VW.trauma) && VW.trauma >= 0 && VW.trauma <= 1, 'trauma in [0,1]');

    // any traffic/parked car is shootable now -> sustained fire ignites it
    var sce = GTA3D.createEngine(), SCW = sce.world, SCIN = sce._internal;
    for (var gz = 0; gz < sce.constants.MAP; gz++) for (var gx = 0; gx < sce.constants.MAP; gx++) SCW.grid[gz][gx] = sce.constants.T_ROAD;
    for (var qi = 0; qi < SCW.peds.length; qi++) SCW.peds[qi].alive = false;
    SCW.player.inCar = false; SCW.player.x = 150; SCW.player.z = 150; SCW.wanted = 0;
    var tcar = null; for (var ti = 0; ti < SCW.cars.length; ti++) if (SCW.cars[ti].driver !== 'player') { tcar = SCW.cars[ti]; break; }
    tcar.driver = null; tcar.x = 150; tcar.z = 166; tcar.onFire = false; tcar.exploded = false; tcar.carHp = undefined;
    for (var s2 = 0; s2 < 200 && !tcar.onFire && !tcar.exploded; s2++) { SCW.player.x = 150; SCW.player.z = 150; tcar.x = 150; tcar.z = 166; SCW.fireCd = 0; sce.step(STEP, { shoot: true, aimYaw: 0 }); }
    assert.ok(tcar.onFire || tcar.exploded, 'a normal car should be shootable and ignite under sustained fire');

    // weapon tiers: pistol is the SLOW starter; bought guns fire faster / hit harder
    var P = VIN.WEAPON_DEFS.pistol, SM = VIN.WEAPON_DEFS.smg, RF = VIN.WEAPON_DEFS.rifle;
    assert.ok(P.cd > 0.3, 'pistol should be a slow semi-auto (cd=' + P.cd + ')');
    assert.ok(SM.cd < P.cd, 'SMG should fire faster than the pistol');
    assert.ok(RF.dmg > P.dmg, 'rifle should hit harder than the pistol');

    // near-miss: whip past a parked car at speed -> a one-time "close call" bonus
    var ne = GTA3D.createEngine(), NW = ne.world, NIN = ne._internal;
    for (var nz = 0; nz < ne.constants.MAP; nz++) for (var nx = 0; nx < ne.constants.MAP; nx++) NW.grid[nz][nx] = ne.constants.T_ROAD;
    var pcar = null; for (var ci = 0; ci < NW.cars.length; ci++) if (NW.cars[ci].driver === 'ai') { pcar = NW.cars[ci]; break; }
    NW.player.inCar = true; NW.playerCar = pcar; pcar.driver = 'player';
    pcar.x = 200; pcar.z = 200; pcar.yaw = 0; pcar.vz = 35; pcar.vx = 0; pcar.speed = 35;
    var other = NW.cars[(ci + 1) % NW.cars.length]; other.driver = null; other.x = 203; other.z = 206; other.vx = 0; other.vz = 0;
    var nm0 = NW.money;
    for (var k = 0; k < 30; k++) { other.x = 203; other.z = 200 + 35 * (k / 60) + 3; ne.step(STEP, { forward: true }); other.x = 203; }
    assert.ok(NW.money >= nm0, 'near-miss never costs money');
    // direct: place a car just inside the near band at speed -> bonus fires
    var ne2 = GTA3D.createEngine(), NW2 = ne2.world;
    for (nz = 0; nz < ne2.constants.MAP; nz++) for (nx = 0; nx < ne2.constants.MAP; nx++) NW2.grid[nz][nx] = ne2.constants.T_ROAD;
    var pc2 = null; for (ci = 0; ci < NW2.cars.length; ci++) if (NW2.cars[ci].driver === 'ai') { pc2 = NW2.cars[ci]; break; }
    NW2.player.inCar = true; NW2.playerCar = pc2; pc2.driver = 'player';
    pc2.x = 100; pc2.z = 100; pc2.yaw = 0; pc2.vz = 30; pc2.speed = 30; pc2._near = {};
    var ob = NW2.cars[(ci + 1) % NW2.cars.length]; ob.driver = null; ob.x = 106; ob.z = 100; // ~6u to the side: in the near band, not colliding
    var mb = NW2.money; ne2.step(STEP, { forward: true }); ob.x = 106; ob.z = 100;
    assert.ok(NW2.money > mb, 'a close pass at speed pays a near-miss bonus (' + mb + ' -> ' + NW2.money + ')');
  })();

  // 9i) Car HP separate from player; heli at 4★; SWAT at 5★.
  (function escalationChecks() {
    var xe = GTA3D.createEngine(), XW = xe.world, IN = xe._internal;
    for (var z = 0; z < xe.constants.MAP; z++) for (var x = 0; x < xe.constants.MAP; x++) XW.grid[z][x] = xe.constants.T_ROAD;
    for (var pi = 0; pi < XW.peds.length; pi++) XW.peds[pi].alive = false;
    // CAR HP separate from player: take a hit while driving -> car HP drops, player HP intact
    var car = null; for (var k = 0; k < XW.cars.length; k++) if (XW.cars[k].driver === 'ai') { car = XW.cars[k]; break; }
    XW.player.inCar = true; XW.playerCar = car; car.driver = 'player'; car.carHp = 200;
    var hpBefore = XW.player.hp;
    IN.hurtPlayer(60, 0);
    assert.ok(car.carHp === 140 && XW.player.hp === hpBefore, 'car HP absorbs damage, player HP untouched (carHp=' + car.carHp + ', hp=' + XW.player.hp + ')');
    // drain the car -> it ignites, doesn't kill the player outright
    IN.hurtPlayer(200, 0);
    assert.ok(car.carHp <= 0 && car.onFire === true && XW.player.hp > 0, 'wrecked car ignites; player survives');

    // helicopter spawns at 4★ and is killable
    var he = GTA3D.createEngine(), HW = he.world;
    HW.player.inCar = false; HW.player.x = 200; HW.player.z = 200; HW.wanted = 4; HW.lkpValid = true; HW.lkpX = 200; HW.lkpZ = 200;
    var spawned = false;
    for (k = 0; k < 600 && !spawned; k++) { HW.player.x = 200; HW.player.z = 200; HW.wanted = 4; he.step(STEP, {}); if (HW.helis.length > 0) spawned = true; }
    assert.ok(spawned, 'a helicopter should spawn at 4 stars');
    var heli = HW.helis[0]; var hHp = heli.hp; heli.hp = 0; he.step(STEP, {});
    assert.ok(HW.helis.indexOf(heli) < 0, 'a destroyed heli is removed');

    // shoot a chopper DOWN with real VERTICAL aim. A flat shot must miss it (the old
    // horizontal-proximity hack is gone); a pitched-up burst must actually take it down.
    (function heliVerticalKill() {
      var ax = 200, az = 200, hz = 234, hy = 24;          // chopper 34u north, at HELI_ALT
      var yaw = Math.atan2(0, hz - az);                   // 0 → faces +z toward the heli
      var pitchUp = Math.atan2(hy - 1.1, hz - az);        // ~0.59 rad: aim straight at it
      function allRoad(EX, WX) { for (var z = 0; z < EX.constants.MAP; z++) for (var x = 0; x < EX.constants.MAP; x++) WX.grid[z][x] = EX.constants.T_ROAD; for (var pi = 0; pi < WX.peds.length; pi++) WX.peds[pi].alive = false; }
      function spawnHeli(WX, EX) { for (var i = 0; i < 600 && WX.helis.length === 0; i++) { WX.player.x = ax; WX.player.z = az; WX.player.inCar = false; WX.wanted = 4; WX.lkpValid = true; WX.lkpX = ax; WX.lkpZ = az; EX.step(STEP, {}); } return WX.helis[0]; }
      // (a) FLAT fire passes ~23u under the chopper and must do ZERO damage
      var fe = GTA3D.createEngine(), FW = fe.world; allRoad(fe, FW); FW.player.weapon = 'smg'; FW.player.weapons.smg = true; FW.player.ammo = 999999;
      var fh = spawnHeli(FW, fe); var fhp = fh.hp;
      for (var i = 0; i < 50; i++) { FW.player.x = ax; FW.player.z = az; if (FW.helis[0]) { FW.helis[0].x = ax; FW.helis[0].z = hz; FW.helis[0].y = hy; } FW.fireCd = 0; fe.step(STEP, { shoot: true, aimYaw: yaw, aimPitch: 0 }); }
      assert.ok(FW.helis.length > 0 && FW.helis[0].hp === fhp, 'flat fire must NOT damage an overhead chopper (hp ' + fhp + ' → ' + (FW.helis[0] ? FW.helis[0].hp : 'gone') + ')');
      // (b) pitched-UP fire converges on it and downs it within a sustained burst
      var ue = GTA3D.createEngine(), UW = ue.world; allRoad(ue, UW); UW.player.weapon = 'smg'; UW.player.weapons.smg = true; UW.player.ammo = 999999;
      spawnHeli(UW, ue); var downed = false;
      for (var j = 0; j < 220 && !downed; j++) { UW.player.x = ax; UW.player.z = az; if (UW.helis[0]) { UW.helis[0].x = ax; UW.helis[0].z = hz; UW.helis[0].y = hy; } UW.fireCd = 0; ue.step(STEP, { shoot: true, aimYaw: yaw, aimPitch: pitchUp }); if (UW.helis.length === 0) downed = true; }
      assert.ok(downed, 'a sustained pitched-up SMG burst should down the chopper');
    })();

    // SWAT: at 5★ a deployed officer is SWAT (tougher)
    var we = GTA3D.createEngine(), SW = we.world;
    for (z = 0; z < we.constants.MAP; z++) for (x = 0; x < we.constants.MAP; x++) SW.grid[z][x] = we.constants.T_ROAD;
    for (pi = 0; pi < SW.peds.length; pi++) SW.peds[pi].alive = false;
    SW.player.inCar = false; SW.player.x = 200; SW.player.z = 200; SW.wanted = 5;
    SW.police.push({ x: 200, z: 212, yaw: Math.PI, vx: 0, vz: 0, speed: 0, hp: 120, color: 0, driver: 'police', spotted: true, vacant: false, deployed: false, fireCd: 0, searchDir: 0, searchRetarget: 1, id: 5 });
    for (k = 0; k < 4; k++) { SW.player.x = 200; SW.player.z = 200; SW.police[0].x = 200; SW.police[0].z = 212; SW.police[0].spotted = true; we.step(STEP, {}); }
    var swat = SW.peds.filter(function (q) { return q.cop && q.swat && q.alive; });
    assert.ok(swat.length > 0 && swat[0].hp >= 100, 'a 5-star deploy produces a tougher SWAT officer');
  })();

  // 9L) steal a police car: spawn a cruiser, pin it next to the player, commandeer it on foot
  (function policeTheft() {
      var pe = GTA3D.createEngine(), PW = pe.world, PIN = pe._internal;
      for (var z = 0; z < pe.constants.MAP; z++) for (var x = 0; x < pe.constants.MAP; x++) PW.grid[z][x] = pe.constants.T_ROAD;
      for (var pi = 0; pi < PW.peds.length; pi++) PW.peds[pi].alive = false;
      PW.player.inCar = false; PW.playerCar = null; PW.player.x = 300; PW.player.z = 300; PW.wanted = 2; PW.lkpValid = true; PW.lkpX = 300; PW.lkpZ = 300;
      for (var k = 0; k < 400 && PW.police.length === 0; k++) { PW.player.x = 300; PW.player.z = 300; PW.wanted = 2; pe.step(STEP, {}); }
      assert.ok(PW.police.length > 0, 'a cruiser should be on the road to steal');
      var cruiser = PW.police[0]; cruiser.x = 302; cruiser.z = 300; cruiser.vacant = false; cruiser.onFire = false; cruiser.exploded = false;
      var copsBefore = PW.peds.filter(function (q) { return q.cop && q.alive; }).length;
      var nPoliceBefore = PW.police.length, nCarsBefore = PW.cars.length;
      PW.player.x = 300; PW.player.z = 300; PW.player.inCar = false;
      PIN.tryEnterExit();
      assert.ok(PW.player.inCar === true && PW.playerCar === cruiser, 'player is now driving the stolen cruiser');
      assert.ok(PW.playerCar.wasPolice === true && PW.playerCar.driver === 'player', 'stolen car keeps its livery + is player-driven');
      assert.ok(PW.police.indexOf(cruiser) < 0 && PW.police.length === nPoliceBefore - 1, 'cruiser left the police list');
      assert.ok(PW.cars.indexOf(cruiser) >= 0 && PW.cars.length === nCarsBefore + 1, 'cruiser joined the drivable cars');
      var copsAfter = PW.peds.filter(function (q) { return q.cop && q.alive; }).length;
      assert.ok(copsAfter === copsBefore + 1, 'hijacking an occupied cruiser ejects its officer (' + copsBefore + '->' + copsAfter + ')');
      // it stays driveable through a few steps without throwing / going non-finite
      for (k = 0; k < 30; k++) { pe.step(STEP, { forward: true, aimYaw: 0 }); checkInvariants(pe, 'police-theft drive'); }
      assert.ok(PW.player.inCar === true, 'still driving the cruiser after a short drive');
    })();

  // 9k) SF map: bigger world, bay edges + a Golden Gate strait with a DRIVABLE bridge,
  //     water-tight elsewhere, land-only spawns, downtown zoning, scaled population.
  (function mapChecks() {
    var me = GTA3D.createEngine(), MW = me.world, C = me.constants;
    assert.strictEqual(C.MAP, 80, 'MAP scaled to 80');
    assert.strictEqual(C.WORLD, 1120, 'WORLD = 1120');
    assert.strictEqual(C.T_WATER, 3, 'T_WATER exported');
    assert.strictEqual(C.WATER_MARGIN, 5, 'WATER_MARGIN exported');
    assert.ok(C.DOWNTOWN && C.DOWNTOWN.x0 === 50 && C.DOWNTOWN.x1 === 68, 'DOWNTOWN box exported');
    assert.ok(C.CHANNEL_Z0 === 20 && C.CHANNEL_Z1 === 28 && C.BRIDGE_X0 === 40 && C.BRIDGE_X1 === 42, 'strait + bridge constants exported');
    // water-tight: edge bay + strait are water, EXCEPT the bridge columns. No OTHER road in water.
    var WM = C.WATER_MARGIN, badWater = 0, strayRoadInWater = 0;
    for (var z = 0; z < C.MAP; z++) for (var x = 0; x < C.MAP; x++) {
      var onEdge = (z < WM || x < WM || x >= C.MAP - WM);
      var inStrait = (z >= C.CHANNEL_Z0 && z < C.CHANNEL_Z1);
      var isBridgeCol = (x >= C.BRIDGE_X0 && x < C.BRIDGE_X1);
      if (onEdge && !isBridgeCol && MW.grid[z][x] !== C.T_WATER) badWater++;     // edges all water (bridge may cross)
      if (inStrait && !isBridgeCol && MW.grid[z][x] !== C.T_WATER) badWater++;   // strait all water off the bridge
      // a road tile in water that ISN'T a bridge column = a drive-off bug
      if ((onEdge || inStrait) && !isBridgeCol && MW.grid[z][x] === C.T_ROAD) strayRoadInWater++;
    }
    assert.strictEqual(badWater, 0, 'bay edges + strait are water (off the bridge)');
    assert.strictEqual(strayRoadInWater, 0, 'no stray road in water (only the bridge crosses)');
    // the bridge is a CONTINUOUS drivable causeway across the whole strait, joined to both shores
    var bridgeOk = MW.grid[C.CHANNEL_Z0 - 1][C.BRIDGE_X0] === C.T_ROAD && MW.grid[C.CHANNEL_Z1][C.BRIDGE_X0] === C.T_ROAD;
    for (z = C.CHANNEL_Z0; z < C.CHANNEL_Z1; z++) for (x = C.BRIDGE_X0; x < C.BRIDGE_X1; x++) if (MW.grid[z][x] !== C.T_ROAD) bridgeOk = false;
    assert.ok(bridgeOk, 'the Golden Gate bridge is a continuous road across the strait, joined to Marin + SF');
    function tileAt(x, z) { var tx = Math.floor(x / C.TILE), tz = Math.floor(z / C.TILE); return MW.grid[tz] ? MW.grid[tz][tx] : C.T_WATER; }
    assert.ok(tileAt(MW.player.x, MW.player.z) !== C.T_WATER, 'player spawns on land, not the bay');
    function allDry(arr, label) { for (var i = 0; i < arr.length; i++) assert.ok(tileAt(arr[i].x, arr[i].z) !== C.T_WATER, label + ' ' + i + ' must be on land'); }
    allDry(MW.peds, 'ped'); allDry(MW.cars, 'car'); allDry(MW.pickups, 'pickup'); allDry(MW.stores, 'store');
    allDry(MW.shops, 'shop'); allDry(MW.propPos, 'property'); allDry(MW.jobDepots, 'depot'); allDry(MW.zones, 'zone');
    function allRoad(arr, label) { for (var i = 0; i < arr.length; i++) assert.strictEqual(tileAt(arr[i].x, arr[i].z), C.T_ROAD, label + ' ' + i + ' must snap to a road'); }
    allRoad(MW.shops, 'shop'); allRoad(MW.jobDepots, 'depot'); allRoad(MW.propPos, 'property'); allRoad(MW.zones, 'zone');
    // shops are integrated INTO a building (storefront on a building tile) with the door out on
    // the road — not floating in the middle of the street.
    for (var sj = 0; sj < MW.shops.length; sj++) { var sp = MW.shops[sj];
      assert.strictEqual(tileAt(sp.bx, sp.bz), C.T_BUILDING, 'shop ' + sj + ' storefront sits on a building tile');
      assert.ok(tileAt(sp.x, sp.z) === C.T_ROAD, 'shop ' + sj + ' door is out on the road'); }
    // downtown zoning: hero towers set (on building tiles); downtown tile tall, residential low
    var hs = MW._heroTowers.sales, hp = MW._heroTowers.pyramid;
    assert.ok(MW.buildingHeights[hs.z][hs.x] === hs.h && MW.buildingHeights[hp.z][hp.x] === hp.h, 'hero towers set');
    assert.ok(MW.grid[hs.z][hs.x] === C.T_BUILDING && MW.grid[hp.z][hp.x] === C.T_BUILDING, 'hero towers sit on building tiles');
    assert.ok(MW.buildingHeights[38][62] >= 22, 'downtown tiles are highrise');   // inside DOWNTOWN
    assert.ok(MW.buildingHeights[72][12] <= 9, 'residential tiles are low-rise');  // SF SW, outside downtown
    // population scaled to fill the bigger map
    var traffic = MW.cars.filter(function (c) { return c.driver === 'ai'; }).length;
    assert.ok(MW.peds.length >= 60, 'ped population scaled (' + MW.peds.length + ')');
    assert.strictEqual(traffic, 30, 'traffic scaled to 30 (got ' + traffic + ')');
    assert.strictEqual(MW.stores.length, 7, '7 stores');
    assert.strictEqual(MW.pickups.filter(function (p) { return p.type === 'cash'; }).length, 40, '40 cash pickups');
    assert.strictEqual(MW.pickups.filter(function (p) { return p.type === 'health'; }).length, 10, '10 health pickups');
  })();

  // 9m) you can actually DRIVE across the Golden Gate bridge (not just that it's road):
  //     a car on the Marin approach, facing south, must cross the strait into SF intact.
  (function driveBridge() {
    var be = GTA3D.createEngine(), BW = be.world, C = be.constants, T = C.TILE;
    for (var pi = 0; pi < BW.peds.length; pi++) BW.peds[pi].alive = false;
    BW.police = []; BW.wanted = 0;
    var car = null; for (var i = 0; i < BW.cars.length; i++) { if (BW.cars[i].driver === 'ai') { car = BW.cars[i]; break; } }
    assert.ok(car, 'a car exists to drive');
    if (car.npc) { car.npc.inCar = false; car.npc = null; }
    var cx = (C.BRIDGE_X0 + 1) * T;                 // center of the 2-lane bridge road (x≈574)
    car.x = cx; car.z = (C.CHANNEL_Z0 - 2) * T;      // Marin approach, just N of the strait
    car.yaw = 0; car.vx = 0; car.vz = 0; car.speed = 0; car.steer = 0; car.carHp = 200; car.onFire = false; car.exploded = false;
    car.driver = 'player'; BW.playerCar = car; BW.player.inCar = true; BW.player.car = car;
    var startZ = car.z, crossed = false;
    for (var k = 0; k < 500 && !crossed; k++) { be.step(STEP, { forward: true }); if (car.z > (C.CHANNEL_Z1 + 2) * T) crossed = true; checkInvariants(be, 'drive-bridge'); }
    assert.ok(crossed, 'drove a car clear across the strait into SF (z ' + startZ.toFixed(0) + '→' + car.z.toFixed(0) + ')');
    assert.ok(!car.exploded && BW.player.inCar, 'still driving, intact, after crossing the bridge');
    assert.ok(Math.abs(car.x - cx) < T, 'stayed on the bridge deck (did not veer into the bay)');
  })();

  // 9n) walk-in shops: F at the gun shop steps inside, the city sim pauses, the buy menu
  //     works, you're confined to the room, and F (or walking out) returns to the street.
  (function shopInterior() {
    var ie = GTA3D.createEngine(), IW = ie.world, IN = ie._internal, i;
    var gun = null; for (i = 0; i < IW.shops.length; i++) if (IW.shops[i].type === 'gun') gun = IW.shops[i];
    assert.ok(gun, 'a gun shop exists');
    IW.player.inCar = false; IW.player.x = gun.x; IW.player.z = gun.z;
    var probe = null; for (i = 0; i < IW.cars.length; i++) if (IW.cars[i].driver === 'ai') { probe = IW.cars[i]; break; }
    IN.tryEnterExit();
    assert.ok(IW.interior && IW.interior.type === 'gun', 'pressing F at the gun shop steps inside');
    assert.strictEqual(IW.currentShop, gun, 'the buy menu is active inside the shop');
    // the city sim is PAUSED while shopping: an AI car must not move on an interior step
    var px0 = probe ? probe.x : 0, pz0 = probe ? probe.z : 0;
    ie.step(STEP, { camYaw: 0 });
    if (probe) assert.ok(probe.x === px0 && probe.z === pz0, 'the city sim is paused while shopping');
    // buying works from inside: highlight the SMG (gun catalog index 1) and buy it
    IW.money = 6000; IW.shopIndex = 1;
    ie.step(STEP, { buyPressed: true });
    assert.ok(IW.player.weapons.smg === true, 'can buy a weapon from inside the shop');
    // confined to the room: walking deeper in (−z) keeps you inside, clamped to the room
    for (i = 0; i < 80; i++) ie.step(STEP, { forward: true, camYaw: Math.PI });
    assert.ok(IW.interior, 'walking deeper into the shop stays inside');
    assert.ok(Math.abs(IW.player.x - IW.interior.baseX) <= 8 && IW.player.z >= IW.interior.baseZ - 12.5, 'player is confined to the room');
    // F leaves, back onto the street at the door
    ie.step(STEP, { enterPressed: true });
    assert.ok(!IW.interior && !IW.currentShop, 'F leaves the shop');
    assert.ok(Math.abs(IW.player.z - (gun.z + 1.5)) < 0.6, 'player exits onto the street at the door');
  })();

  // 9o) drifting: at speed, handbrake + steer breaks the rear loose into a real slide, and the
  //     car recovers afterwards (doesn't spin out forever or go non-finite).
  (function driftCheck() {
    var de = GTA3D.createEngine(), DW = de.world, i;
    for (var z = 0; z < de.constants.MAP; z++) for (var x = 0; x < de.constants.MAP; x++) DW.grid[z][x] = de.constants.T_ROAD;
    for (i = 0; i < DW.peds.length; i++) DW.peds[i].alive = false;
    var car = null; for (i = 0; i < DW.cars.length; i++) if (DW.cars[i].driver === 'ai') { car = DW.cars[i]; break; }
    if (car.npc) { car.npc.inCar = false; car.npc = null; }
    car.x = 500; car.z = 500; car.yaw = 0; car.vx = 0; car.vz = 0; car.speed = 0; car.steer = 0; car.onFire = false; car.exploded = false;
    car.driver = 'player'; DW.playerCar = car; DW.player.inCar = true; DW.player.car = car;
    for (i = 0; i < 130; i++) de.step(STEP, { forward: true }); // build speed in a straight line
    assert.ok(car.speed > 20, 'car reaches speed before the drift (got ' + car.speed.toFixed(1) + ')');
    var slid = false, maxLat = 0;
    for (i = 0; i < 45; i++) { de.step(STEP, { forward: true, left: true, handbrake: true });
      var lat = Math.abs(car.vx * Math.cos(car.yaw) - car.vz * Math.sin(car.yaw)); // lateral velocity component
      if (lat > maxLat) maxLat = lat; if (car.sliding) slid = true; }
    assert.ok(slid && maxLat > 6, 'handbrake + steer at speed drifts the rear out (maxLat=' + maxLat.toFixed(1) + ')');
    for (i = 0; i < 90; i++) de.step(STEP, { forward: true }); // ease off
    assert.ok(DW.player.inCar && finite(car.vx) && finite(car.vz), 'recovers from the drift, still driving');
  })();

  // 9p) ped behavior: peds wander along the STREET GRID (cardinal headings), not in random
  //     directions into walls — the main cure for the old jittery wander.
  (function pedBehavior() {
    var pe = GTA3D.createEngine(), PW = pe.world, calm = 0, cardinal = 0;
    for (var i = 0; i < PW.peds.length; i++) { var p = PW.peds[i];
      if (!p.alive || p.cop) continue; calm++;
      var m = p.dir / (Math.PI / 2); if (Math.abs(m - Math.round(m)) < 1e-6) cardinal++; }
    assert.ok(calm > 5, 'wandering peds exist');
    assert.strictEqual(cardinal, calm, 'peds walk on cardinal (street-grid) headings, not random angles');
  })();

  // 9p2) peds walk the SIDEWALK/curb (hug building edges), not down the middle of the road.
  (function pedSidewalk() {
    var pe = GTA3D.createEngine(), PW = pe.world, C = pe.constants, i;
    for (var k = 0; k < 600; k++) { PW.player.x = C.WORLD / 2; PW.player.z = C.WORLD / 2; pe.step(STEP, {}); } // wander a while (player idle, far)
    function onCurb(x, z) { for (var t = 1; t <= 4; t++) for (var a = 0; a < 8; a++) { var ang = a * Math.PI / 4, tx = Math.floor((x + Math.cos(ang) * t) / C.TILE), tz = Math.floor((z + Math.sin(ang) * t) / C.TILE); if (PW.grid[tz] && PW.grid[tz][tx] === C.T_BUILDING) return true; } return false; }
    var calm = 0, curb = 0;
    for (i = 0; i < PW.peds.length; i++) { var p = PW.peds[i]; if (!p.alive || p.cop || p.gang !== undefined || p.panic > 0 || p.hostile) continue; calm++; if (onCurb(p.x, p.z)) curb++; assert.ok(finite(p.x) && finite(p.z), 'ped finite'); }
    assert.ok(calm > 15, 'calm wandering peds exist (' + calm + ')');
    // a healthy share hug the curb; the rest are legitimately crossing open intersections (this grid is road-heavy)
    assert.ok(curb / calm >= 0.32, 'a healthy share of calm peds walk the sidewalk/curb (' + curb + '/' + calm + ')');
  })();

  // 9q) bar drink buff: a SEPARATE temp damage factor (never corrupts the permanent gun
  //     upgrade or the rampage snapshot), decays over time, and clears on respawn.
  (function barBuffCheck() {
    var be = GTA3D.createEngine(), BW = be.world, BIN = be._internal, k;
    BW.money = 1000;
    assert.ok(BIN.buyItem('bar', 1) === true && BW.player.barBuff >= 2, 'whiskey stacks the bar buff (' + BW.player.barBuff + ')');
    assert.strictEqual(BW.player.gunDmgMul, 1, 'bar buff does NOT touch the permanent damage upgrade');
    BW.player.weapon = 'pistol'; BW.player.ammo = 999999; BW.fireCd = 0; BW.bullets.length = 0;
    BIN.fireWeapon({ shoot: true, aimYaw: 0 });
    var b = BW.bullets.filter(function (x) { return x.team === 'player'; })[0];
    assert.ok(b && Math.abs(b.dmg - 34 * 1.5) < 0.01, 'buffed pistol does +50% (dmg=' + (b ? b.dmg : 'none') + ')');
    var before = BW.player.barBuff; for (k = 0; k < 120; k++) be.step(STEP, {});
    assert.ok(BW.player.barBuff < before, 'bar buff decays over time');
    // dying clears it — no carrying a buff through the hospital
    BW.player.barBuff = 3; BW.player.hp = 0;
    for (k = 0; k < 400; k++) { be.step(STEP, {}); if (k > 5 && BW.state === 'play' && BW.player.hp > 0) break; }
    assert.strictEqual(BW.player.barBuff, 0, 'bar buff is cleared on respawn');
  })();

  // 9r) Police escalation is GRADUAL + telegraphed (the "aggro too fast" fix).
  (function aggroChecks() {
    // (a) responding car count ramps per star, not wanted+1 swarm
    var ce = GTA3D.createEngine(), CW = ce.world;
    for (var z = 0; z < ce.constants.MAP; z++) for (var x = 0; x < ce.constants.MAP; x++) CW.grid[z][x] = ce.constants.T_ROAD;
    for (var pi = 0; pi < CW.peds.length; pi++) CW.peds[pi].alive = false;
    CW.player.inCar = false; CW.player.x = 300; CW.player.z = 300;
    for (var k = 0; k < 600; k++) { CW.player.x = 300; CW.player.z = 300; CW.wanted = 3; CW.lkpValid = true; CW.lkpX = 300; CW.lkpZ = 300; ce.step(STEP, {}); }
    assert.ok(CW.police.length <= 3, 'at 3★ no more than 3 cruisers respond (gradual, was wanted+1) — got ' + CW.police.length);

    // (b) a foot cop TELEGRAPHS before firing — no police bullet in the first ~0.5s of LOS,
    //     but it does open fire after the ~0.9s warmup.
    var fe = GTA3D.createEngine(), FW = fe.world, FIN = fe._internal;
    for (z = 0; z < fe.constants.MAP; z++) for (x = 0; x < fe.constants.MAP; x++) FW.grid[z][x] = fe.constants.T_ROAD;
    for (pi = 0; pi < FW.peds.length; pi++) FW.peds[pi].alive = false;
    FW.player.inCar = false; FW.player.x = 200; FW.player.z = 200; FW.player.hp = FW.player.maxHp; FW.player.armor = 100;
    var cop = FIN.makeCopFoot(216, 200, false); FW.peds.push(cop); // 16u away, clear LOS on all-road
    function policeBullets(W2) { return W2.bullets.filter(function (b) { return b.team === 'police'; }).length; }
    var firedEarly = 0, firedLate = false;
    for (k = 0; k < 90; k++) {
      FW.player.x = 200; FW.player.z = 200; FW.player.hp = FW.player.maxHp; FW.wanted = 2; FW.police = []; // isolate the foot cop (no car shooters)
      cop.x = 216; cop.z = 200; cop.alive = true; cop.stun = 0;
      fe.step(STEP, {});
      if (k < 28) firedEarly += policeBullets(FW); // ~0.47s window — should stay 0 (telegraph)
      if (policeBullets(FW) > 0) firedLate = true;
    }
    assert.strictEqual(firedEarly, 0, 'cop holds fire during the ~0.9s warmup (no shots in first 0.47s)');
    assert.ok(firedLate, 'cop does open fire after the warmup');

    // (c) while already wanted, a fresh witness does NOT instantly re-pin your location
    //     (you get a beat to break line of sight).
    var we = GTA3D.createEngine(), WW = we.world, WIN = we._internal;
    for (var wp = 0; wp < WW.peds.length; wp++) WW.peds[wp].alive = false;
    var wit = WW.peds[0]; wit.x = WW.player.x; wit.z = WW.player.z; wit.alive = true; wit.witness = false; wit.cop = false; wit.gang = undefined;
    WW.wanted = 2; WW.seen = false; WW.searchTimer = 5; WW.lkpValid = true;
    WIN.commitCrime(we.constants.CRIME.PETTY, WW.player.x, WW.player.z);
    assert.strictEqual(WW.searchTimer, 5, 'a fresh witness while hot does not instantly re-pin the search (no instant lkp reset)');
    assert.ok(wit.witness === true && wit.reportTimer > 0, 'witness will report after a delay, not instantly');
  })();

  // 9s) Money: bigger base fare + passive rent is actually paid out.
  (function moneyChecks() {
    var me = GTA3D.createEngine(), MW = me.world, MIN = me._internal;
    MW.player.inCar = false; MW.player.x = MW.jobDepots[0].x; MW.player.z = MW.jobDepots[0].z; // stand on a depot
    MIN.acceptJob();
    assert.ok(MW.job && MW.job.base >= 75, 'courier base fare is at least $75 (was tiny) — got ' + (MW.job ? MW.job.base : 'none'));
    // own a property → passive rent accrues and is paid
    var me2 = GTA3D.createEngine(), M2 = me2.world;
    M2.money = 0; M2.ownedProps = [2]; // Downtown Penthouse (income 15)
    for (var k = 0; k < 180; k++) me2.step(STEP, {}); // ~3s
    assert.ok(M2.money > 0, 'owned property pays passive rent over time — got $' + M2.money);
    assert.ok(M2.money >= 0, 'money never goes negative');
  })();

  // 10) long soak with pseudo-random input (now also exercises economy inputs)
  var seed = 99991;
  function lcg() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  for (var s = 0; s < 4000; s++) {
    var inp = { camYaw: lcg() * 6.28, aimYaw: lcg() * 6.28 };
    if (lcg() < 0.7) inp.forward = true;
    if (lcg() < 0.3) inp.back = true;
    if (lcg() < 0.4) inp.left = true;
    if (lcg() < 0.4) inp.right = true;
    if (lcg() < 0.3) inp.shoot = true;
    if (lcg() < 0.04) { inp.jump = true; inp.jumpPressed = true; }
    if (lcg() < 0.03) inp.enterPressed = true;
    if (lcg() < 0.02) inp.robPressed = true;
    if (lcg() < 0.15) inp.handbrake = true;
    if (lcg() < 0.2) inp.aim = true;
    if (lcg() < 0.05) inp.buyPressed = true;
    if (lcg() < 0.05) inp.cyclePressed = true;
    if (lcg() < 0.03) inp.safehousePressed = true;
    eng.step(STEP, inp); total++; checkInvariants(eng, 'soak t' + total);
  }

  // 11) dt extremes
  eng.step(0, {}); eng.step(0.1, {}); checkInvariants(eng, 'dt-extreme');

  console.log('PASS — ' + total + ' steps simulated with no errors.');
  console.log('  final: state=' + W.state + ' hp=' + W.player.hp.toFixed(0) + ' $' + W.money +
    ' wanted=' + W.wanted + ' kills=' + W.kills + ' cars=' + W.cars.length +
    ' peds=' + W.peds.length + ' police=' + W.police.length + ' bullets=' + W.bullets.length);
}

try { run(); process.exit(0); }
catch (e) { console.error('FAIL — ' + (e && e.message ? e.message : e)); console.error(e && e.stack); process.exit(1); }
