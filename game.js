/* =============================================================================
 * GTA 7: JS — "Leonida Script"  (v2.0 — systemic edition)
 * A complete top-down open-world crime sandbox in pure JavaScript.
 *
 * No frameworks, no build step. Open index.html in any modern browser.
 *
 * Systemic design (mirroring a GTA 6-style breakdown):
 *   1. Core loop: action -> heat -> evade -> cash -> progression.
 *   2. Witness-based dynamic wanted system (not a numeric threshold):
 *      crimes need a witness with line-of-sight; witnesses report after a
 *      delay; silence or out-run them. Police track a Last-Known-Position and
 *      search by line-of-sight; break LOS / swap vehicles to shed the heat.
 *   3. Verbs beyond violence: greet / antagonize / rob (context-sensitive).
 *   4. The "Mirror System": a reactive social-media feed (Bleeter).
 *   5. Density zones: dense urban Vice City vs. the sparse, hazardous
 *      Everglades (deep water that drowns the unwary).
 *   6. Dual protagonists (Jason & Lucia) with a shared economy; swap at will.
 *   7. Flexible heist: rob the bank, then improvise an escape; the longer the
 *      cops keep eyes on you, the smaller the payout.
 *
 * Architecture: a single createGame(canvas) factory returns a self-contained
 * instance. It touches no DOM globals at load time, so the same file runs in
 * the browser AND can be required in Node for headless simulation testing.
 * ============================================================================= */
(function () {
  'use strict';

  /* ----------------------------- Configuration ---------------------------- */
  var TILE = 56;            // pixel size of one map tile
  var MAP_W = 56;           // map width in tiles
  var MAP_H = 56;           // map height in tiles
  var WORLD_W = TILE * MAP_W;
  var WORLD_H = TILE * MAP_H;

  // Tile types
  var T_ROAD = 0;
  var T_BUILDING = 1;
  var T_PARK = 2;
  var T_WATER = 3;

  var EVERGLADES_ROW = Math.floor(MAP_H * 0.60); // rows below this are rural/swamp

  // Player (on foot)
  var PLAYER_SPEED = 175;   // px/s
  var PLAYER_RADIUS = 11;
  var PLAYER_MAX_HP = 100;

  // Weapon
  var BULLET_SPEED = 780;
  var BULLET_LIFE = 0.85;   // seconds
  var FIRE_COOLDOWN = 0.16; // seconds between shots
  var BULLET_DMG = 34;

  // Car physics
  var CAR_LEN = 50, CAR_WID = 26;
  var CAR_ACCEL = 340;      // forward accel px/s^2
  var CAR_REVERSE = 200;
  var CAR_MAX = 380;        // top forward speed px/s
  var CAR_MAX_REV = 150;
  var CAR_DRAG = 0.9;       // velocity damping per second (coasting)
  var CAR_BRAKE = 520;
  var CAR_TURN = 3.1;       // steering rate scale (rad/s at full speed)

  // Pedestrians / traffic / police
  var NUM_PEDS = 46;
  var NUM_TRAFFIC = 20;
  var PED_SPEED = 46;
  var TRAFFIC_SPEED = 135;
  var POLICE_SPEED = 300;
  var POLICE_FIRE_RANGE = 360;
  var POLICE_FIRE_CD = 1.1;
  var POLICE_BULLET_DMG = 9;
  var POLICE_SIGHT = 450;   // how far police can visually acquire the suspect

  // Witness-based wanted system
  var WANTED_MAX = 5;
  var WITNESS_RANGE = 300;  // a crime within this range (with LOS) is witnessed
  var REPORT_DELAY = 3.0;   // seconds a witness takes to call it in (silence them!)
  var SEARCH_GIVEUP = 8.0;  // seconds out of police sight to shed one star
  var DISGUISE_CD = 6.0;    // min seconds between vehicle-swap heat drops

  // Social feed
  var FEED_LIFE = 9.0;      // seconds a Bleet stays before fading out

  var CAR_COLORS = ['#c0392b', '#2980b9', '#27ae60', '#f39c12', '#8e44ad',
                    '#16a085', '#d35400', '#2c3e50', '#7f8c8d', '#e84393'];

  var TWO_PI = Math.PI * 2;

  /* ------------------------------- Utilities ------------------------------ */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function randInt(a, b) { return (a + Math.floor(Math.random() * (b - a + 1))); }
  function choice(arr) { return arr[(Math.random() * arr.length) | 0]; }
  function dist2(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
  function dist(ax, ay, bx, by) { return Math.sqrt(dist2(ax, ay, bx, by)); }

  // Shortest signed angular difference (b - a) normalized to [-PI, PI].
  function angDiff(a, b) {
    var d = (b - a) % TWO_PI;
    if (d > Math.PI) d -= TWO_PI;
    if (d < -Math.PI) d += TWO_PI;
    return d;
  }
  // Rotate angle a toward angle b by at most maxStep.
  function angTowards(a, b, maxStep) {
    var d = angDiff(a, b);
    if (d > maxStep) d = maxStep;
    if (d < -maxStep) d = -maxStep;
    return a + d;
  }

  // Deterministic per-cell pseudo-random in [0,1) (stable across frames).
  function hash2(a, b) {
    var h = (a * 374761393 + b * 668265263) | 0;
    h = (h ^ (h >> 13)) * 1274126177;
    h ^= h >> 16;
    return ((h >>> 0) % 100000) / 100000;
  }

  /* ----------------------------- World creation --------------------------- */
  // Roads form a grid: two-tile-wide lanes every 6 tiles, blocks of 4x4 between.
  function isRoadLane(x, y) {
    return (x % 6 < 2) || (y % 6 < 2);
  }

  function generateGrid() {
    var grid = new Array(MAP_H);
    for (var y = 0; y < MAP_H; y++) {
      grid[y] = new Array(MAP_W);
      for (var x = 0; x < MAP_W; x++) {
        if (isRoadLane(x, y)) {
          grid[y][x] = T_ROAD;
        } else {
          // Interior block tile. Density zones differ: dense urban core vs the
          // sparse, green, water-logged Everglades to the south.
          var bx = (x / 6) | 0, by = (y / 6) | 0;
          if (y >= EVERGLADES_ROW) {
            var r = hash2(bx + 3, by + 5);
            if (r < 0.42) grid[y][x] = T_PARK;        // lush greenery
            else if (r < 0.64) grid[y][x] = T_WATER;  // swamp / deep water
            else grid[y][x] = T_BUILDING;             // sparse stilt houses
          } else {
            var park = hash2(bx + 7, by + 11) < 0.16;
            grid[y][x] = park ? T_PARK : T_BUILDING;
          }
        }
      }
    }
    return grid;
  }

  /* --------------------------------- Game --------------------------------- */
  function createGame(canvas, opts) {
    opts = opts || {};
    var ctx = canvas.getContext('2d');

    var hasWindow = (typeof window !== 'undefined');
    var hasDoc = (typeof document !== 'undefined');

    var g = {
      state: 'menu',          // 'menu' | 'play' | 'wasted'
      time: 0,
      grid: generateGrid(),
      view: { w: canvas.width || 960, h: canvas.height || 540 },
      cam: { x: 0, y: 0 },
      keys: {},
      justPressed: {},
      mouse: { x: 0, y: 0, wx: 0, wy: 0, down: false },

      // dual protagonists
      chars: [],
      active: 0,
      player: null,           // === chars[active]
      playerCar: null,
      starterCar: null,

      cars: [],               // parked + traffic + player car (driver: null|'ai'|'player')
      peds: [],
      police: [],
      bullets: [],
      pickups: [],
      particles: [],

      // witness-based wanted / law system
      wanted: 0,
      lkpX: 0, lkpY: 0, lkpValid: false, // police Last-Known-Position
      seen: false,                       // is a cop currently looking at the suspect?
      searchTimer: 0,                    // seconds since last seen
      disguiseCd: 0,                     // cooldown on vehicle-swap heat drops

      money: 0,
      kills: 0,
      fireCd: 0,
      enterCd: 0,
      respawnTimer: 0,

      feed: [],               // Bleeter social feed (the "Mirror System")
      heist: null,            // the bank-robbery score

      message: '',
      messageTimer: 0,
      flash: 0
    };

    /* ----- Map helpers ----- */
    function tileType(tx, ty) {
      if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return T_BUILDING; // world edge = wall
      return g.grid[ty][tx];
    }
    function tileTypeAt(px, py) { return tileType(Math.floor(px / TILE), Math.floor(py / TILE)); }
    function isSolidTile(tx, ty) { return tileType(tx, ty) === T_BUILDING; }
    function isSolidAt(px, py) { return isSolidTile(Math.floor(px / TILE), Math.floor(py / TILE)); }
    // Vehicles physically clip only on buildings, but AI prefers to avoid water.
    function aiAvoid(px, py) { var t = tileTypeAt(px, py); return t === T_BUILDING || t === T_WATER; }

    // Line of sight: clear unless a solid building blocks the segment a->b.
    function lineOfSight(ax, ay, bx, by) {
      var d = dist(ax, ay, bx, by);
      if (d < 1) return true;
      var steps = Math.ceil(d / (TILE * 0.5));
      for (var s = 1; s < steps; s++) {
        var t = s / steps;
        if (isSolidAt(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
      }
      return true;
    }

    // Circle (px,py,r) vs solid tiles. Tests the closest point of each nearby
    // solid tile rect to the circle center.
    function circleHitsSolid(px, py, r) {
      var minTx = Math.floor((px - r) / TILE);
      var maxTx = Math.floor((px + r) / TILE);
      var minTy = Math.floor((py - r) / TILE);
      var maxTy = Math.floor((py + r) / TILE);
      for (var ty = minTy; ty <= maxTy; ty++) {
        for (var tx = minTx; tx <= maxTx; tx++) {
          if (!isSolidTile(tx, ty)) continue;
          var rx = clamp(px, tx * TILE, tx * TILE + TILE);
          var ry = clamp(py, ty * TILE, ty * TILE + TILE);
          var dx = px - rx, dy = py - ry;
          if (dx * dx + dy * dy < r * r) return true;
        }
      }
      return false;
    }

    // Move a circular entity to (nx,ny), resolving collisions per-axis so it
    // slides along walls instead of sticking. Clamps to world bounds.
    function moveCircle(ent, nx, ny, r) {
      var x = ent.x, y = ent.y;
      if (!circleHitsSolid(nx, y, r)) x = nx;
      if (!circleHitsSolid(x, ny, r)) y = ny;
      ent.x = clamp(x, r, WORLD_W - r);
      ent.y = clamp(y, r, WORLD_H - r);
    }

    // Car body collision: sample 4 corners + center against solid tiles.
    function carHitsSolid(cx, cy, angle) {
      var co = Math.cos(angle), si = Math.sin(angle);
      var hl = CAR_LEN / 2, hw = CAR_WID / 2;
      var pts = [
        [hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw], [0, 0], [hl, 0], [-hl, 0]
      ];
      for (var i = 0; i < pts.length; i++) {
        var lx = pts[i][0], ly = pts[i][1];
        var wx = cx + lx * co - ly * si;
        var wy = cy + lx * si + ly * co;
        if (isSolidAt(wx, wy)) return true;
      }
      return false;
    }

    function tryMoveCar(car, nx, ny) {
      if (!carHitsSolid(nx, ny, car.angle)) { car.x = nx; car.y = ny; return true; }
      if (!carHitsSolid(nx, car.y, car.angle)) { car.x = nx; car.speed *= 0.55; return true; }
      if (!carHitsSolid(car.x, ny, car.angle)) { car.y = ny; car.speed *= 0.55; return true; }
      car.speed *= -0.22; // nose-on impact: bounce back, lose most speed
      return false;
    }

    function randomRoadPoint() {
      for (var i = 0; i < 400; i++) {
        var tx = randInt(2, MAP_W - 3), ty = randInt(2, MAP_H - 3);
        if (tileType(tx, ty) === T_ROAD) {
          return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2 };
        }
      }
      return { x: WORLD_W / 2, y: WORLD_H / 2 };
    }
    // Bias spawns to the dense urban core (the Everglades stays sparse).
    function urbanRoadPoint() {
      for (var i = 0; i < 30; i++) {
        var p = randomRoadPoint();
        if (Math.floor(p.y / TILE) < EVERGLADES_ROW || Math.random() < 0.25) return p;
      }
      return randomRoadPoint();
    }
    function roadPointNear(cx, cy, minD, maxD) {
      for (var i = 0; i < 140; i++) {
        var p = randomRoadPoint();
        var d = dist(p.x, p.y, cx, cy);
        if (d >= minD && d <= maxD) return p;
      }
      return null;
    }

    function districtName(x, y) {
      var ty = Math.floor(y / TILE), tx = Math.floor(x / TILE);
      if (ty >= EVERGLADES_ROW) return 'the Everglades';
      if (tx < MAP_W / 2 && ty < MAP_H / 2) return 'Vice Beach';
      if (tx >= MAP_W / 2 && ty < MAP_H / 2) return 'Downtown';
      if (tx < MAP_W / 2) return 'Little Havana';
      return 'the Docks';
    }

    /* ----- Entity factories ----- */
    function makeChar(name, x, y, color) {
      return {
        kind: 'player', name: name, x: x, y: y, angle: 0,
        hp: PLAYER_MAX_HP, inCar: false, color: color, car: null
      };
    }
    function makeCar(x, y, driver) {
      return {
        kind: 'car', x: x, y: y, angle: 0, speed: 0,
        color: choice(CAR_COLORS), driver: driver || null,
        hp: 100, aiDir: choice([0, Math.PI / 2, Math.PI, -Math.PI / 2]),
        aiRetarget: rand(0.5, 2.0)
      };
    }
    function makePed(x, y) {
      return {
        kind: 'ped', x: x, y: y, angle: rand(0, TWO_PI),
        speed: 0, dir: rand(0, TWO_PI), think: rand(0.3, 2),
        hp: 30, alive: true, deadTimer: 0,
        color: 'hsl(' + ((Math.random() * 360) | 0) + ',45%,55%)',
        panic: 0, witness: false, reportTimer: 0, reportLevel: 0, robbedCd: 0
      };
    }
    function makePolice(x, y) {
      var c = makeCar(x, y, 'police');
      c.color = '#101820';
      c.hp = 140;
      c.fireCd = rand(0.2, POLICE_FIRE_CD);
      c.spotted = false;
      c.searchDir = rand(0, TWO_PI);
      c.searchRetarget = rand(0.5, 2);
      return c;
    }
    function makeBullet(x, y, angle, team) {
      return {
        x: x, y: y, vx: Math.cos(angle) * BULLET_SPEED, vy: Math.sin(angle) * BULLET_SPEED,
        life: BULLET_LIFE, team: team
      };
    }
    function makePickup(x, y, type) { return { x: x, y: y, type: type, t: 0 }; }
    function makeParticle(x, y, color, vx, vy, life, size) {
      return { x: x, y: y, vx: vx, vy: vy, life: life, max: life, color: color, size: size };
    }

    function burst(x, y, color, n, speed) {
      for (var i = 0; i < n; i++) {
        var a = rand(0, TWO_PI), s = rand(speed * 0.3, speed);
        g.particles.push(makeParticle(x, y, color, Math.cos(a) * s, Math.sin(a) * s,
          rand(0.25, 0.6), rand(2, 4)));
      }
    }

    /* ----- The Mirror System (social feed) ----- */
    function post(who, text) {
      g.feed.push({ who: who, text: text, t: 0 });
      if (g.feed.length > 8) g.feed.shift();
    }
    function ageFeed(dt) {
      for (var i = 0; i < g.feed.length; i++) g.feed[i].t += dt;
      while (g.feed.length && g.feed[0].t > FEED_LIFE) g.feed.shift();
    }

    /* ----- World population ----- */
    function populate() {
      g.cars.length = 0; g.peds.length = 0; g.police.length = 0;
      g.bullets.length = 0; g.pickups.length = 0; g.particles.length = 0;

      var i, p;
      for (i = 0; i < NUM_TRAFFIC; i++) {
        p = urbanRoadPoint();
        var car = makeCar(p.x, p.y, 'ai');
        car.angle = car.aiDir;
        g.cars.push(car);
      }
      for (i = 0; i < 10; i++) { // parked cars
        p = urbanRoadPoint();
        var pk = makeCar(p.x, p.y, null);
        pk.angle = choice([0, Math.PI / 2, Math.PI, -Math.PI / 2]);
        g.cars.push(pk);
      }
      for (i = 0; i < NUM_PEDS; i++) {
        p = urbanRoadPoint();
        g.peds.push(makePed(p.x, p.y));
      }
      for (i = 0; i < 26; i++) { p = randomRoadPoint(); g.pickups.push(makePickup(p.x, p.y, 'cash')); }
      for (i = 0; i < 7; i++) { p = randomRoadPoint(); g.pickups.push(makePickup(p.x, p.y, 'health')); }
    }

    function spawnChars() {
      var p = urbanRoadPoint();
      var jason = makeChar('Jason', p.x, p.y, '#f6d35b');
      var p2 = roadPointNear(p.x, p.y, 60, 300) || urbanRoadPoint();
      var lucia = makeChar('Lucia', p2.x, p2.y, '#ff7ad9');
      g.chars = [jason, lucia];
      g.active = 0;
      g.player = jason;
      g.playerCar = null;
      // park a starter car next to Jason
      var car = makeCar(p.x + 46, p.y, null);
      car.angle = 0;
      if (!carHitsSolid(car.x, car.y, car.angle)) { g.cars.push(car); g.starterCar = car; }
    }

    // Hospital respawn affects only the active protagonist; the other stays put.
    function respawnActive() {
      var c = g.player;
      if (c.inCar && g.playerCar) { g.playerCar.driver = null; }
      var p = urbanRoadPoint();
      c.x = p.x; c.y = p.y; c.hp = PLAYER_MAX_HP; c.inCar = false; c.car = null;
      g.playerCar = null;
    }

    function findStoreHeist() {
      var cx = Math.floor(MAP_W * 0.5), cy = Math.floor(MAP_H * 0.28);
      for (var r = 0; r < 22; r++) {
        for (var dy = -r; dy <= r; dy++) {
          for (var dx = -r; dx <= r; dx++) {
            var tx = cx + dx, ty = cy + dy;
            if (tileType(tx, ty) === T_ROAD && tileType(tx, ty - 1) === T_BUILDING) {
              return { x: tx * TILE + TILE / 2, y: ty * TILE + TILE / 2,
                       state: 'ready', cooldown: 0, pot: 0 };
            }
          }
        }
      }
      var p = randomRoadPoint();
      return { x: p.x, y: p.y, state: 'ready', cooldown: 0, pot: 0 };
    }

    function resetWorld() {
      g.grid = generateGrid();
      g.wanted = 0; g.money = 0; g.kills = 0;
      g.fireCd = 0; g.enterCd = 0; g.respawnTimer = 0;
      g.lkpValid = false; g.lkpX = 0; g.lkpY = 0; g.seen = false; g.searchTimer = 0; g.disguiseCd = 0;
      g.feed = []; g.starterCar = null;
      populate();
      spawnChars();
      g.heist = findStoreHeist();
      post('@LeonidaWeekly', 'Welcome to Leonida. Sun, crime & chaos. 🌴');
    }

    function showMessage(txt, secs) { g.message = txt; g.messageTimer = secs || 2.2; }

    /* ----- Witness-based wanted system ----- */
    function alertPolice(level, x, y) {
      var was = g.wanted;
      g.wanted = clamp(Math.max(g.wanted, level), 0, WANTED_MAX);
      g.lkpX = x; g.lkpY = y; g.lkpValid = true; g.searchTimer = 0;
      if (was === 0) {
        post('@LeonidaPD', 'Dispatch: suspect reported in ' + districtName(x, y) +
          '. (' + g.wanted + '★)');
      }
    }

    // A crime only escalates heat if someone perceives it. Cold: a witnessing
    // ped starts a report countdown (silence them to stay clean). Hot: a cop's
    // line of sight (or a fresh witness) refreshes the search to the scene.
    function commitCrime(level, x, y) {
      var immediate = g.seen;
      for (var i = 0; i < g.peds.length; i++) {
        var ped = g.peds[i];
        if (!ped.alive) continue;
        if (dist2(ped.x, ped.y, x, y) < WITNESS_RANGE * WITNESS_RANGE &&
            lineOfSight(ped.x, ped.y, x, y)) {
          ped.panic = Math.max(ped.panic, 3);
          if (g.wanted >= 1) {
            immediate = true;
          } else if (!ped.witness) {
            ped.witness = true;
            ped.reportTimer = REPORT_DELAY;
            ped.reportLevel = Math.max(ped.reportLevel, level);
          }
        }
      }
      if (g.wanted >= 1) {
        g.wanted = clamp(Math.max(g.wanted, level), 0, WANTED_MAX);
        if (immediate) { g.lkpX = x; g.lkpY = y; g.lkpValid = true; g.searchTimer = 0; }
      }
    }

    /* ----- Input edge detection ----- */
    function pressed(code) { return !!g.justPressed[code]; }

    /* ---------------------------- Update logic --------------------------- */
    function updatePlayerOnFoot(dt) {
      var p = g.player;
      var mx = 0, my = 0;
      if (g.keys['KeyW'] || g.keys['ArrowUp']) my -= 1;
      if (g.keys['KeyS'] || g.keys['ArrowDown']) my += 1;
      if (g.keys['KeyA'] || g.keys['ArrowLeft']) mx -= 1;
      if (g.keys['KeyD'] || g.keys['ArrowRight']) mx += 1;
      if (mx || my) {
        var len = Math.sqrt(mx * mx + my * my);
        mx /= len; my /= len;
        var slow = (tileTypeAt(p.x, p.y) === T_WATER) ? 0.45 : 1; // wading
        moveCircle(p, p.x + mx * PLAYER_SPEED * slow * dt, p.y + my * PLAYER_SPEED * slow * dt, PLAYER_RADIUS);
      }
      p.angle = Math.atan2(g.mouse.wy - p.y, g.mouse.wx - p.x); // aim toward mouse
    }

    function updatePlayerCar(dt) {
      var car = g.playerCar;
      var up = g.keys['KeyW'] || g.keys['ArrowUp'];
      var down = g.keys['KeyS'] || g.keys['ArrowDown'];
      var left = g.keys['KeyA'] || g.keys['ArrowLeft'];
      var right = g.keys['KeyD'] || g.keys['ArrowRight'];

      if (up) car.speed += CAR_ACCEL * dt;
      else if (down) {
        if (car.speed > 0) car.speed -= CAR_BRAKE * dt;      // brake
        else car.speed -= CAR_REVERSE * dt;                  // reverse
      } else {
        car.speed *= Math.max(0, 1 - CAR_DRAG * dt);         // coast
        if (Math.abs(car.speed) < 3) car.speed = 0;
      }
      car.speed = clamp(car.speed, -CAR_MAX_REV, CAR_MAX);

      var steer = (right ? 1 : 0) - (left ? 1 : 0);
      car.angle += steer * CAR_TURN * dt * (car.speed / CAR_MAX);

      var nx = car.x + Math.cos(car.angle) * car.speed * dt;
      var ny = car.y + Math.sin(car.angle) * car.speed * dt;
      tryMoveCar(car, nx, ny);
      car.x = clamp(car.x, CAR_LEN, WORLD_W - CAR_LEN);
      car.y = clamp(car.y, CAR_LEN, WORLD_H - CAR_LEN);

      g.player.x = car.x; g.player.y = car.y; g.player.angle = car.angle; // ride the car
      runOverPeds(car, true);
    }

    function updateAiCar(car, dt) {
      car.aiRetarget -= dt;
      var ahead = 34;
      var fx = car.x + Math.cos(car.aiDir) * ahead;
      var fy = car.y + Math.sin(car.aiDir) * ahead;
      if (car.aiRetarget <= 0 || aiAvoid(fx, fy)) {
        var dirs = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
        var best = [];
        for (var i = 0; i < dirs.length; i++) {
          var tx = car.x + Math.cos(dirs[i]) * ahead;
          var ty = car.y + Math.sin(dirs[i]) * ahead;
          if (!aiAvoid(tx, ty)) best.push(dirs[i]);
        }
        if (best.length) car.aiDir = choice(best);
        car.aiRetarget = rand(0.8, 2.6);
      }
      car.angle = angTowards(car.angle, car.aiDir, 4 * dt);
      car.speed = lerp(car.speed, TRAFFIC_SPEED, 1 - Math.exp(-2 * dt));
      var nx = car.x + Math.cos(car.angle) * car.speed * dt;
      var ny = car.y + Math.sin(car.angle) * car.speed * dt;
      if (!tryMoveCar(car, nx, ny)) { car.aiRetarget = 0; }
    }

    function respawnPed(ped) {
      var p = urbanRoadPoint();
      ped.x = p.x; ped.y = p.y;
      ped.alive = true; ped.hp = 30; ped.panic = 0; ped.deadTimer = 0;
      ped.witness = false; ped.reportTimer = 0; ped.reportLevel = 0; ped.robbedCd = 0;
      ped.dir = rand(0, TWO_PI); ped.speed = 0; ped.think = rand(0.4, 2);
    }

    function updatePed(ped, dt) {
      if (ped.__track && typeof globalThis !== 'undefined' && globalThis.__DTS) globalThis.__DTS.push(dt);
      if (!ped.alive) {
        ped.deadTimer -= dt;
        if (ped.deadTimer <= 0) respawnPed(ped);
        return;
      }
      if (ped.robbedCd > 0) ped.robbedCd -= dt;

      // witness reporting: a bystander who saw a crime calls it in after a delay
      if (ped.witness) {
        var __b = ped.reportTimer;
        ped.reportTimer -= dt;
        if (ped.__track && typeof globalThis !== 'undefined' && globalThis.__L) globalThis.__L.push([+__b.toFixed(3), +ped.reportTimer.toFixed(3), +dt.toFixed(4)]);
        if (ped.reportTimer <= 0) {
          ped.witness = false;
          alertPolice(ped.reportLevel || 1, ped.x, ped.y);
          post('witness', '📞 "He went that way, officer!" — a bystander called it in.');
        }
      }

      ped.think -= dt;
      if (ped.panic > 0) {
        ped.panic -= dt;
        ped.dir = Math.atan2(ped.y - g.player.y, ped.x - g.player.x); // flee from player
        ped.speed = PED_SPEED * 2.1;
      } else if (ped.think <= 0) {
        ped.think = rand(0.6, 2.4);
        if (Math.random() < 0.25) ped.speed = 0;
        else { ped.dir = rand(0, TWO_PI); ped.speed = PED_SPEED; }
      }
      if (ped.speed > 0) {
        ped.angle = ped.dir;
        var nx = ped.x + Math.cos(ped.dir) * ped.speed * dt;
        var ny = ped.y + Math.sin(ped.dir) * ped.speed * dt;
        var before = ped.x + ped.y;
        moveCircle(ped, nx, ny, 8);
        if (Math.abs((ped.x + ped.y) - before) < 0.01 && ped.panic <= 0) {
          ped.dir = rand(0, TWO_PI); // bumped a wall, pick new heading
        }
      }
    }

    function runOverPeds(car, byPlayer) {
      var speed = Math.abs(car.speed);
      if (speed < 60) return;
      for (var i = 0; i < g.peds.length; i++) {
        var ped = g.peds[i];
        if (!ped.alive) continue;
        if (dist2(car.x, car.y, ped.x, ped.y) < (CAR_LEN * 0.55) * (CAR_LEN * 0.55)) {
          killPed(ped, byPlayer);
          if (byPlayer) car.speed *= 0.86;
        } else if (dist2(car.x, car.y, ped.x, ped.y) < 160 * 160) {
          ped.panic = 2.5;
        }
      }
    }

    function killPed(ped, byPlayer) {
      if (!ped.alive) return;
      var wasWitness = ped.witness;
      ped.alive = false;
      ped.witness = false;
      ped.deadTimer = rand(6, 10);
      burst(ped.x, ped.y, '#b0203a', 14, 200);
      if (byPlayer) {
        g.kills++;
        g.money += randInt(8, 30);
        if (wasWitness) post('@you', '🤫 Silenced a witness. No report filed.');
        commitCrime(2, ped.x, ped.y); // murder is witnessed by anyone else nearby
      }
    }

    function fireWeapon() {
      if (g.fireCd > 0) return;
      g.fireCd = FIRE_COOLDOWN;
      var p = g.player;
      var a = p.angle;
      var ox = p.x + Math.cos(a) * (p.inCar ? CAR_LEN * 0.6 : PLAYER_RADIUS + 6);
      var oy = p.y + Math.sin(a) * (p.inCar ? CAR_LEN * 0.6 : PLAYER_RADIUS + 6);
      g.bullets.push(makeBullet(ox, oy, a + rand(-0.03, 0.03), 'player'));
      burst(ox, oy, '#ffd27f', 4, 120);
      g.flash = 0.05;
      for (var i = 0; i < g.peds.length; i++) {
        var ped = g.peds[i];
        if (ped.alive && dist2(ped.x, ped.y, p.x, p.y) < 240 * 240) ped.panic = 3;
      }
      commitCrime(1, p.x, p.y); // discharging a firearm in public is a witnessed crime
      sfxShot();
    }

    function updateBullets(dt) {
      for (var i = g.bullets.length - 1; i >= 0; i--) {
        var b = g.bullets[i];
        b.life -= dt;
        b.x += b.vx * dt; b.y += b.vy * dt;
        var dead = false;
        if (b.life <= 0 || b.x < 0 || b.y < 0 || b.x > WORLD_W || b.y > WORLD_H) dead = true;
        else if (isSolidAt(b.x, b.y)) { burst(b.x, b.y, '#cccccc', 4, 90); dead = true; }

        if (!dead && b.team === 'player') {
          for (var j = 0; j < g.peds.length && !dead; j++) {
            var ped = g.peds[j];
            if (ped.alive && dist2(b.x, b.y, ped.x, ped.y) < 14 * 14) {
              ped.hp -= BULLET_DMG;
              ped.panic = 3;
              burst(b.x, b.y, '#b0203a', 6, 140);
              if (ped.hp <= 0) killPed(ped, true);
              dead = true;
            }
          }
          for (var k = 0; k < g.police.length && !dead; k++) {
            var pol = g.police[k];
            if (dist2(b.x, b.y, pol.x, pol.y) < (CAR_WID) * (CAR_WID)) {
              pol.hp -= BULLET_DMG;
              burst(b.x, b.y, '#ffcc55', 6, 150);
              dead = true;
            }
          }
        } else if (!dead && b.team === 'police') {
          var pl = g.player;
          var rr = pl.inCar ? CAR_WID : PLAYER_RADIUS + 4;
          if (dist2(b.x, b.y, pl.x, pl.y) < rr * rr) {
            hurtPlayer(POLICE_BULLET_DMG, 0.12);
            burst(b.x, b.y, '#ff5555', 6, 150);
            dead = true;
          }
        }
        if (dead) g.bullets.splice(i, 1);
      }
    }

    function hurtPlayer(n, flashAmt) {
      if (g.state !== 'play') return;
      g.player.hp -= n;
      if (flashAmt) g.flash = Math.min(0.4, g.flash + flashAmt);
      if (g.player.hp <= 0) { g.player.hp = 0; wasted(); }
    }

    function wasted() {
      if (g.state !== 'play') return;
      g.state = 'wasted';
      g.respawnTimer = 2.6;
      showMessage('WASTED', 2.6);
      burst(g.player.x, g.player.y, '#b0203a', 26, 240);
      if (g.player.inCar && g.playerCar) {
        g.playerCar.driver = null; g.player.inCar = false; g.player.car = null; g.playerCar = null;
      }
      if (g.heist && g.heist.state === 'escaping') {
        g.heist.state = 'cooldown'; g.heist.cooldown = 20; g.heist.pot = 0;
        post('@LeonidaPD', 'Suspect down. The score is recovered.');
      }
    }

    /* ----- Police: search by Last-Known-Position, acquire by line of sight ----- */
    function managePolice(dt) {
      var want = g.wanted >= 1 ? g.wanted + 1 : 0;
      if (g.police.length < want && (g.time % 0.7) < dt) {
        var sx = g.lkpValid ? g.lkpX : g.player.x;
        var sy = g.lkpValid ? g.lkpY : g.player.y;
        var sp = roadPointNear(sx, sy, 480, 1200);
        if (sp) g.police.push(makePolice(sp.x, sp.y));
      }

      g.seen = false;
      for (var i = g.police.length - 1; i >= 0; i--) {
        var pol = g.police[i];
        if (pol.hp <= 0) {
          burst(pol.x, pol.y, '#ff8c1a', 22, 260);
          g.police.splice(i, 1);
          g.money += randInt(20, 60);
          // destroying a pursuer must NOT raise wanted/reset decay or the chase soft-locks
          continue;
        }
        var dl = dist(pol.x, pol.y, g.player.x, g.player.y);
        pol.spotted = (dl < POLICE_SIGHT) && lineOfSight(pol.x, pol.y, g.player.x, g.player.y);
        if (pol.spotted) g.seen = true;
        if (g.wanted === 0 && dl > 1100) { g.police.splice(i, 1); continue; }
        updatePoliceCar(pol, dt);
      }

      // the evasion ladder: in sight -> refresh LKP; out of sight -> shed a star
      if (g.seen) {
        g.lkpX = g.player.x; g.lkpY = g.player.y; g.lkpValid = true; g.searchTimer = 0;
      } else if (g.wanted > 0) {
        g.searchTimer += dt;
        if (g.searchTimer >= SEARCH_GIVEUP) {
          g.searchTimer = 0;
          g.wanted--;
          if (g.wanted <= 0) {
            g.wanted = 0; g.lkpValid = false;
            post('@LeonidaPD', 'Lost visual. Suspect at large. 🚔💨');
          } else {
            post('@LeonidaPD', 'Search narrowing... (' + g.wanted + '★)');
          }
        }
      }
    }

    function updatePoliceCar(pol, dt) {
      var tx, ty;
      if (pol.spotted) { tx = g.player.x; ty = g.player.y; }
      else if (g.lkpValid) { tx = g.lkpX; ty = g.lkpY; }
      else { tx = pol.x + Math.cos(pol.searchDir) * 120; ty = pol.y + Math.sin(pol.searchDir) * 120; }

      if (!pol.spotted && dist2(pol.x, pol.y, tx, ty) < 80 * 80) {
        pol.searchRetarget -= dt;
        if (pol.searchRetarget <= 0) { pol.searchDir = rand(0, TWO_PI); pol.searchRetarget = rand(1, 2.5); }
      }

      var desired = Math.atan2(ty - pol.y, tx - pol.x);
      pol.angle = angTowards(pol.angle, desired, 3.2 * dt);
      var targetSpeed = pol.spotted ? POLICE_SPEED : POLICE_SPEED * 0.6;
      pol.speed = lerp(pol.speed, targetSpeed, 1 - Math.exp(-2.4 * dt));

      var nx = pol.x + Math.cos(pol.angle) * pol.speed * dt;
      var ny = pol.y + Math.sin(pol.angle) * pol.speed * dt;
      if (!tryMoveCar(pol, nx, ny)) {
        pol.angle += (hash2((pol.x | 0), (pol.y | 0)) < 0.5 ? 1 : -1) * 1.4 * dt;
      }
      if (tileTypeAt(pol.x, pol.y) === T_WATER) pol.speed *= Math.max(0, 1 - 3 * dt); // bogs down

      if (pol.spotted) {
        var d = dist(pol.x, pol.y, g.player.x, g.player.y);
        if (d < CAR_LEN * 0.7 && Math.abs(pol.speed) > 120) hurtPlayer(14 * dt + 0.2, 0.08);
        pol.fireCd -= dt;
        if (d < POLICE_FIRE_RANGE && pol.fireCd <= 0) {
          pol.fireCd = POLICE_FIRE_CD;
          var a = Math.atan2(g.player.y - pol.y, g.player.x - pol.x) + rand(-0.08, 0.08);
          g.bullets.push(makeBullet(pol.x + Math.cos(a) * CAR_LEN * 0.5,
                                    pol.y + Math.sin(a) * CAR_LEN * 0.5, a, 'police'));
          sfxShot();
        }
      } else if (pol.fireCd < 0.3) {
        pol.fireCd = 0.3;
      }
    }

    /* ----- Pickups ----- */
    function updatePickups(dt) {
      var p = g.player;
      var r = p.inCar ? CAR_LEN * 0.5 : PLAYER_RADIUS + 8;
      for (var i = g.pickups.length - 1; i >= 0; i--) {
        var pk = g.pickups[i];
        pk.t += dt;
        if (dist2(pk.x, pk.y, p.x, p.y) < (r + 10) * (r + 10)) {
          if (pk.type === 'cash') { g.money += randInt(25, 90); burst(pk.x, pk.y, '#39d353', 8, 120); }
          else { p.hp = clamp(p.hp + 35, 0, PLAYER_MAX_HP); burst(pk.x, pk.y, '#ff5d6c', 8, 120); }
          g.pickups.splice(i, 1);
          var np = randomRoadPoint();
          g.pickups.push(makePickup(np.x, np.y, pk.type));
        }
      }
    }

    function updateParticles(dt) {
      for (var i = g.particles.length - 1; i >= 0; i--) {
        var pt = g.particles[i];
        pt.life -= dt;
        pt.x += pt.vx * dt; pt.y += pt.vy * dt;
        pt.vx *= (1 - 3 * dt); pt.vy *= (1 - 3 * dt);
        if (pt.life <= 0) g.particles.splice(i, 1);
      }
    }

    /* ----- Enter / exit car (with description-swap evasion) ----- */
    function tryEnterExit() {
      var p = g.player;
      if (p.inCar) {
        var car = g.playerCar;
        var perp = car.angle + Math.PI / 2;
        var offs = [perp, perp + Math.PI];
        var placed = false;
        for (var i = 0; i < offs.length; i++) {
          var ex = car.x + Math.cos(offs[i]) * (CAR_WID + 8);
          var ey = car.y + Math.sin(offs[i]) * (CAR_WID + 8);
          if (!circleHitsSolid(ex, ey, PLAYER_RADIUS)) { p.x = ex; p.y = ey; placed = true; break; }
        }
        if (!placed) { p.x = car.x; p.y = car.y; }
        p.x = clamp(p.x, PLAYER_RADIUS, WORLD_W - PLAYER_RADIUS);
        p.y = clamp(p.y, PLAYER_RADIUS, WORLD_H - PLAYER_RADIUS);
        car.driver = null; car.speed *= 0.4;
        p.inCar = false; p.car = null; g.playerCar = null;
      } else {
        var best = null, bestD = 60 * 60;
        for (var j = 0; j < g.cars.length; j++) {
          var c = g.cars[j];
          if (c.driver === 'player') continue;
          var d2 = dist2(c.x, c.y, p.x, p.y);
          if (d2 < bestD) { bestD = d2; best = c; }
        }
        if (best) {
          best.driver = 'player'; g.playerCar = best; p.inCar = true; p.car = best;
          // swapping into a different vehicle while unseen throws off the description
          if (g.wanted > 0 && !g.seen && g.disguiseCd <= 0) {
            g.wanted--; g.disguiseCd = DISGUISE_CD; g.lkpValid = false; g.searchTimer = 0;
            post('@you', 'Switched rides. Shook the description. (' + g.wanted + '★)');
          }
        }
      }
    }

    /* ----- Verbs beyond violence ----- */
    function nearestPed(maxD) {
      var best = null, bd = maxD * maxD;
      for (var i = 0; i < g.peds.length; i++) {
        var ped = g.peds[i];
        if (!ped.alive) continue;
        var d = dist2(ped.x, ped.y, g.player.x, g.player.y);
        if (d < bd) { bd = d; best = ped; }
      }
      return best;
    }
    function robNearestPed() {
      var ped = nearestPed(54);
      if (!ped || ped.robbedCd > 0) return;
      var amt = randInt(15, 70);
      g.money += amt; ped.robbedCd = 14; ped.panic = 4;
      post('@you', 'Mugged a local for $' + amt + '. 💸');
      commitCrime(1, ped.x, ped.y); // the victim (and bystanders) can report you
    }
    function greetNearestPed() {
      var ped = nearestPed(54);
      if (!ped) return;
      ped.panic = 0; ped.speed = 0; ped.think = rand(0.6, 1.4);
      if (Math.random() < 0.25) {
        var tip = randInt(2, 12); g.money += tip;
        post('@you', 'Greeted a local — they tipped $' + tip + '. 🤝');
      }
    }
    function antagonizeNearestPed() {
      var ped = nearestPed(54);
      if (!ped) return;
      ped.panic = 3;
      post('@you', 'Antagonized a bystander. They bolted. 😠');
    }

    /* ----- Dual protagonists ----- */
    function switchChar() {
      if (!g.chars || g.chars.length < 2) return;
      if (g.player.inCar) tryEnterExit();       // force the leaving character out of any car
      g.active = 1 - g.active;
      g.player = g.chars[g.active];
      g.playerCar = null; g.player.inCar = false; g.player.car = null;
      g.cam.x = clamp(g.player.x - g.view.w / 2, 0, Math.max(0, WORLD_W - g.view.w));
      g.cam.y = clamp(g.player.y - g.view.h / 2, 0, Math.max(0, WORLD_H - g.view.h));
      post('@you', 'Now playing as ' + g.player.name + '.');
    }

    /* ----- Flexible heist ----- */
    function tryHeist() {
      var hs = g.heist;
      if (!hs || hs.state !== 'ready' || g.player.inCar) return false;
      if (dist2(g.player.x, g.player.y, hs.x, hs.y) > 72 * 72) return false;
      hs.state = 'escaping'; hs.pot = 1200;
      g.money += 300;
      alertPolice(3, hs.x, hs.y);
      burst(hs.x, hs.y, '#39d353', 20, 160);
      post('@you', '💰 Robbed the Vice City Bank! Grab the score and RUN.');
      post('@LeonidaPD', 'Silent alarm Downtown. 3-star response rolling.');
      return true;
    }
    function updateHeist(dt) {
      var hs = g.heist;
      if (!hs) return;
      if (hs.cooldown > 0) { hs.cooldown -= dt; if (hs.cooldown <= 0) hs.state = 'ready'; }
      if (hs.state === 'escaping') {
        hs.pot -= (g.seen ? 80 : 18) * dt; // dynamic failure: getting seen burns the payout
        if (hs.pot < 0) hs.pot = 0;
        if (g.wanted === 0) {
          var bonus = Math.round(hs.pot);
          g.money += bonus;
          post('@you', 'Laundered the score: +$' + bonus + '. Clean getaway. 😎');
          hs.state = 'cooldown'; hs.cooldown = 25; hs.pot = 0;
        }
      }
    }

    /* ------------------------------- Update ------------------------------- */
    function update(dt) {
      g.time += dt;
      if (g.fireCd > 0) g.fireCd -= dt;
      if (g.enterCd > 0) g.enterCd -= dt;
      if (g.disguiseCd > 0) g.disguiseCd -= dt;
      if (g.flash > 0) g.flash = Math.max(0, g.flash - dt);
      if (g.messageTimer > 0) g.messageTimer -= dt;

      if (g.state === 'menu') {
        g.cam.x = (Math.sin(g.time * 0.15) * 0.5 + 0.5) * Math.max(0, WORLD_W - g.view.w);
        g.cam.y = (Math.cos(g.time * 0.12) * 0.5 + 0.5) * Math.max(0, WORLD_H - g.view.h);
        consumePresses();
        return;
      }

      if (g.state === 'wasted') {
        updateParticles(dt);
        ageFeed(dt);
        g.respawnTimer -= dt;
        if (g.respawnTimer <= 0) {
          g.state = 'play';
          g.money = Math.max(0, g.money - 100);
          g.wanted = 0; g.lkpValid = false; g.seen = false; g.searchTimer = 0;
          g.police.length = 0; g.bullets.length = 0;
          respawnActive();
          post('@you', 'Out of the hospital. Lighter wallet.');
        }
        consumePresses();
        return;
      }

      /* state === 'play' */
      if (g.player.hp <= 0) { wasted(); consumePresses(); return; }

      // input
      if (pressed('KeyF') || pressed('Enter')) { if (g.enterCd <= 0) { tryEnterExit(); g.enterCd = 0.25; } }
      if (pressed('KeyQ')) switchChar();
      if (!g.player.inCar) {
        if (pressed('KeyE')) { if (!tryHeist()) robNearestPed(); }
        if (pressed('KeyG')) greetNearestPed();
        if (pressed('KeyH')) antagonizeNearestPed();
      }
      if (g.mouse.down || g.keys['Space']) fireWeapon();

      if (g.player.inCar) updatePlayerCar(dt);
      else updatePlayerOnFoot(dt);

      // water hazard for the active protagonist
      var pt = tileTypeAt(g.player.x, g.player.y);
      if (pt === T_WATER) {
        hurtPlayer((g.player.inCar ? 9 : 20) * dt, 0.015);
        if (g.player.inCar && g.playerCar) g.playerCar.speed *= Math.max(0, 1 - 3.5 * dt);
      }

      var i;
      for (i = 0; i < g.cars.length; i++) {
        if (g.cars[i].driver === 'ai') updateAiCar(g.cars[i], dt);
        else if (g.cars[i].driver === null) g.cars[i].speed *= Math.max(0, 1 - 2 * dt);
      }
      for (i = 0; i < g.peds.length; i++) updatePed(g.peds[i], dt);

      managePolice(dt);
      updateBullets(dt);
      updatePickups(dt);
      updateParticles(dt);
      updateHeist(dt);
      ageFeed(dt);

      updateCamera(dt);
      consumePresses();
    }

    function consumePresses() { g.justPressed = {}; }

    function updateCamera(dt) {
      var tx = g.player.x - g.view.w / 2;
      var ty = g.player.y - g.view.h / 2;
      tx = clamp(tx, 0, Math.max(0, WORLD_W - g.view.w));
      ty = clamp(ty, 0, Math.max(0, WORLD_H - g.view.h));
      var k = 1 - Math.exp(-8 * dt);
      g.cam.x = lerp(g.cam.x, tx, k);
      g.cam.y = lerp(g.cam.y, ty, k);
      g.mouse.wx = g.mouse.x + g.cam.x;
      g.mouse.wy = g.mouse.y + g.cam.y;
    }

    /* -------------------------------- Render ------------------------------ */
    function render() {
      var w = g.view.w, h = g.view.h;
      ctx.fillStyle = '#10131a';
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.translate(-Math.round(g.cam.x), -Math.round(g.cam.y));
      renderWorld();
      renderSearchMarker();
      renderPickups();
      renderHeistMarker();
      renderEntities();
      renderBullets();
      renderParticles();
      ctx.restore();

      renderHUD();

      if (g.flash > 0) {
        ctx.fillStyle = 'rgba(255,40,40,' + (g.flash * 0.9) + ')';
        ctx.fillRect(0, 0, w, h);
      }
      if (g.state === 'menu') renderMenu();
      if (g.state === 'wasted') renderWasted();
    }

    function renderWorld() {
      var minTx = Math.max(0, Math.floor(g.cam.x / TILE));
      var minTy = Math.max(0, Math.floor(g.cam.y / TILE));
      var maxTx = Math.min(MAP_W - 1, Math.ceil((g.cam.x + g.view.w) / TILE));
      var maxTy = Math.min(MAP_H - 1, Math.ceil((g.cam.y + g.view.h) / TILE));

      for (var ty = minTy; ty <= maxTy; ty++) {
        for (var tx = minTx; tx <= maxTx; tx++) {
          var t = g.grid[ty][tx];
          var X = tx * TILE, Y = ty * TILE;
          if (t === T_ROAD) {
            ctx.fillStyle = (ty >= EVERGLADES_ROW) ? '#33403a' : '#33373f';
            ctx.fillRect(X, Y, TILE, TILE);
          } else if (t === T_PARK) {
            ctx.fillStyle = '#274a2b';
            ctx.fillRect(X, Y, TILE, TILE);
            var hp = hash2(tx, ty);
            ctx.fillStyle = '#1c3a20';
            ctx.beginPath();
            ctx.arc(X + TILE * (0.3 + hp * 0.1), Y + TILE * 0.35, 9, 0, TWO_PI);
            ctx.arc(X + TILE * (0.7 - hp * 0.1), Y + TILE * 0.72, 11, 0, TWO_PI);
            ctx.fill();
          } else if (t === T_WATER) {
            ctx.fillStyle = '#1f5673';
            ctx.fillRect(X, Y, TILE, TILE);
            ctx.fillStyle = 'rgba(255,255,255,0.06)';
            var wob = Math.sin(g.time * 1.5 + tx + ty) * 3;
            ctx.fillRect(X + 6, Y + TILE * 0.4 + wob, TILE - 12, 2);
            ctx.fillRect(X + 10, Y + TILE * 0.7 - wob, TILE - 20, 2);
          } else { // building: sidewalk margin + extruded block
            ctx.fillStyle = '#3d4149';
            ctx.fillRect(X, Y, TILE, TILE);
            var hsh = hash2(tx, ty);
            var inset = 5;
            var shade = 28 + Math.floor(hsh * 26);
            ctx.fillStyle = 'rgb(' + (shade + 8) + ',' + (shade + 10) + ',' + (shade + 16) + ')';
            ctx.fillRect(X + inset, Y + inset, TILE - inset * 2, TILE - inset * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.05)';
            ctx.fillRect(X + inset, Y + inset, TILE - inset * 2, 6);
          }
        }
      }

      // lane dashes along road centers
      ctx.fillStyle = 'rgba(240,210,90,0.5)';
      for (var yy = minTy; yy <= maxTy; yy++) {
        for (var xx = minTx; xx <= maxTx; xx++) {
          if (g.grid[yy][xx] !== T_ROAD) continue;
          if (xx % 6 === 1) ctx.fillRect(xx * TILE + TILE - 2, yy * TILE + 8, 2, TILE - 16);
          if (yy % 6 === 1) ctx.fillRect(xx * TILE + 8, yy * TILE + TILE - 2, TILE - 16, 2);
        }
      }
    }

    // Faint circle over the police's last-known search area while you're hidden.
    function renderSearchMarker() {
      if (g.wanted <= 0 || !g.lkpValid || g.seen) return;
      var rad = 90 + g.searchTimer * 22;
      ctx.strokeStyle = 'rgba(120,170,255,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(g.lkpX, g.lkpY, rad, 0, TWO_PI); ctx.stroke();
      ctx.fillStyle = 'rgba(120,170,255,0.08)';
      ctx.beginPath(); ctx.arc(g.lkpX, g.lkpY, rad, 0, TWO_PI); ctx.fill();
    }

    function renderPickups() {
      for (var i = 0; i < g.pickups.length; i++) {
        var pk = g.pickups[i];
        var bob = Math.sin(pk.t * 4) * 3;
        if (pk.type === 'cash') {
          ctx.fillStyle = '#39d353';
          ctx.fillRect(pk.x - 7, pk.y - 5 + bob, 14, 10);
          ctx.fillStyle = '#0b3d1a';
          ctx.font = 'bold 10px monospace';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('$', pk.x, pk.y + bob);
        } else {
          ctx.fillStyle = '#ff5d6c';
          ctx.fillRect(pk.x - 6, pk.y - 2 + bob, 12, 4);
          ctx.fillRect(pk.x - 2, pk.y - 6 + bob, 4, 12);
        }
      }
    }

    function renderHeistMarker() {
      var hs = g.heist;
      if (!hs) return;
      var col = hs.state === 'ready' ? '#39d353' : (hs.state === 'escaping' ? '#ffd23f' : '#6b7280');
      var pulse = (hs.state === 'cooldown') ? 0 : Math.sin(g.time * 4) * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath(); ctx.arc(hs.x, hs.y, 15, 0, TWO_PI); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(hs.x, hs.y, 12 + pulse, 0, TWO_PI); ctx.fill();
      ctx.fillStyle = '#08210f';
      ctx.font = 'bold 13px monospace';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('$', hs.x, hs.y);
    }

    function drawCar(c) {
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(c.angle);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-CAR_LEN / 2 + 2, -CAR_WID / 2 + 3, CAR_LEN, CAR_WID);
      ctx.fillStyle = c.color;
      ctx.fillRect(-CAR_LEN / 2, -CAR_WID / 2, CAR_LEN, CAR_WID);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(-CAR_LEN * 0.12, -CAR_WID / 2 + 3, CAR_LEN * 0.34, CAR_WID - 6);
      ctx.fillStyle = 'rgba(10,12,18,0.55)';
      ctx.fillRect(CAR_LEN * 0.24, -CAR_WID / 2 + 4, 6, CAR_WID - 8);
      if (c.driver === 'police') {
        ctx.fillStyle = '#2e6bff'; ctx.fillRect(-3, -CAR_WID / 2 + 3, 3, CAR_WID - 6);
        ctx.fillStyle = '#ff2e2e'; ctx.fillRect(0, -CAR_WID / 2 + 3, 3, CAR_WID - 6);
      } else if (c.driver === 'player') {
        ctx.strokeStyle = 'rgba(255,210,63,0.7)'; ctx.lineWidth = 2;
        ctx.strokeRect(-CAR_LEN / 2 - 1, -CAR_WID / 2 - 1, CAR_LEN + 2, CAR_WID + 2);
      }
      ctx.restore();
    }

    function drawChar(ch, active) {
      ctx.save();
      ctx.translate(ch.x, ch.y);
      ctx.rotate(ch.angle);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.arc(1, 1, 11, 0, TWO_PI); ctx.fill();
      ctx.fillStyle = ch.color;
      ctx.beginPath(); ctx.arc(0, 0, 10, 0, TWO_PI); ctx.fill();
      if (active) { ctx.fillStyle = '#3a3a3a'; ctx.fillRect(6, -2.5, 12, 5); } // gun
      ctx.restore();
      // name tag
      ctx.fillStyle = active ? '#ffd23f' : 'rgba(216,207,254,0.85)';
      ctx.font = 'bold 11px Arial';
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(ch.name, ch.x, ch.y - 16);
      if (active) {
        var ay = ch.y - 26 - Math.abs(Math.sin(g.time * 4)) * 3;
        ctx.fillStyle = '#ffd23f';
        ctx.beginPath();
        ctx.moveTo(ch.x - 5, ay); ctx.lineTo(ch.x + 5, ay); ctx.lineTo(ch.x, ay + 6);
        ctx.closePath(); ctx.fill();
      }
    }

    function renderEntities() {
      var i;
      for (i = 0; i < g.cars.length; i++) drawCar(g.cars[i]);
      for (i = 0; i < g.police.length; i++) drawCar(g.police[i]);
      for (i = 0; i < g.peds.length; i++) {
        var ped = g.peds[i];
        if (!ped.alive) {
          ctx.fillStyle = 'rgba(120,20,30,0.5)';
          ctx.beginPath(); ctx.arc(ped.x, ped.y, 9, 0, TWO_PI); ctx.fill();
          continue;
        }
        ctx.save();
        ctx.translate(ped.x, ped.y);
        ctx.rotate(ped.angle);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath(); ctx.arc(1, 1, 7, 0, TWO_PI); ctx.fill();
        ctx.fillStyle = ped.color;
        ctx.beginPath(); ctx.arc(0, 0, 6.5, 0, TWO_PI); ctx.fill();
        ctx.fillStyle = '#222';
        ctx.fillRect(3, -2, 5, 4);
        ctx.restore();
        // a witness shows a "!" while deciding to report
        if (ped.witness) {
          ctx.fillStyle = '#ffd23f'; ctx.font = 'bold 14px Arial';
          ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
          ctx.fillText('!', ped.x, ped.y - 12);
        }
      }
      // protagonists (the active one only if on foot; inactive always)
      for (i = 0; i < g.chars.length; i++) {
        var ch = g.chars[i];
        var active = (ch === g.player);
        if (active && ch.inCar) continue; // riding: the car represents them
        drawChar(ch, active);
      }
    }

    function renderBullets() {
      for (var i = 0; i < g.bullets.length; i++) {
        var b = g.bullets[i];
        ctx.strokeStyle = b.team === 'police' ? '#ff6b6b' : '#ffe08a';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - b.vx * 0.012, b.y - b.vy * 0.012);
        ctx.stroke();
      }
    }

    function renderParticles() {
      for (var i = 0; i < g.particles.length; i++) {
        var pt = g.particles[i];
        ctx.globalAlpha = Math.max(0, pt.life / pt.max);
        ctx.fillStyle = pt.color;
        ctx.fillRect(pt.x - pt.size / 2, pt.y - pt.size / 2, pt.size, pt.size);
      }
      ctx.globalAlpha = 1;
    }

    /* --------------------------------- HUD -------------------------------- */
    function renderHUD() {
      var w = g.view.w, h = g.view.h;

      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(14, 14, 256, 78);

      // active protagonist HP + name
      ctx.fillStyle = '#222'; ctx.fillRect(22, 24, 180, 14);
      var hpFrac = g.player ? g.player.hp / PLAYER_MAX_HP : 0;
      ctx.fillStyle = hpFrac > 0.3 ? '#3fd06b' : '#e74c3c';
      ctx.fillRect(22, 24, 180 * clamp(hpFrac, 0, 1), 14);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(g.player ? g.player.name : '', 208, 31);

      // the other protagonist (smaller bar)
      if (g.chars && g.chars.length > 1) {
        var other = g.chars[1 - g.active];
        ctx.fillStyle = '#222'; ctx.fillRect(22, 44, 110, 8);
        ctx.fillStyle = '#6fae8f';
        ctx.fillRect(22, 44, 110 * clamp(other.hp / PLAYER_MAX_HP, 0, 1), 8);
        ctx.fillStyle = '#9fb3c8'; ctx.font = '11px monospace';
        ctx.fillText(other.name + ' [Q]', 138, 49);
      }

      // money + mode + heat status
      ctx.fillStyle = '#fff'; ctx.font = 'bold 13px monospace';
      ctx.fillText('$' + g.money, 22, 70);
      ctx.fillStyle = '#9fb3c8';
      ctx.fillText(g.player && g.player.inCar ? '[CAR]' : '[FOOT]', 110, 70);
      if (g.wanted > 0) {
        ctx.fillStyle = g.seen ? '#ff5a5a' : '#7fd1ff';
        ctx.fillText(g.seen ? 'SEEN' : 'HIDDEN', 188, 70);
      }

      // wanted stars
      ctx.textAlign = 'right';
      for (var s = 0; s < WANTED_MAX; s++) {
        ctx.fillStyle = s < g.wanted ? '#ffd23f' : 'rgba(255,255,255,0.15)';
        drawStar(w - 22 - s * 26, 30, 9);
      }

      // heist banner / hints (top-center)
      var hs = g.heist;
      if (hs && hs.state === 'escaping') {
        ctx.textAlign = 'center'; ctx.fillStyle = '#ffd23f'; ctx.font = 'bold 16px Arial';
        ctx.fillText('ESCAPE WITH THE SCORE   $' + Math.round(hs.pot), w / 2, 28);
      } else if (hs && hs.state === 'ready' && g.player && !g.player.inCar &&
                 dist2(g.player.x, g.player.y, hs.x, hs.y) < 90 * 90) {
        ctx.textAlign = 'center'; ctx.fillStyle = '#39d353'; ctx.font = 'bold 14px Arial';
        ctx.fillText('[E]  Rob the bank', w / 2, 28);
      }

      // ped interaction hint (bottom-center)
      if (g.player && !g.player.inCar && nearestPed(54)) {
        ctx.textAlign = 'center'; ctx.fillStyle = '#cfe3ff'; ctx.font = '12px Arial';
        ctx.fillText('[E] rob    [G] greet    [H] antagonize', w / 2, h - 12);
      }

      renderFeed();
      renderMinimap();
    }

    function drawStar(cx, cy, r) {
      ctx.beginPath();
      for (var i = 0; i < 5; i++) {
        var a = -Math.PI / 2 + i * (TWO_PI / 5);
        var x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        var a2 = a + TWO_PI / 10;
        ctx.lineTo(cx + Math.cos(a2) * r * 0.45, cy + Math.sin(a2) * r * 0.45);
      }
      ctx.closePath();
      ctx.fill();
    }

    function renderFeed() {
      if (!g.feed || !g.feed.length) return;
      var pad = 14, panelW = 330, lineH = 20;
      var n = Math.min(g.feed.length, 5);
      var x = pad;
      var y = g.view.h - pad - n * lineH - 28;
      ctx.fillStyle = 'rgba(8,10,16,0.5)';
      ctx.fillRect(x - 6, y - 18, panelW + 12, n * lineH + 30);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#8bd0ff'; ctx.font = 'bold 12px Arial';
      ctx.fillText('Bleeter  #Leonida' + (g.wanted >= 3 ? '  ·  #LeonidaChaos' : ''), x, y);
      var start = g.feed.length - n;
      for (var i = 0; i < n; i++) {
        var p = g.feed[start + i];
        var fade = clamp(1 - (p.t - (FEED_LIFE - 1.2)) / 1.2, 0.25, 1);
        var yy = y + 16 + i * lineH;
        ctx.globalAlpha = fade;
        ctx.fillStyle = '#9ec5ff'; ctx.font = 'bold 11px Arial';
        ctx.fillText(p.who, x, yy);
        ctx.fillStyle = '#e8eef6'; ctx.font = '11px Arial';
        var t = p.text; if (t.length > 48) t = t.slice(0, 47) + '…';
        ctx.fillText(t, x + 86, yy);
      }
      ctx.globalAlpha = 1;
    }

    function renderMinimap() {
      var size = 156, pad = 14;
      var mx = g.view.w - size - pad, my = g.view.h - size - pad;
      var sx = size / WORLD_W, sy = size / WORLD_H;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(mx - 3, my - 3, size + 6, size + 6);
      ctx.beginPath(); ctx.rect(mx, my, size, size); ctx.clip();
      ctx.fillStyle = '#2a2d34';
      ctx.fillRect(mx, my, size, size);
      // tiles sampled per 2-block (buildings dark, water blue)
      for (var by = 0; by < MAP_H; by += 2) {
        for (var bx = 0; bx < MAP_W; bx += 2) {
          var t = g.grid[by][bx];
          if (t === T_BUILDING) ctx.fillStyle = '#15171c';
          else if (t === T_WATER) ctx.fillStyle = '#1f5673';
          else continue;
          ctx.fillRect(mx + bx * TILE * sx, my + by * TILE * sy, TILE * sx * 2, TILE * sy * 2);
        }
      }
      // heist marker
      if (g.heist) {
        ctx.fillStyle = g.heist.state === 'ready' ? '#39d353' : (g.heist.state === 'escaping' ? '#ffd23f' : '#6b7280');
        ctx.fillRect(mx + g.heist.x * sx - 2, my + g.heist.y * sy - 2, 4, 4);
      }
      // police search area
      if (g.wanted > 0 && g.lkpValid && !g.seen) {
        ctx.strokeStyle = 'rgba(120,170,255,0.6)'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(mx + g.lkpX * sx, my + g.lkpY * sy, (90 + g.searchTimer * 22) * sx, 0, TWO_PI);
        ctx.stroke();
      }
      // pickups
      for (var i = 0; i < g.pickups.length; i++) {
        var pk = g.pickups[i];
        ctx.fillStyle = pk.type === 'cash' ? '#39d353' : '#ff5d6c';
        ctx.fillRect(mx + pk.x * sx - 1, my + pk.y * sy - 1, 2, 2);
      }
      // police
      ctx.fillStyle = '#3a7bff';
      for (i = 0; i < g.police.length; i++) {
        ctx.fillRect(mx + g.police[i].x * sx - 2, my + g.police[i].y * sy - 2, 4, 4);
      }
      // the other protagonist
      if (g.chars && g.chars.length > 1) {
        var other = g.chars[1 - g.active];
        ctx.fillStyle = '#b59cff';
        ctx.fillRect(mx + other.x * sx - 2, my + other.y * sy - 2, 4, 4);
      }
      // active protagonist
      if (g.player) {
        ctx.fillStyle = '#ffd23f';
        ctx.fillRect(mx + g.player.x * sx - 2.5, my + g.player.y * sy - 2.5, 5, 5);
      }
      ctx.restore();
    }

    function renderMenu() {
      var w = g.view.w, h = g.view.h;
      ctx.fillStyle = 'rgba(8,10,16,0.72)';
      ctx.fillRect(0, 0, w, h);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffd23f';
      ctx.font = 'bold 54px Arial';
      ctx.fillText('GTA 7: JS', w / 2, h / 2 - 132);
      ctx.fillStyle = '#d8cffe';
      ctx.font = 'bold 22px Arial';
      ctx.fillText('— Leonida Script —', w / 2, h / 2 - 92);
      ctx.fillStyle = '#cfd8e3';
      ctx.font = '15px monospace';
      var lines = [
        'WASD / Arrows  move & drive        F / Enter  enter / exit vehicle',
        'Mouse  aim          Click / Space  shoot',
        'E  interact (rob person / bank)    G  greet     H  antagonize',
        'Q  switch protagonist (Jason / Lucia)',
        '',
        'Crimes need a WITNESS. Silence them or out-run their report.',
        'Cops search your last-known spot — break line of sight or swap',
        'cars to shed heat. Rob the bank, then improvise the getaway.',
        '',
        'Click anywhere or press Enter to start'
      ];
      for (var i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], w / 2, h / 2 - 44 + i * 24);
      }
    }

    function renderWasted() {
      var w = g.view.w, h = g.view.h;
      ctx.fillStyle = 'rgba(60,0,0,0.55)';
      ctx.fillRect(0, 0, w, h);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#e74c3c';
      ctx.font = 'bold 72px Arial';
      ctx.fillText('WASTED', w / 2, h / 2);
    }

    /* ------------------------------- Audio -------------------------------- */
    var audioCtx = null;
    function ensureAudio() {
      if (audioCtx || !hasWindow) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      } catch (e) { audioCtx = null; }
    }
    function sfxShot() {
      if (!audioCtx) return;
      try {
        var t = audioCtx.currentTime;
        var o = audioCtx.createOscillator();
        var gain = audioCtx.createGain();
        o.type = 'square';
        o.frequency.setValueAtTime(220, t);
        o.frequency.exponentialRampToValueAtTime(60, t + 0.08);
        gain.gain.setValueAtTime(0.08, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        o.connect(gain); gain.connect(audioCtx.destination);
        o.start(t); o.stop(t + 0.11);
      } catch (e) { /* ignore */ }
    }

    /* ------------------------------- Input -------------------------------- */
    function startPlay() {
      if (g.state !== 'menu') return;
      g.state = 'play';
      ensureAudio();
      if (audioCtx && audioCtx.state === 'suspended') { try { audioCtx.resume(); } catch (e) {} }
      resetWorld();
      g.justPressed = {};   // don't let the start keypress leak into an action
    }

    // Named handlers so removeListeners() can actually detach them.
    var ACTION_CODES = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];
    function onKeyDown(e) {
      if (!g.keys[e.code]) g.justPressed[e.code] = true;   // latch a fresh press edge
      g.keys[e.code] = true;
      if (ACTION_CODES.indexOf(e.code) >= 0) e.preventDefault();
      if (g.state === 'menu' && (e.code === 'Enter' || e.code === 'Space')) startPlay();
    }
    function onKeyUp(e) { g.keys[e.code] = false; }
    function onMouseMove(e) {
      var r = canvas.getBoundingClientRect();
      var sx = r.width ? canvas.width / r.width : 1;   // CSS px -> backing-store px
      var sy = r.height ? canvas.height / r.height : 1;
      g.mouse.x = (e.clientX - r.left) * sx;
      g.mouse.y = (e.clientY - r.top) * sy;
    }
    function onMouseDown(e) {
      g.mouse.down = true;
      if (g.state === 'menu') startPlay();
      if (e && e.preventDefault) e.preventDefault();
    }
    function onMouseUp() { g.mouse.down = false; }
    function onBlur() { g.keys = {}; g.justPressed = {}; g.mouse.down = false; } // drop stuck input
    function onContextMenu(e) { if (e && e.preventDefault) e.preventDefault(); }

    var listenersBound = false;
    function addListeners() {
      if (!hasWindow || !hasDoc || listenersBound) return;
      listenersBound = true;
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      canvas.addEventListener('mousemove', onMouseMove);
      canvas.addEventListener('mousedown', onMouseDown);
      window.addEventListener('mouseup', onMouseUp);
      window.addEventListener('blur', onBlur);
      canvas.addEventListener('contextmenu', onContextMenu);
      window.addEventListener('resize', resize);
    }
    function removeListeners() {
      if (!listenersBound) return;
      listenersBound = false;
      if (hasWindow) {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('blur', onBlur);
        window.removeEventListener('resize', resize);
      }
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('contextmenu', onContextMenu);
    }

    function resize() {
      if (!hasWindow) return;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      g.view.w = canvas.width;
      g.view.h = canvas.height;
    }

    /* ------------------------------ Main loop ----------------------------- */
    var raf = (hasWindow && window.requestAnimationFrame)
      ? window.requestAnimationFrame.bind(window) : null;
    var STEP = 1 / 60;
    var acc = 0, last = 0, running = false;

    function frame(ts) {
      if (!running) return;
      if (!last) last = ts;
      var dt = (ts - last) / 1000;
      last = ts;
      if (dt > 0.25) dt = 0.25;        // clamp huge gaps (tab unfocused)
      acc += dt;
      var guard = 0;
      while (acc >= STEP && guard < 6) { update(STEP); acc -= STEP; guard++; }
      if (acc > STEP) acc = 0;          // shed backlog
      render();
      if (raf) raf(frame);
    }

    function start() {
      if (running) return;
      running = true;
      last = 0; acc = 0;          // re-baseline timing so a resume doesn't jump
      resize();
      addListeners();
      if (raf) raf(frame);
    }
    function stop() {
      if (!running) return;
      running = false;
      last = 0; acc = 0;
      removeListeners();          // true inverse of start(): detach every listener
    }

    /* ------------------------------- Public API --------------------------- */
    var api = {
      game: g,
      start: start,
      stop: stop,
      startPlay: startPlay,
      update: update,        // exposed for headless testing
      render: render,
      _internal: {
        resetWorld: resetWorld, fireWeapon: fireWeapon, tryEnterExit: tryEnterExit,
        circleHitsSolid: circleHitsSolid, isSolidAt: isSolidAt, randomRoadPoint: randomRoadPoint,
        lineOfSight: lineOfSight, commitCrime: commitCrime, alertPolice: alertPolice,
        robNearestPed: robNearestPed, greetNearestPed: greetNearestPed,
        antagonizeNearestPed: antagonizeNearestPed, nearestPed: nearestPed,
        switchChar: switchChar, tryHeist: tryHeist, tileTypeAt: tileTypeAt
      }
    };
    return api;
  }

  /* ----------------------------- Bootstrapping ---------------------------- */
  var GTA = { createGame: createGame, VERSION: '2.0.0' };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = GTA;           // Node / headless testing
  }
  if (typeof window !== 'undefined') {
    window.GTA = GTA;
    if (typeof document !== 'undefined') {
      var boot = function () {
        var canvas = document.getElementById('game');
        if (!canvas) return;
        var instance = createGame(canvas);
        window.__GTA_INSTANCE = instance;
        instance.start();
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
      } else {
        boot();
      }
    }
  }
})();
