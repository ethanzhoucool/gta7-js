/* =============================================================================
 * GTA 7: JS — 3D engine core ("Leonida 3D")
 *
 * Pure game logic + physics. NO rendering, NO Three.js, NO DOM. The renderer
 * (game3d.html) reads this state every frame and draws boxes for it. Because it
 * touches no browser globals, the whole simulation can be require()d in Node and
 * tested headlessly.
 *
 * Coordinate system: X right, Z forward, Y up. The world (roads/buildings) lives
 * on the XZ ground plane; Y is height (gravity, jumping, falling).
 *
 * Realism (informed by how GTA actually plays):
 *   - Bicycle-model car physics: engine force, drag, rolling resistance, brakes,
 *     speed-scaled steering, and lateral grip so cars carry momentum and drift.
 *   - Gravity + ground contact for the on-foot character (run, jump, fall).
 *   - Carjacking: yank the NPC driver out, they flee; witnessed -> wanted.
 *   - Witness/Last-Known-Position/line-of-sight wanted system (GTA-accurate).
 * ============================================================================= */
(function () {
  'use strict';

  /* ------------------------------- Constants ------------------------------ */
  var TILE = 14;            // world units per map tile
  var MAP = 80;             // tiles per side (bigger SF-style city + a northern landmass)
  var WORLD = TILE * MAP;   // world extent (0..WORLD on X and Z) = 1120
  var HALF = WORLD / 2;     // 560

  var T_ROAD = 0, T_BUILDING = 1, T_PARK = 2, T_WATER = 3;
  // Geography: bay on the W / E / N edges; a Golden Gate STRAIT (water band) splits a small
  // northern landmass (Marin, z in [WATER_MARGIN, CHANNEL_Z0)) from the main city (SF, z >=
  // CHANNEL_Z1, running to the south edge). The Golden Gate bridge is a DRIVABLE road
  // causeway across the strait at columns [BRIDGE_X0, BRIDGE_X1); the rest of the strait is
  // solid water, so you can only cross on the bridge (and can't drive off its sides).
  var WATER_MARGIN = 5;
  var CHANNEL_Z0 = 20, CHANNEL_Z1 = 28;     // the strait (8 tiles of water)
  var BRIDGE_X0 = 40, BRIDGE_X1 = 42;       // bridge road columns 40,41 (2 lanes wide)
  // Downtown highrise zoning box (SF financial district). Defined ONCE here so the renderer
  // mirrors it via constants.DOWNTOWN — no second hardcoded copy to drift.
  var DOWNTOWN = { x0: 50, x1: 68, z0: 32, z1: 46 };
  var PIER_COLS = [12, 20, 60, 68];         // Embarcadero piers along the SF channel shore (renderer only)
  // Two hero towers inside downtown (building tiles: x%5>=2 && z%5>=2). One source of truth
  // for the grid (forced building), the height precompute, and the renderer cap.
  var HERO_SALES = { x: 62, z: 38, h: 52 }, HERO_PYRAMID = { x: 57, z: 43, h: 46 };

  var GRAVITY = 26;         // units/s^2 (tuned, not literal 9.8 — feels right at this scale)
  var PLAYER_RADIUS = 0.9;
  var PLAYER_HEIGHT = 2.0;
  var PLAYER_WALK = 7.5;    // units/s
  var PLAYER_RUN = 12.5;
  var PLAYER_ACCEL = 60;    // ground accel
  var PLAYER_JUMP = 9.5;
  var PLAYER_MAX_HP = 100;

  // Car physics
  var CAR_HALF_L = 2.3, CAR_HALF_W = 1.1, CAR_RADIUS = 2.0;
  var CAR_ENGINE = 38;      // forward accel
  var CAR_REVERSE = 18;
  var CAR_BRAKE = 46;
  var CAR_TOP = 46;         // top speed
  var CAR_TOP_REV = 16;
  var CAR_DRAG = 0.9;       // air drag coefficient (∝ v)
  var CAR_ROLL = 4.0;       // rolling resistance
  var CAR_GRIP = 10.0;      // lateral grip (higher = less drift / more planted, less fishtail)
  var CAR_TURN = 2.5;       // max steer rate scale (rad/s at full authority)
  var STEER_IN = 4.0;       // how fast steer eases toward the held A/D target (~0.25s to lock)
  var STEER_CENTER = 7.0;   // how fast steer returns to 0 when released (snappier straighten)

  var BULLET_SPEED = 120, BULLET_LIFE = 1.2, FIRE_CD = 0.14, BULLET_DMG = 34;

  var NUM_PEDS = 64, NUM_TRAFFIC = 30; // scaled ~2.5x to fill the bigger map
  var PED_WALK = 3.0, PED_FLEE = 8.5;
  var POLICE_TOP = 42, POLICE_SIGHT = 70, POLICE_FIRE_RANGE = 45, POLICE_FIRE_CD = 1.2;
  // Foot officers: cops exit the cruiser and fight on foot.
  var COP_EXIT_RANGE = 16;   // cruiser this close -> deploy officer on foot
  var COP_HP = 50;           // ~2 player shots to drop
  var COP_WALK = 4.5, COP_STRAFE = 3.0;
  var COP_FIRE_RANGE = 34, COP_FIRE_CD = 1.0;
  var COP_ENGAGE_MIN = 9, COP_ENGAGE_MAX = 22;
  var COP_GIVEUP_DIST = 140; // despawn a foot cop once the player has escaped
  // SWAT (5★): tougher foot officers with better guns.
  var SWAT_HP = 130, SWAT_FIRE_CD = 0.6, SWAT_DMG = 16;
  // Vehicle damage (the player's car has its own HP, separate from the player).
  var PCAR_HP = 200;          // player car starts here; takes ram/crash/bullet damage
  // Helicopter (4★+): hovers above the player and fires down; killable.
  var HELI_HP = 170, HELI_ALT = 24, HELI_SPEED = 30, HELI_FIRE_RANGE = 60, HELI_FIRE_CD = 0.55, HELI_DMG = 7;
  var HELI_HIT_R = 4.5; // 3D bullet hitbox radius — you must genuinely aim UP at the chopper, but tracking it is rewarded

  var WANTED_MAX = 5, WITNESS_RANGE = 42, REPORT_DELAY = 3.0, DISGUISE_CD = 6.0;
  // Per-star seconds cops keep searching (while unseen) before dropping one star. Higher
  // stars persist far longer — a murder/heist manhunt doesn't evaporate like a fender-bender.
  // (index = current wanted level; [2]=8.0 keeps the existing evade test identical.)
  var SEARCH_GIVEUP_BY_STAR = [6.0, 9.0, 8.0, 14.0, 20.0, 30.0];
  var SEARCH_GIVEUP = SEARCH_GIVEUP_BY_STAR[2]; // legacy alias (8.0) for any external reader
  // Stars a crime is worth on its own (callers pass these to commitCrime).
  var CRIME = { PETTY: 1, ASSAULT: 2, MURDER: 3, COP_KILL: 4, HEIST: 5 };

  var CAR_COLORS = [0xc0392b, 0x2980b9, 0x27ae60, 0xf39c12, 0x8e44ad,
                    0x16a085, 0xd35400, 0x2c3e50, 0x7f8c8d, 0xe84393];
  var TWO_PI = Math.PI * 2;

  /* ------------------------------- Utilities ------------------------------ */
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  // Move cur toward target by at most maxDelta (for smooth accel/decel of velocity).
  function approach(cur, target, maxDelta) { var d = target - cur; if (d > maxDelta) return cur + maxDelta; if (d < -maxDelta) return cur - maxDelta; return target; }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function choice(a) { return a[(Math.random() * a.length) | 0]; }
  function d2(ax, az, bx, bz) { var dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
  function dist(ax, az, bx, bz) { return Math.sqrt(d2(ax, az, bx, bz)); }
  function angDiff(a, b) { var d = (b - a) % TWO_PI; if (d > Math.PI) d -= TWO_PI; if (d < -Math.PI) d += TWO_PI; return d; }
  function angTowards(a, b, m) { var d = angDiff(a, b); if (d > m) d = m; if (d < -m) d = -m; return a + d; }
  function hash2(a, b) { var h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >> 13)) * 1274126177; h ^= h >> 16; return ((h >>> 0) % 100000) / 100000; }

  /* ----------------------------- World creation --------------------------- */
  function isRoadLane(x, y) { return (x % 5 < 2) || (y % 5 < 2); }
  var MARKET_W = 2;                                   // diagonal avenue width
  function onMarket(x, z) { var d = x - z; return d >= -MARKET_W && d <= 0; } // 2-wide NE-SW band
  function inChannel(z) { return z >= CHANNEL_Z0 && z < CHANNEL_Z1; }
  function onBridge(x) { return x >= BRIDGE_X0 && x < BRIDGE_X1; }
  function generateGrid() {
    var g = new Array(MAP), x, z;
    for (z = 0; z < MAP; z++) {
      g[z] = new Array(MAP);
      for (x = 0; x < MAP; x++) {
        // bay on N (z<margin), W (x<margin), E (x>=MAP-margin)
        if (z < WATER_MARGIN || x < WATER_MARGIN || x >= MAP - WATER_MARGIN) { g[z][x] = T_WATER; continue; }
        // Golden Gate strait: water, except the drivable bridge columns
        if (inChannel(z)) { g[z][x] = onBridge(x) ? T_ROAD : T_WATER; continue; }
        if (isRoadLane(x, z)) g[z][x] = T_ROAD;
        else {
          var bx = (x / 5) | 0, bz = (z / 5) | 0;
          g[z][x] = hash2(bx + 7, bz + 11) < 0.16 ? T_PARK : T_BUILDING;
        }
      }
    }
    // Golden Gate Park: a long green rectangle on the SF SW land (south of the strait)
    for (z = MAP - 16; z < MAP - 4; z++) for (x = WATER_MARGIN + 1; x < WATER_MARGIN + 13; x++)
      if (z >= 0 && z < MAP && x < MAP) g[z][x] = T_PARK;
    // Market St diagonal in SF only (never over water/strait) so the avenue reads continuous
    for (z = CHANNEL_Z1; z < MAP; z++) for (x = 0; x < MAP; x++)
      if (g[z][x] !== T_WATER && onMarket(x, z)) g[z][x] = T_ROAD;
    // guarantee the bridge connects to BOTH shores: force the bridge columns to road from the
    // Marin approach (just N of the strait) through SF (just S of it), so the causeway is continuous
    for (z = WATER_MARGIN; z < MAP; z++) for (x = BRIDGE_X0; x < BRIDGE_X1; x++)
      if (g[z][x] !== T_WATER) g[z][x] = T_ROAD;
    // hero-tower footprints are guaranteed buildings (so the renderer's tall towers render)
    g[HERO_SALES.z][HERO_SALES.x] = T_BUILDING; g[HERO_PYRAMID.z][HERO_PYRAMID.x] = T_BUILDING;
    // NOTE: piers are NOT carved into the grid — they're visual-only decks in the renderer.
    return g;
  }

  function createEngine(opts) {
    opts = opts || {};
    var W = {
      time: 0,
      grid: generateGrid(),
      buildingHeights: null,
      player: null,
      playerCar: null,
      cars: [],
      peds: [],
      police: [],
      bullets: [],
      pickups: [],
      effects: [],          // transient visual events for the renderer to consume
      wanted: 0, lkpX: 0, lkpZ: 0, lkpValid: false, seen: false, searchTimer: 0, disguiseCd: 0,
      money: 0, kills: 0, fireCd: 0,
      feed: [],
      state: 'play',
      respawnTimer: 0,
      message: '',
      // --- economy ---
      shops: [], currentShop: null, shopIndex: 0,
      stores: [],               // robbable convenience stores (repeatable earners)
      ownedCarTier: 0,          // index into CAR_TIERS for the player's respawn car
      ownedProps: [],           // indices of bought apartments (safehouses + passive income)
      incomeAccrued: 0,         // passive income drip, paid out on a cadence
      goals: [], netWorth: 0,
      // --- escalated law response ---
      helis: [], heliCd: 0,     // helicopters (4★+); SWAT are tougher foot cops at 5★
      // --- gameplay loops ---
      popups: [],               // floating +$N cash popups (renderer animates them)
      job: null, jobCombo: 0, jobsDone: 0, jobDepots: [], // courier/taxi fares
      vigilante: null, vigilanteCd: 0,                    // bounty-hunt loop
      rampage: null, rampagePads: [],                     // kill-streak challenge
      zones: [], ownedZones: 0,                           // gang turf
      weather: 'clear', weatherTimer: 0, timeOfDay: 0,    // day/night + weather (timeOfDay read by renderer)
      trauma: 0, milestones: {}                           // screen-shake signal + one-time unlock flags
    };

    // precompute building heights for the renderer (deterministic). Downtown zoning box
    // (DOWNTOWN, module scope) is exported via constants so the renderer mirrors it.
    function inDowntown(x, z) { return x >= DOWNTOWN.x0 && x < DOWNTOWN.x1 && z >= DOWNTOWN.z0 && z < DOWNTOWN.z1; }
    var heights = new Array(MAP);
    for (var z = 0; z < MAP; z++) { heights[z] = new Array(MAP);
      for (var x = 0; x < MAP; x++) {
        if (inDowntown(x, z)) heights[z][x] = 22 + Math.floor(hash2(x, z) * 18); // 22..40 glass towers
        else heights[z][x] = 4 + Math.floor(hash2(x, z) * 6);                    // 4..9 pastel low-rise
      }
    }
    heights[HERO_SALES.z][HERO_SALES.x] = HERO_SALES.h;       // Salesforce-style hero tower
    heights[HERO_PYRAMID.z][HERO_PYRAMID.x] = HERO_PYRAMID.h;  // Transamerica-style hero spike
    W.buildingHeights = heights;
    W._heroTowers = { sales: HERO_SALES, pyramid: HERO_PYRAMID };

    /* ----- map helpers ----- */
    function tileType(tx, tz) {
      if (tx < 0 || tz < 0 || tx >= MAP || tz >= MAP) return T_BUILDING;
      return W.grid[tz][tx];
    }
    function solidTile(tx, tz) { var t = tileType(tx, tz); return t === T_BUILDING || t === T_WATER; } // water blocks too — no driving into the bay
    function solidAt(x, z) { return solidTile(Math.floor(x / TILE), Math.floor(z / TILE)); }

    function circleHitsSolid(x, z, r) {
      var minx = Math.floor((x - r) / TILE), maxx = Math.floor((x + r) / TILE);
      var minz = Math.floor((z - r) / TILE), maxz = Math.floor((z + r) / TILE);
      for (var tz = minz; tz <= maxz; tz++) for (var tx = minx; tx <= maxx; tx++) {
        if (!solidTile(tx, tz)) continue;
        var cx = clamp(x, tx * TILE, tx * TILE + TILE);
        var cz = clamp(z, tz * TILE, tz * TILE + TILE);
        var dx = x - cx, dz = z - cz;
        if (dx * dx + dz * dz < r * r) return true;
      }
      return false;
    }
    function moveCircle(e, nx, nz, r) {
      var x = e.x, z = e.z;
      if (!circleHitsSolid(nx, z, r)) x = nx;
      if (!circleHitsSolid(x, nz, r)) z = nz;
      e.x = clamp(x, r, WORLD - r);
      e.z = clamp(z, r, WORLD - r);
    }
    function lineOfSight(ax, az, bx, bz) {
      var d = dist(ax, az, bx, bz);
      if (d < 1) return true;
      var steps = Math.ceil(d / (TILE * 0.5));
      for (var s = 1; s < steps; s++) { var t = s / steps; if (solidAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false; }
      return true;
    }
    function randomRoad() {
      // clamp the sample box to LAND (off the water margin) so nothing ever spawns in the bay
      for (var i = 0; i < 500; i++) {
        var tx = randInt(WATER_MARGIN + 1, MAP - WATER_MARGIN - 2), tz = randInt(WATER_MARGIN + 1, MAP - 2);
        if (tileType(tx, tz) === T_ROAD) return { x: tx * TILE + TILE / 2, z: tz * TILE + TILE / 2 };
      }
      return { x: HALF, z: HALF + WATER_MARGIN * TILE }; // fallback lands on the southern land mass
    }
    function roadNear(cx, cz, minD, maxD) {
      for (var i = 0; i < 140; i++) { var p = randomRoad(); var d = dist(p.x, p.z, cx, cz); if (d >= minD && d <= maxD) return p; }
      return null;
    }

    /* ----- factories ----- */
    function makePlayer(x, z) {
      return { x: x, y: 0, z: z, vx: 0, vz: 0, vy: 0, yaw: 0, aimYaw: 0, onGround: true,
        coyote: 0, jumpBuffer: 0, hp: PLAYER_MAX_HP, maxHp: PLAYER_MAX_HP, inCar: false, aiming: false, moving: false, name: 'Jay',
        armor: 0, ammo: 999999, gunDmgMul: 1, fireRateMul: 1,         // economy upgrades
        weapons: { pistol: true }, weapon: 'pistol' };                 // owned guns + current
    }
    function makeCar(x, z, driver) {
      return {
        kind: 'car', x: x, z: z, yaw: 0, vx: 0, vz: 0, speed: 0,
        color: choice(CAR_COLORS), driver: driver || null, hp: 120,
        aiDir: choice([0, Math.PI / 2, Math.PI, -Math.PI / 2]), aiRetarget: rand(0.5, 2),
        fireCd: 0, spotted: false, searchDir: rand(0, TWO_PI), searchRetarget: rand(0.5, 2),
        id: (W._id = (W._id || 0) + 1)
      };
    }
    function makePed(x, z, tough) {
      return {
        kind: 'ped', x: x, z: z, yaw: rand(0, TWO_PI), dir: rand(0, TWO_PI), speed: 0,
        think: rand(0.3, 2), hp: tough ? 60 : 30, alive: true, deadTimer: 0,
        tough: !!tough, hostile: false, panic: 0, stun: 0, launchVx: 0, launchVz: 0,
        witness: false, reportTimer: 0, reportLevel: 0,
        cop: false, fireCd: 0, strafeSign: 1, strafeFlip: 0, // cop fields (inert for civilians)
        color: tough ? 0x8d5524 : (0x66 << 16 | randInt(120, 220) << 8 | randInt(120, 220)),
        id: (W._id = (W._id || 0) + 1)
      };
    }
    // A foot officer IS a ped (renders, dies, gets credited through the existing ped paths).
    // swat=true at 5★: tougher, faster-firing, harder-hitting, distinct dark uniform.
    function makeCopFoot(x, z, swat) {
      var p = makePed(x, z, false);
      p.cop = true; p.swat = !!swat;
      p.hp = swat ? SWAT_HP : COP_HP;
      p.color = swat ? 0x20242b : 0x1b2a4a; // SWAT near-black, beat cop navy
      p.fireCd = rand(0.2, 0.6); p.strafeSign = (hash2((x | 0), (z | 0)) < 0.5) ? 1 : -1;
      return p;
    }
    function makePolice(x, z) { var c = makeCar(x, z, 'police'); c.color = 0x101820; c.hp = 120; c.vacant = false; c.deployed = false; return c; }
    function makeBullet(x, y, z, dx, dy, dz, team, dmg) {
      var l = Math.hypot(dx, dy, dz) || 1;
      return { x: x, y: y, z: z, vx: dx / l * BULLET_SPEED, vy: dy / l * BULLET_SPEED, vz: dz / l * BULLET_SPEED, life: BULLET_LIFE, team: team, dmg: dmg || BULLET_DMG };
    }
    function makePickup(x, z, type) { return { x: x, z: z, type: type, id: (W._id = (W._id || 0) + 1) }; }
    // Impact magnitude per fx type → drives the renderer's screen-shake (trauma model).
    var FX_TRAUMA = { explode: 0.55, kill: 0.32, spark: 0.12, blood: 0.14, jack: 0.2, crash: 0.4, muzzle: 0.05, nearmiss: 0.18 };
    function fx(type, x, y, z) {
      W.effects.push({ type: type, x: x, y: y, z: z, t: W.time }); if (W.effects.length > 64) W.effects.shift();
      var tr = FX_TRAUMA[type]; if (tr) W.trauma = Math.min(1, (W.trauma || 0) + tr); // renderer reads & decays it
    }
    // floating "+$N" / "-$N" popup for the renderer to animate (game-feel juice).
    function popCash(amt, x, z) { if (!amt) return; W.popups.push({ amt: amt, x: (x === undefined ? W.player.x : x), z: (z === undefined ? W.player.z : z), t: W.time }); if (W.popups.length > 24) W.popups.shift(); }

    function post(who, text) { W.feed.push({ who: who, text: text, t: 0 }); if (W.feed.length > 8) W.feed.shift(); }
    function ageFeed(dt) { for (var i = 0; i < W.feed.length; i++) W.feed[i].t += dt; while (W.feed.length && W.feed[0].t > 9) W.feed.shift(); }

    /* =============================== ECONOMY =============================== */
    var SHOP_RADIUS = 5.5;
    // Personal-vehicle tiers. Tier 0 EXACTLY matches the module car constants so
    // traffic/police (which use makeCar defaults) are unchanged byte-for-byte.
    var CAR_TIERS = [
      { name: 'Beater',   price: 0,     engine: CAR_ENGINE, top: CAR_TOP, color: 0x9aa0a8 },
      { name: 'Sedan',    price: 1500,  engine: 46,         top: 58,      color: 0x2d6cb0 },
      { name: 'Sports',   price: 6000,  engine: 60,         top: 74,      color: 0xc0392b },
      { name: 'Supercar', price: 20000, engine: 78,         top: 92,      color: 0xf1c40f }
    ];
    // Apartments: fixed safehouses. Owning one drips income + lets you "lie low".
    // Income tuned (measured) so passive < active play: all 3 ≈ $1.4k/min vs courier
    // ≈ $1.5k/min — a meaningful supplement that pays back in ~30 min, never a replacement.
    var PROPERTY_DEFS = [
      { name: 'Tinytown Studio',    price: 3000,  income: 2,  tx: 22, tz: 62 },  // SF residential SW
      { name: 'Marin Hideaway',     price: 9000,  income: 6,  tx: 30, tz: 10 },  // across the bridge (Marin)
      { name: 'Downtown Penthouse', price: 30000, income: 15, tx: 60, tz: 36 }   // SF downtown
    ];
    // Shop catalogs: pure data + a pure effect fn(W). Price is deducted by buyItem.
    var SHOP_CATALOG = {
      gun: { name: 'Ammu-Nation', items: [
        { label: 'Body Armor (full)', price: 250, apply: function () { W.player.armor = (W.armorMax || 100); } },
        { label: 'SMG [2]', price: 2500, apply: function () { giveWeapon('smg'); } },
        { label: 'Shotgun [3]', price: 4000, apply: function () { giveWeapon('shotgun'); } },
        { label: 'Rifle [4]', price: 7500, apply: function () { giveWeapon('rifle'); } },
        { label: 'Damage Upgrade', price: 1200, apply: function () { W.player.gunDmgMul = Math.min(3, W.player.gunDmgMul + 0.5); } },
        { label: 'Fire-Rate Upgrade', price: 1000, apply: function () { W.player.fireRateMul = Math.max(0.35, W.player.fireRateMul - 0.18); } },
        { label: 'Max Health +25', price: 1500, apply: function () { W.player.maxHp = Math.min(200, W.player.maxHp + 25); W.player.hp = W.player.maxHp; } }
      ]},
      car: { name: 'Premium Deluxe Motors', items: [
        { label: 'Sedan', price: 1500, apply: function () { grantCar(1); } },
        { label: 'Sports Car', price: 6000, apply: function () { grantCar(2); } },
        { label: 'Supercar', price: 20000, apply: function () { grantCar(3); } },
        { label: 'Repair / Respray', price: 150, apply: function () { if (W.playerCar) { W.playerCar.hp = 120; W.playerCar.color = choice(CAR_COLORS); if (W.wanted > 0 && !W.seen) { W.wanted--; W.lkpValid = false; } } } }
      ]},
      realty: { name: 'Dynasty 8 Real Estate', items: [] }, // filled from PROPERTY_DEFS at reset
      style: { name: 'Binco & Barber', items: [
        { label: 'New Outfit (shed heat)', price: 200, apply: function () { if (W.wanted > 0 && !W.seen) { W.wanted = Math.max(0, W.wanted - 1); W.lkpValid = false; W.searchTimer = 0; } } }
      ]}
    };
    var SHOP_DEFS = [ // tx,tz on road lanes (col%5<2 or row%5<2) so the door is reachable
      { type: 'gun',    tx: 12, tz: 34 },  // SF west
      { type: 'car',    tx: 66, tz: 32 },  // SF near downtown
      { type: 'realty', tx: 16, tz: 68 },  // SF SW
      { type: 'style',  tx: 66, tz: 68 }   // SF SE
    ];

    function snapToRoad(tx, tz) {
      if (tileType(tx, tz) === T_ROAD) return { x: tx * TILE + TILE / 2, z: tz * TILE + TILE / 2 };
      for (var r = 1; r <= 4; r++) for (var a = -r; a <= r; a++) for (var b = -r; b <= r; b++) {
        if (tileType(tx + a, tz + b) === T_ROAD) return { x: (tx + a) * TILE + TILE / 2, z: (tz + b) * TILE + TILE / 2 };
      }
      var p = randomRoad(); return { x: p.x, z: p.z };
    }
    function buildRealtyCatalog() {
      SHOP_CATALOG.realty.items = PROPERTY_DEFS.map(function (d, i) {
        return { label: d.name, price: d.price, apply: function () { if (W.ownedProps.indexOf(i) < 0) W.ownedProps.push(i); } };
      });
    }
    function placeShops() {
      W.shops = []; var i;
      for (i = 0; i < SHOP_DEFS.length; i++) { var d = SHOP_DEFS[i], p = snapToRoad(d.tx, d.tz);
        W.shops.push({ type: d.type, x: p.x, z: p.z, name: SHOP_CATALOG[d.type].name, id: (W._id = (W._id || 0) + 1) }); }
      // attach property markers (safehouses) to their map positions for rendering/enter
      W.propPos = PROPERTY_DEFS.map(function (d) { return snapToRoad(d.tx, d.tz); });
    }
    function placeStores() {
      W.stores = []; for (var i = 0; i < 7; i++) { var p = randomRoad(); W.stores.push({ x: p.x, z: p.z, cooldown: 0, id: (W._id = (W._id || 0) + 1) }); } // more stores for the bigger map
    }

    function grantCar(tier) {
      W.ownedCarTier = Math.max(W.ownedCarTier, tier);
      var t = CAR_TIERS[tier];
      // spawn the new ride beside the player (or upgrade the current one)
      var c = W.playerCar;
      if (!c) { var p = roadNear(W.player.x, W.player.z, 4, 10) || { x: W.player.x + 4, z: W.player.z }; c = makeCar(p.x, p.z, null); W.cars.push(c); }
      applyCarTier(c, tier);
      post('@you', 'Picked up a ' + t.name + '. 🚗');
    }
    function applyCarTier(c, tier) { var t = CAR_TIERS[tier]; c.engine = t.engine; c.top = t.top; c.color = t.color; c.tier = tier; }

    function nearestShop(maxD) { var best = null, bd = maxD * maxD; for (var i = 0; i < W.shops.length; i++) { var s = W.shops[i]; var d = d2(s.x, s.z, W.player.x, W.player.z); if (d < bd) { bd = d; best = s; } } return best; }
    function nearestProperty(maxD) { // returns index of an OWNED apartment within range, or -1
      if (!W.propPos) return -1;
      for (var k = 0; k < W.ownedProps.length; k++) { var i = W.ownedProps[k]; var pp = W.propPos[i]; if (pp && d2(pp.x, pp.z, W.player.x, W.player.z) < maxD * maxD) return i; }
      return -1;
    }
    // pure transaction — caller supplies type+index; returns true iff bought
    function buyItem(shopType, itemIndex) {
      var cat = SHOP_CATALOG[shopType]; if (!cat) return false;
      var item = cat.items[itemIndex]; if (!item) return false;
      var price = Math.round(item.price * shopDiscount()); // courier-veteran discount
      if (W.money < price) { post('@you', "Can't afford " + item.label + ' ($' + price + ').'); return false; }
      W.money -= price; item.apply(W);
      post('@you', 'Bought ' + item.label + ' for $' + price + '. 🛍️');
      return true;
    }
    function shopCatalog(type) { return SHOP_CATALOG[type] || null; }

    // safehouse: walk into an owned apartment to instantly clear heat + heal, free.
    function enterSafehouse() {
      var i = nearestProperty(6); if (i < 0) return false;
      W.wanted = 0; W.lkpValid = false; W.seen = false; W.searchTimer = 0; clearFootCops(true); W.police.length = 0;
      W.player.hp = W.player.maxHp; W.player.armor = Math.max(W.player.armor, 50);
      post('@you', 'Laid low at ' + PROPERTY_DEFS[i].name + '. Heat cleared. 🏠');
      return true;
    }

    // robbable store: stand on it (on foot) and hold to rob; small fast-cooldown earner
    function robStore() {
      if (W.player.inCar) return false;
      for (var i = 0; i < W.stores.length; i++) { var s = W.stores[i];
        if (s.cooldown <= 0 && d2(s.x, s.z, W.player.x, W.player.z) < 6 * 6) {
          var take = randInt(120, 320); W.money += take; popCash(take); s.cooldown = 45;
          // mutually exclusive (same idiom as explodeCar): a COLD robbery floors to 2★;
          // robbing again while already hot ratchets via commitCrime. Calling both would
          // double-count (alertPolice→2 then commitCrime's +1 bump→3) on a cold start.
          if (W.wanted >= 1) commitCrime(CRIME.ASSAULT, s.x, s.z);
          else alertPolice(CRIME.ASSAULT, s.x, s.z);
          post('@you', '💰 Robbed a store for $' + take + '!');
          post('@LeonidaPD', 'Armed robbery in progress. (' + W.wanted + '★)');
          return true;
        }
      }
      return false;
    }

    /* ----- net worth + passive income + goals ----- */
    function recomputeNetWorth() {
      var nw = W.money;
      for (var k = 0; k < W.ownedProps.length; k++) { var d = PROPERTY_DEFS[W.ownedProps[k]]; if (d) nw += d.price; }
      var ct = CAR_TIERS[W.ownedCarTier]; if (ct) nw += ct.price;
      W.netWorth = nw;
    }
    function passiveIncome(dt) {
      var rate = 0;
      for (var k = 0; k < W.ownedProps.length; k++) { var d = PROPERTY_DEFS[W.ownedProps[k]]; if (d) rate += d.income; }
      rate += gangZoneIncome(); // captured turf pays too
      if (rate <= 0) return;
      W.incomeAccrued += rate * dt;
      if (W.incomeAccrued >= 1) { var paid = Math.floor(W.incomeAccrued); W.money += paid; W.incomeAccrued -= paid; }
    }
    function makeGoals() {
      return [
        { id: 'firstapt', label: 'Buy your first apartment', done: false, test: function () { return W.ownedProps.length >= 1; }, reward: 250 },
        { id: 'sports', label: 'Own a sports car', done: false, test: function () { return W.ownedCarTier >= 2; }, reward: 500 },
        { id: 'fivestar', label: 'Reach a 5-star wanted level', done: false, test: function () { return W.wanted >= 5; }, reward: 1000 },
        { id: 'rampage', label: 'Take down 15 targets', done: false, test: function () { return W.kills >= 15; }, reward: 750 },
        { id: 'tycoon', label: 'Reach $50,000 net worth', done: false, test: function () { return W.netWorth >= 50000; }, reward: 5000 }
      ];
    }
    function checkGoals() {
      for (var i = 0; i < W.goals.length; i++) { var g = W.goals[i];
        if (!g.done && g.test()) { g.done = true; W.money += g.reward; W.trauma = Math.min(1, (W.trauma || 0) + 0.25); post('🏆 GOAL', g.label + ' — +$' + g.reward); }
      }
    }
    // Permanent milestone unlocks (researched: cap each loop with a felt, one-time upgrade).
    function unlock(key, msg, apply) { if (W.milestones[key]) return; W.milestones[key] = true; apply(); W.trauma = Math.min(1, (W.trauma || 0) + 0.3); post('⭐ UNLOCK', msg); }
    function shopDiscount() { return W.milestones.courierVet ? 0.85 : 1; } // courier perk: 15% off everything
    // Buy-menu state machine. B near a shop opens it; B again buys the highlighted
    // item; N cycles the highlight. Walking away (or entering a car) closes it.
    function tryOpenOrBuy() {
      if (W.player.inCar) { W.currentShop = null; return; }
      if (!W.currentShop) {
        var s = nearestShop(SHOP_RADIUS);
        if (s) { W.currentShop = s; W.shopIndex = 0; post('@you', '🛒 ' + s.name + ' — [B] buy, [N] next'); }
        return;
      }
      buyItem(W.currentShop.type, W.shopIndex);
    }
    function cycleShop() {
      if (!W.currentShop) return;
      var cat = SHOP_CATALOG[W.currentShop.type];
      if (cat && cat.items.length) W.shopIndex = (W.shopIndex + 1) % cat.items.length;
    }

    /* =============================== WEAPONS ============================== */
    // Multiple guns, bought at Ammu-Nation, switched with 1-4 / Q. Single-pellet
    // weapons fire dead-center (no jitter) so flat-fire tests stay exact; the
    // shotgun sprays pellets. fireWeapon reads the current weapon's stats.
    // Pistol is the slow, reliable starter (semi-auto cadence); the bought guns are a
    // real upgrade — SMG sprays fast, rifle hits hard + far, shotgun shreds up close.
    var WEAPON_DEFS = {
      pistol:  { name: 'Pistol',  dmg: 34, cd: 0.42, pellets: 1, spread: 0,    range: 1.0 },
      smg:     { name: 'SMG',     dmg: 18, cd: 0.08, pellets: 1, spread: 0.03, range: 1.0 },
      shotgun: { name: 'Shotgun', dmg: 16, cd: 0.7,  pellets: 7, spread: 0.22, range: 0.7 },
      rifle:   { name: 'Rifle',   dmg: 46, cd: 0.18, pellets: 1, spread: 0,    range: 1.5 }
    };
    var WEAPON_ORDER = ['pistol', 'smg', 'shotgun', 'rifle'];
    function currentWeaponDef() { return WEAPON_DEFS[W.player.weapon] || WEAPON_DEFS.pistol; }
    function giveWeapon(id) { if (WEAPON_DEFS[id]) { W.player.weapons[id] = true; W.player.weapon = id; } }
    function switchWeapon(id) { if (WEAPON_DEFS[id] && W.player.weapons[id]) W.player.weapon = id; }
    function cycleWeapon(dir) {
      var owned = WEAPON_ORDER.filter(function (w) { return W.player.weapons[w]; });
      var i = owned.indexOf(W.player.weapon); if (i < 0) i = 0;
      W.player.weapon = owned[(i + (dir || 1) + owned.length) % owned.length];
    }

    /* ============================ COURIER JOBS =========================== */
    var DEPOT_DEFS = [{ tx: 64, tz: 30 }, { tx: 12, tz: 50 }, { tx: 66, tz: 70 }, { tx: 30, tz: 12 }]; // 3 in SF + 1 in Marin
    var JOB_RADIUS = 6.5, JOB_TARGET_SPEED = 18, JOB_GRACE = 6, JOB_RATE = 2.2, JOB_STREAK_STEP = 60;
    // GTA-taxi model (researched): a SMALL base fare; the real money is the consecutive
    // -delivery STREAK bonus (+JOB_STREAK_STEP per chain tier) that resets if you fail.
    // A speed bonus rewards delivering with time to spare (the variable-reward layer).
    function placeDepots() { W.jobDepots = []; for (var i = 0; i < DEPOT_DEFS.length; i++) { var p = snapToRoad(DEPOT_DEFS[i].tx, DEPOT_DEFS[i].tz); W.jobDepots.push({ x: p.x, z: p.z, id: (W._id = (W._id || 0) + 1) }); } }
    function nearestDepot(maxD) { var best = null, bd = maxD * maxD; for (var i = 0; i < W.jobDepots.length; i++) { var s = W.jobDepots[i]; var d = d2(s.x, s.z, W.player.x, W.player.z); if (d < bd) { bd = d; best = s; } } return best; }
    function offerJob(fromX, fromZ) {
      var dest = roadNear(fromX, fromZ, 60, 160) || randomRoad();
      var dd = dist(fromX, fromZ, dest.x, dest.z);
      var tmax = dd / JOB_TARGET_SPEED + JOB_GRACE;
      W.job = { dropX: dest.x, dropZ: dest.z, dist: dd, timeMax: tmax, timeLeft: tmax, base: Math.round(25 + dd * JOB_RATE) };
      post('@Dispatch', '📦 Fare to ' + districtName(dest.x, dest.z) + ' — $' + W.job.base + ' (' + Math.round(tmax) + 's)');
    }
    function acceptJob() { if (W.job) return false; if (!nearestDepot(JOB_RADIUS)) return false; offerJob(W.player.x, W.player.z); return true; }
    function completeJob() {
      var j = W.job; if (!j) return false;
      var underHalf = j.timeLeft > j.timeMax * 0.5;                 // delivered fast?
      var speedBonus = underHalf ? Math.round(j.base * 0.5) : 0;     // speed = variable reward layer
      W.jobCombo += 1;
      var streak = (W.jobCombo - 1) * JOB_STREAK_STEP;              // escalating chain bonus (the real money)
      var pay = Math.max(1, j.base + speedBonus + streak);
      W.money += pay; W.jobsDone++; popCash(pay);
      post('@you', '💵 Delivered! +$' + pay + (W.jobCombo > 1 ? '  🔥streak ' + W.jobCombo + ' (+$' + streak + ')' : '') + (underHalf ? '  ⚡fast' : ''));
      if (W.jobCombo >= 10) unlock('courierVet', 'Courier veteran — 15% off all shops, forever.', function () {});
      W.job = null; offerJob(j.dropX, j.dropZ); // chain a fresh fare from here
      return true;
    }
    function failJob(reason) { if (!W.job) return false; var hadStreak = W.jobCombo; W.jobCombo = 0; W.job = null; post('@Dispatch', '❌ Fare lost (' + reason + ').' + (hadStreak > 2 ? ' Streak of ' + hadStreak + ' broken!' : '')); return true; }

    /* ===================== VIGILANTE / RAMPAGE ========================== */
    function makeBountyPed() {
      var p = roadNear(W.player.x, W.player.z, 40, 90) || randomRoad();
      var ped = makePed(p.x, p.z, true); ped.bounty = true; ped.hostile = false; ped.color = 0x884400; ped.hp = 60;
      W.peds.push(ped); return ped;
    }
    // Super-linear payout (researched: GTA Vigilante pays $50×level²) — each fugitive
    // in a chain is worth dramatically more, so clearing "one more" keeps pulling you in.
    // The chain level persists between fugitives and resets only when you stop hunting.
    function startVigilante() {
      if (W.vigilante || W.vigilanteCd > 0) return false;
      var ped = makeBountyPed();
      var lvl = (W.vigilanteLevel || 0) + 1;
      W.vigilante = { pedId: ped.id, level: lvl, reward: 50 * lvl * lvl + randInt(0, 50) };
      post('@LeonidaPD', '🎯 Fugitive #' + lvl + ' spotted — bounty $' + W.vigilante.reward + '.');
      return true;
    }
    function findPedById(id) { for (var i = 0; i < W.peds.length; i++) if (W.peds[i].id === id) return W.peds[i]; return null; }
    function tickVigilante(dt) {
      if (W.vigilanteCd > 0) W.vigilanteCd -= dt;
      if (!W.vigilante) {
        // chain lapses if you ignore the loop for a while (resets the level)
        if (W.vigilanteLevel > 0) { W.vigilanteIdle = (W.vigilanteIdle || 0) + dt; if (W.vigilanteIdle > 25) { W.vigilanteLevel = 0; W.vigilanteIdle = 0; } }
        if (W.wanted === 0 && W.vigilanteCd <= 0 && (W.time % 1) < dt && Math.random() < 0.25) startVigilante();
        return;
      }
      W.vigilanteIdle = 0;
      var t = findPedById(W.vigilante.pedId);
      if (!t || !t.alive) {
        var r = W.vigilante.reward; W.money += r; popCash(r); W.vigilanteCd = 6; // short cd so the chain flows
        W.vigilanteLevel = W.vigilante.level;
        if (W.wanted > 0 && !W.seen) { W.wanted = Math.max(0, W.wanted - 1); W.lkpValid = false; }
        post('@you', '🎯 Fugitive down! +$' + r + '  (chain ' + W.vigilante.level + ' — next pays more)');
        if (W.vigilante.level >= 8) unlock('vigilanteVet', 'Vigilante — body-armor capacity +50 (now 150).', function () { W.armorMax = 150; W.player.armor = Math.max(W.player.armor, 0); });
        W.vigilante = null;
      }
    }
    // Rampage = a power fantasy (researched: GTA rampages grant infinite ammo + a buffed
    // state) on a short hard timer. Reward escalates per rampage cleared. The buff makes
    // it read as a REWARD, not a grind: free top weapon, max armor, damage boost.
    function startRampage() {
      if (W.rampage) return false;
      var n = (W.rampagesDone || 0);
      W.rampage = { kills0: W.kills, target: 12, timeLeft: 45, reward: 1000 + n * 750, prevDmg: W.player.gunDmgMul, prevWeapon: W.player.weapon };
      W.player.armor = 100; W.player.gunDmgMul = Math.max(W.player.gunDmgMul, 2); // buffed for the rampage
      if (W.player.weapons.smg) W.player.weapon = 'smg';
      post('@you', '🔫 RAMPAGE! 12 kills in 45s for $' + W.rampage.reward + '. Go wild!');
      return true;
    }
    function endRampage(won) {
      var R = W.rampage; if (!R) return;
      W.player.gunDmgMul = R.prevDmg; // restore the buff
      if (won) { W.money += R.reward; popCash(R.reward); W.rampagesDone = (W.rampagesDone || 0) + 1; post('@you', '🔥 RAMPAGE complete! +$' + R.reward);
        if (W.rampagesDone >= 3) unlock('rampageVet', 'Rampage legend — max health +25.', function () { W.player.maxHp = Math.min(250, W.player.maxHp + 25); W.player.hp = W.player.maxHp; }); }
      else post('@you', '⏱ Rampage failed (' + (W.kills - R.kills0) + '/' + R.target + ').');
      W.rampage = null;
    }
    function tickRampage(dt) {
      if (!W.rampage) return;
      W.rampage.timeLeft -= dt;
      var got = W.kills - W.rampage.kills0;
      if (got >= W.rampage.target) endRampage(true);
      else if (W.rampage.timeLeft <= 0) endRampage(false);
    }

    /* ============================ GANG TURF ============================== */
    // zones sit in the map corners (MAP=40 tiles, ~14u each) so the central spawn
    // area stays neutral — you choose to roll into a turf war, you don't spawn in one.
    var ZONE_DEFS = [
      { name: 'The Docks',   cx: 64, cz: 32, income: 8 }, // SF NE waterfront
      { name: 'The Mission', cx: 20, cz: 70, income: 8 }, // SF SW
      { name: 'Bayview',     cx: 64, cz: 70, income: 8 }  // SF SE
    ];
    var ZONE_R = 42, ZONE_MAX_GANG = 8;
    function placeZones() {
      W.zones = ZONE_DEFS.map(function (d) { var p = snapToRoad(d.cx, d.cz);
        return { name: d.name, x: p.x, z: p.z, income: d.income, owned: false, aggro: false, retake: 0, id: (W._id = (W._id || 0) + 1) }; });
    }
    function zoneAt(x, z) { for (var i = 0; i < W.zones.length; i++) if (d2(W.zones[i].x, W.zones[i].z, x, z) < ZONE_R * ZONE_R) return W.zones[i]; return null; }
    function countAllGang() { var n = 0; for (var i = 0; i < W.peds.length; i++) if (W.peds[i].gang !== undefined && W.peds[i].alive) n++; return n; }
    function makeGangPed(zone, x, z) {
      var ped = makePed(x, z, true); ped.gang = zone.id; ped.hostile = true; ped.hp = 55; ped.color = 0x6a0d3a; W.peds.push(ped); return ped;
    }
    function tickZones(dt) {
      var z = zoneAt(W.player.x, W.player.z);
      // entering an un-owned zone aggro's it: a gang wave spawns to defend
      if (z && !z.owned && !z.aggro) {
        z.aggro = true; alertPolice(1, z.x, z.z); post('@gang', '🔪 You stepped into ' + z.name + '. Clear it out.');
        var n = Math.min(5, ZONE_MAX_GANG - countAllGang());
        for (var k = 0; k < n; k++) { var p = roadNear(z.x, z.z, 8, ZONE_R * 0.7) || { x: z.x, z: z.z }; makeGangPed(z, p.x, p.z); }
      }
      // an aggro'd zone with no living gang members is captured
      if (z && z.aggro && !z.owned) {
        var alive = 0; for (var i = 0; i < W.peds.length; i++) if (W.peds[i].gang === z.id && W.peds[i].alive) alive++;
        if (alive === 0) { z.owned = true; z.aggro = false; W.ownedZones++; post('@you', '🏴 Captured ' + z.name + '! It now pays you.'); }
      }
    }
    function gangZoneIncome() { var r = 0; for (var i = 0; i < W.zones.length; i++) if (W.zones[i].owned) r += W.zones[i].income; return r; }

    function districtName(x, z) {
      var tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
      if (tz < CHANNEL_Z0) return 'Marin';                                   // across the bridge
      if (tz < CHANNEL_Z1) return 'the Golden Gate';                          // on the strait/bridge
      if (tx >= DOWNTOWN.x0 && tx < DOWNTOWN.x1 && tz < DOWNTOWN.z1 + 6) return 'Downtown';
      if (tx < MAP / 2) return tz > MAP * 0.7 ? 'the Mission' : 'the Marina';
      return 'Bayview';
    }

    /* ----- populate ----- */
    function populate() {
      var i, p;
      for (i = 0; i < NUM_TRAFFIC; i++) { p = randomRoad(); var c = makeCar(p.x, p.z, 'ai'); c.yaw = c.aiDir; c.npc = makePed(p.x, p.z, false); c.npc.inCar = true; W.cars.push(c); }
      for (i = 0; i < 14; i++) { p = randomRoad(); var pk = makeCar(p.x, p.z, null); pk.yaw = choice([0, Math.PI / 2, Math.PI, -Math.PI / 2]); W.cars.push(pk); }
      for (i = 0; i < NUM_PEDS; i++) { p = randomRoad(); W.peds.push(makePed(p.x, p.z, Math.random() < 0.25)); }
      for (i = 0; i < 40; i++) { p = randomRoad(); W.pickups.push(makePickup(p.x, p.z, 'cash')); }
      for (i = 0; i < 10; i++) { p = randomRoad(); W.pickups.push(makePickup(p.x, p.z, 'health')); }
    }

    function spawnPlayer() {
      var p = randomRoad();
      W.player = makePlayer(p.x, p.z);
      W.playerCar = null;
      var c = makeCar(p.x + 4, p.z, null); c.yaw = 0;
      applyCarTier(c, W.ownedCarTier || 0);   // your courtesy ride matches the best car you've bought
      if (!circleHitsSolid(c.x, c.z, CAR_RADIUS)) W.cars.push(c);
    }

    function reset() {
      W.grid = generateGrid();
      W.cars = []; W.peds = []; W.police = []; W.bullets = []; W.pickups = []; W.effects = [];
      W.wanted = 0; W.lkpValid = false; W.seen = false; W.searchTimer = 0; W.disguiseCd = 0;
      W.money = 0; W.kills = 0; W.fireCd = 0; W.feed = [];
      // economy reset
      W.currentShop = null; W.shopIndex = 0; W.ownedCarTier = 0; W.ownedProps = []; W.incomeAccrued = 0; W.netWorth = 0;
      W.helis = []; W.heliCd = 0;
      // gameplay-loop reset
      W.popups = [];
      W.job = null; W.jobCombo = 0; W.jobsDone = 0;
      W.vigilante = null; W.vigilanteCd = 0; W.vigilanteLevel = 0; W.vigilanteIdle = 0; W.rampage = null; W.rampagesDone = 0; W.ownedZones = 0;
      W.weather = 'clear'; W.weatherTimer = rand(40, 90); W.timeOfDay = 0.3;
      buildRealtyCatalog();
      populate();
      placeShops();
      placeStores();
      placeDepots();
      placeZones();
      W.goals = makeGoals();
      spawnPlayer();
      post('@LeonidaPD', 'Welcome to Leonida. Try not to cause a scene. 🌴');
      post('@you', 'Find shops [B], rob stores, buy cars & apartments. Build your empire.');
    }

    /* ----- wanted system ----- */
    function alertPolice(level, x, z) {
      var was = W.wanted;
      W.wanted = clamp(Math.max(W.wanted, level), 0, WANTED_MAX);
      W.lkpX = x; W.lkpZ = z; W.lkpValid = true; W.searchTimer = 0;
      if (was === 0) post('@LeonidaPD', 'Suspect reported in ' + districtName(x, z) + '. (' + W.wanted + '★)');
    }
    // severity = stars this crime is worth (CRIME.*). Witnessed crimes escalate heat:
    // floored to the crime's severity, plus a +1 climb for serious (>=ASSAULT) repeat
    // offending while already hot — so a spree ratchets toward 5, petty crime doesn't.
    function commitCrime(severity, x, z) {
      severity = severity || CRIME.PETTY;
      var immediate = W.seen;
      for (var i = 0; i < W.peds.length; i++) {
        var p = W.peds[i];
        if (!p.alive) continue;
        if (d2(p.x, p.z, x, z) < WITNESS_RANGE * WITNESS_RANGE && lineOfSight(p.x, p.z, x, z)) {
          p.panic = Math.max(p.panic, 3);
          if (W.wanted >= 1) immediate = true;
          else if (!p.witness) { p.witness = true; p.reportTimer = REPORT_DELAY; p.reportLevel = Math.max(p.reportLevel, severity); }
          else p.reportLevel = Math.max(p.reportLevel, severity); // a worse crime upgrades a pending report
        }
      }
      if (W.wanted >= 1) {
        // floor to the crime's severity (a worse crime than your current heat jumps you
        // up to its level), then a +1 ratchet for SERIOUS repeat offending — only when
        // you're already at/above that severity, so a spree climbs toward 5 without the
        // severity-floor itself double-counting. Clamped to WANTED_MAX.
        var floored = Math.max(W.wanted, severity);
        var bump = (severity >= CRIME.ASSAULT && W.wanted >= severity) ? 1 : 0;
        W.wanted = clamp(floored + bump, 0, WANTED_MAX);
        if (immediate) { W.lkpX = x; W.lkpZ = z; W.lkpValid = true; W.searchTimer = 0; }
      }
    }

    /* ----- on-foot player ----- */
    function updatePlayerFoot(dt, input) {
      var p = W.player;
      p.aiming = !!input.aim;
      // desired horizontal move in world space from camera-relative intent
      var fx2 = 0, fz2 = 0;
      if (input.forward) { fx2 += Math.sin(input.camYaw); fz2 += Math.cos(input.camYaw); }
      if (input.back) { fx2 -= Math.sin(input.camYaw); fz2 -= Math.cos(input.camYaw); }
      // screen-right (D) is the ground vector 90° CW from forward = camYaw - PI/2;
      // these were swapped, which made A/D strafe the wrong way.
      if (input.left) { fx2 += Math.sin(input.camYaw + Math.PI / 2); fz2 += Math.cos(input.camYaw + Math.PI / 2); }
      if (input.right) { fx2 += Math.sin(input.camYaw - Math.PI / 2); fz2 += Math.cos(input.camYaw - Math.PI / 2); }
      var len = Math.hypot(fx2, fz2);
      // aiming or shooting slows you to a controllable strafe; running speeds you up
      var maxSpeed = input.run ? PLAYER_RUN : PLAYER_WALK;
      if (input.aim || input.shoot) maxSpeed *= 0.55;
      var desVx = 0, desVz = 0;
      if (len > 0.001) { fx2 /= len; fz2 /= len; desVx = fx2 * maxSpeed; desVz = fz2 * maxSpeed; p.moving = true; }
      else p.moving = false;
      // momentum: accelerate toward desired velocity, brake harder when stopping (snappy but not robotic)
      var accel = (len > 0.001) ? PLAYER_ACCEL : PLAYER_ACCEL * 1.8;
      p.vx = approach(p.vx, desVx, accel * dt);
      p.vz = approach(p.vz, desVz, accel * dt);
      if (Math.abs(p.vx) > 0.0001 || Math.abs(p.vz) > 0.0001) moveCircle(p, p.x + p.vx * dt, p.z + p.vz * dt, PLAYER_RADIUS);

      // facing: when aiming/shooting, face the camera/aim direction (TPS feel); else face travel
      if (input.aimYaw !== undefined) p.aimYaw = input.aimYaw;
      if ((input.aim || input.shoot) && input.aimYaw !== undefined) p.yaw = input.aimYaw;
      else if (p.moving) p.yaw = Math.atan2(p.vx, p.vz);

      // jump with coyote-time (grace after leaving ground) + input buffering (early press)
      if (p.coyote > 0) p.coyote -= dt;
      if (p.jumpBuffer > 0) p.jumpBuffer -= dt;
      // Only the PRESS edge arms the buffer — holding jump must not bunny-hop on landing.
      if (input.jumpPressed) p.jumpBuffer = 0.12;
      if (p.jumpBuffer > 0 && (p.onGround || p.coyote > 0)) { p.vy = PLAYER_JUMP; p.onGround = false; p.coyote = 0; p.jumpBuffer = 0; }
      p.vy -= GRAVITY * dt;
      p.y += p.vy * dt;
      if (p.y <= 0) { p.y = 0; p.vy = 0; if (!p.onGround) p.coyote = 0; p.onGround = true; }
      else if (p.onGround) { p.onGround = false; p.coyote = 0.1; }
    }

    /* ----- car physics (bicycle/velocity model) ----- */
    function driveCar(car, dt, throttle, steerInput, brake, handbrake) {
      // STEER FIRST. The car heading rotates, but the world velocity vector does NOT
      // instantly follow — that mismatch (re-measured below) is what produces a slide.
      // Authority scales with actual speed: can't pivot from a stop, less twitchy at pace.
      var v = Math.hypot(car.vx, car.vz);
      var heading = car.vx * Math.sin(car.yaw) + car.vz * Math.cos(car.yaw); // signed: fwd vs reverse
      // Steering authority: a floor so you can turn the moment you start rolling
      // (no dead zone off the line), full authority by ~v=4, and only a gentle
      // taper at top speed so it stays responsive instead of understeery.
      var lowEnd = clamp(0.4 + v / 4, 0, 1);
      var highDamp = 1 - clamp((v - 18) / (CAR_TOP - 18), 0, 1) * 0.4;   // up to -40% at top speed
      var steerAuthority = lowEnd * highDamp * (handbrake ? 1.7 : 1);    // sharper while sliding
      car.yaw += steerInput * CAR_TURN * dt * steerAuthority * (heading >= -0.5 ? 1 : -1);

      // Decompose the (unchanged) world velocity against the NEW heading: any forward
      // momentum that no longer aligns with the nose becomes lateral velocity.
      var fxv = Math.sin(car.yaw), fzv = Math.cos(car.yaw);
      var rightx = Math.cos(car.yaw), rightz = -Math.sin(car.yaw);
      var forwardSpeed = car.vx * fxv + car.vz * fzv;
      var latSpeed = car.vx * rightx + car.vz * rightz;

      // engine / brake / reverse on the forward component
      if (handbrake) {
        // handbrake: scrub forward speed, but leave lateral velocity to slide
        forwardSpeed -= Math.sign(forwardSpeed) * Math.min(Math.abs(forwardSpeed), CAR_BRAKE * 0.7 * dt);
      } else if (throttle > 0) forwardSpeed += CAR_ENGINE * throttle * dt;
      else if (brake) {
        if (forwardSpeed > 0.5) forwardSpeed = Math.max(0, forwardSpeed - CAR_BRAKE * dt); // brake
        else forwardSpeed -= CAR_REVERSE * dt;                                             // then reverse
      } else {
        forwardSpeed -= Math.sign(forwardSpeed) * Math.min(Math.abs(forwardSpeed), CAR_ROLL * dt); // engine braking
      }
      forwardSpeed -= forwardSpeed * CAR_DRAG * dt;
      forwardSpeed = clamp(forwardSpeed, -CAR_TOP_REV, CAR_TOP);

      // lateral grip bleeds off the slide. Handbrake drops grip so the rear steps out.
      var grip = handbrake ? CAR_GRIP * 0.12 : CAR_GRIP;
      latSpeed -= latSpeed * Math.min(1, grip * dt);

      // recompose world velocity
      car.vx = fxv * forwardSpeed + rightx * latSpeed;
      car.vz = fzv * forwardSpeed + rightz * latSpeed;
      car.speed = forwardSpeed;
      car.sliding = Math.abs(latSpeed) > 6; // for tire-screech FX in the renderer

      // integrate with collision (per-axis slide)
      var nx = car.x + car.vx * dt, nz = car.z + car.vz * dt;
      if (!circleHitsSolid(nx, car.z, CAR_RADIUS)) car.x = nx; else { car.vx *= -0.2; }
      if (!circleHitsSolid(car.x, nz, CAR_RADIUS)) car.z = nz; else { car.vz *= -0.2; }
      car.x = clamp(car.x, CAR_RADIUS, WORLD - CAR_RADIUS);
      car.z = clamp(car.z, CAR_RADIUS, WORLD - CAR_RADIUS);
    }

    function updatePlayerCar(dt, input) {
      var car = W.playerCar;
      var throttle = input.forward ? 1 : 0;
      var brake = input.back;
      // Analog steering from binary A/D keys: ease toward the target lock instead of
      // snapping, and auto-center (faster) when nothing is held. This is the main
      // cure for "wonky WASD driving" — no instant full-lock or instant straighten.
      // Sign: increasing car.yaw curves toward +X (screen-left from the chase cam), so
      // D (right) must drive a NEGATIVE steer target. (left - right), not (right - left).
      var target = (input.left ? 1 : 0) - (input.right ? 1 : 0);
      if (car.steer === undefined) car.steer = 0;
      var rate = (target !== 0) ? STEER_IN : STEER_CENTER;   // ramp in slower, center faster
      car.steer = approach(car.steer, target, rate * dt);
      driveCar(car, dt, throttle, car.steer, brake, !!input.handbrake);
      // ride
      W.player.x = car.x; W.player.z = car.z; W.player.yaw = car.yaw;
      runOverPeds(car, true);
      nearMiss(car, dt);
    }
    // Burnout-style "CLOSE CALL": whip past another car at speed without hitting it ->
    // a little fx + cash thrill. Tracks which cars are currently in the near band so it
    // fires once per pass (on entry), not every frame.
    var NEARMISS_BAND = 7, NEARMISS_SPEED = 22; // band must sit OUTSIDE the 2*CAR_RADIUS(=4) collision ring
    function nearMiss(car, dt) {
      if (Math.abs(car.speed) < NEARMISS_SPEED) return;
      if (!car._near) car._near = {};
      var band2 = NEARMISS_BAND * NEARMISS_BAND, hit2 = (CAR_RADIUS * 2 + 0.5) * (CAR_RADIUS * 2 + 0.5);
      for (var i = 0; i < W.cars.length; i++) {
        var o = W.cars[i]; if (o === car) continue;
        var dd = d2(car.x, car.z, o.x, o.z);
        var inBand = dd < band2 && dd > hit2;       // close, but not actually touching
        if (inBand && !car._near[o.id]) {
          car._near[o.id] = true;
          var bonus = 25; W.money += bonus; popCash(bonus, (car.x + o.x) / 2, (car.z + o.z) / 2);
          fx('nearmiss', car.x, 1, car.z);
          post('@you', '😮 CLOSE CALL! +$' + bonus);
        } else if (!inBand && dd > band2 * 1.5) { car._near[o.id] = false; } // reset once well clear
      }
    }

    // Distance to the nearest car/player in a narrow cone directly ahead, or null.
    // Lets traffic queue behind a slower/stopped vehicle (or the player) instead of
    // driving through it. O(cars) per car; the traffic fleet is small.
    function carAhead(car, range) {
      var fx2 = Math.sin(car.yaw), fz2 = Math.cos(car.yaw);
      var rx2 = Math.cos(car.yaw), rz2 = -Math.sin(car.yaw);
      var best = range, hit = false, i, o, dx, dz, fwd, lat;
      for (i = 0; i < W.cars.length; i++) {
        o = W.cars[i]; if (o === car) continue;
        dx = o.x - car.x; dz = o.z - car.z;
        fwd = dx * fx2 + dz * fz2;
        if (fwd <= 0 || fwd > range) continue;
        lat = Math.abs(dx * rx2 + dz * rz2);
        if (lat < CAR_HALF_W * 2.2 && fwd < best) { best = fwd; hit = true; }
      }
      // also yield to the player (on foot or in another car)
      var pr = W.player; dx = pr.x - car.x; dz = pr.z - car.z; fwd = dx * fx2 + dz * fz2;
      if (fwd > 0 && fwd < best) { lat = Math.abs(dx * rx2 + dz * rz2); if (lat < CAR_HALF_W * 2.5) { best = fwd; hit = true; } }
      return hit ? best : null;
    }

    function updateAiCar(car, dt) {
      car.aiRetarget -= dt;
      var ahead = 8;
      // Prefer driving STRAIGHT; only turn when the road ahead is blocked or it's been
      // a while — so traffic flows down streets instead of randomly jittering at every tile.
      var blocked = solidAt(car.x + Math.sin(car.aiDir) * ahead, car.z + Math.cos(car.aiDir) * ahead);
      if (blocked || car.aiRetarget <= 0) {
        var dirs = [0, Math.PI / 2, Math.PI, -Math.PI / 2], best = [];
        for (var i = 0; i < dirs.length; i++) {
          var dd = dirs[i];
          // avoid immediate U-turns unless that's the only option
          if (!solidAt(car.x + Math.sin(dd) * ahead, car.z + Math.cos(dd) * ahead) && Math.abs(angDiff(dd, car.aiDir + Math.PI)) > 0.3) best.push(dd);
        }
        if (!best.length) { for (i = 0; i < dirs.length; i++) if (!solidAt(car.x + Math.sin(dirs[i]) * ahead, car.z + Math.cos(dirs[i]) * ahead)) best.push(dirs[i]); }
        // strongly prefer keeping the current heading if it's still clear
        if (!blocked && best.indexOf(car.aiDir) >= 0 && Math.random() < 0.7) { /* keep going straight */ }
        else if (best.length) car.aiDir = choice(best);
        car.aiRetarget = rand(2.0, 4.5); // commit to a heading longer
      }
      car.yaw = angTowards(car.yaw, car.aiDir, 3 * dt);
      // forward sensing: ease off / stop behind the car (or player) ahead
      var lead = carAhead(car, CAR_HALF_L * 6);
      var throttle = 0.6, braking = false;
      if (lead !== null) {
        var stopAt = CAR_HALF_L * 2.2;
        throttle = clamp((lead - stopAt) / (CAR_HALF_L * 3), 0, 0.6);
        braking = lead < CAR_HALF_L * 2.4;
      }
      driveCar(car, dt, throttle, 0, braking, false);
      if (car.npc) { car.npc.x = car.x; car.npc.z = car.z; }
    }

    // After all cars integrate, separate any overlapping pair: push apart along the
    // contact normal, exchange closing velocity (low restitution), scrub speed. The
    // player car is in W.cars so it shoves traffic too. Arcade, not rigid-body.
    function resolveCarCollisions() {
      var n = W.cars.length, minD = CAR_RADIUS * 2, min2 = minD * minD, a, b, A, B;
      for (a = 0; a < n; a++) {
        A = W.cars[a];
        for (b = a + 1; b < n; b++) {
          B = W.cars[b];
          var dx = B.x - A.x, dz = B.z - A.z, dd = dx * dx + dz * dz;
          if (dd >= min2 || dd < 1e-6) continue;
          var d = Math.sqrt(dd), nx = dx / d, nz = dz / d, pen = (minD - d) * 0.5;
          A.x -= nx * pen; A.z -= nz * pen; B.x += nx * pen; B.z += nz * pen;
          var rel = (B.vx - A.vx) * nx + (B.vz - A.vz) * nz;
          if (rel < 0) {
            var j = -rel * 0.5; // restitution 0.5
            A.vx -= j * nx; A.vz -= j * nz; B.vx += j * nx; B.vz += j * nz;
          }
          A.speed *= 0.7; B.speed *= 0.7;
          if (rel < -22) fx('spark', (A.x + B.x) / 2, 1, (A.z + B.z) / 2); // hard crash
        }
      }
    }

    /* ----- peds ----- */
    function respawnPed(p) { var r = randomRoad(); p.x = r.x; p.z = r.z; p.alive = true; p.cop = false; p.swat = false; p.bounty = false; p.gang = undefined; p.fireCd = 0; p.strafeSign = 1; p.strafeFlip = 0; p.hp = p.tough ? 60 : 30; p.panic = 0; p.stun = 0; p.launchVx = 0; p.launchVz = 0; p.deadTimer = 0; p.witness = false; p.reportTimer = 0; p.hostile = false; p.dir = rand(0, TWO_PI); p.speed = 0; p.think = rand(0.4, 2); }
    // Foot officer: face the suspect, hold a standoff (advance/retreat/strafe), and fire flat.
    function updateCopFoot(p, dt) {
      if (p.stun > 0) { p.stun -= dt; p.speed = 0; if (p.stun > 0) return; }
      var pl = W.player, d = dist(p.x, p.z, pl.x, pl.z);
      var toP = Math.atan2(pl.x - p.x, pl.z - p.z);
      p.yaw = angTowards(p.yaw, toP, 6 * dt); p.dir = toP;
      var radial = 0;
      if (d > COP_ENGAGE_MAX) radial = COP_WALK;
      else if (d < COP_ENGAGE_MIN) radial = -COP_WALK * 0.6;
      p.strafeFlip -= dt;
      if (p.strafeFlip <= 0) { p.strafeSign = -p.strafeSign; p.strafeFlip = 1.4 + (p.id % 5) * 0.2; }
      var strafe = (d <= COP_ENGAGE_MAX && d >= COP_ENGAGE_MIN) ? COP_STRAFE * p.strafeSign : 0;
      var fwx = Math.sin(toP), fwz = Math.cos(toP), rgx = Math.cos(toP), rgz = -Math.sin(toP);
      var mvx = fwx * radial + rgx * strafe, mvz = fwz * radial + rgz * strafe;
      if (mvx || mvz) { p.speed = Math.hypot(mvx, mvz); moveCircle(p, p.x + mvx * dt, p.z + mvz * dt, PLAYER_RADIUS); } else p.speed = 0;
      p.fireCd -= dt;
      var frange = p.swat ? COP_FIRE_RANGE + 6 : COP_FIRE_RANGE;
      if (d < frange && p.fireCd <= 0 && lineOfSight(p.x, p.z, pl.x, pl.z) && !(pl.y > 3)) {
        p.fireCd = p.swat ? SWAT_FIRE_CD : COP_FIRE_CD;
        var a = Math.atan2(pl.x - p.x, pl.z - p.z) + rand(-0.04, 0.04);
        var bd = p.swat ? SWAT_DMG : 9;
        W.bullets.push(makeBullet(p.x + Math.sin(a) * 1.0, 1.1, p.z + Math.cos(a) * 1.0, Math.sin(a), 0, Math.cos(a), 'police', bd));
        fx('muzzle', p.x + Math.sin(a) * 1.0, 1.1, p.z + Math.cos(a) * 1.0);
      }
    }
    // Returns false if the ped should be removed from W.peds (a dead cop). The caller
    // (the backward-iterating ped loop) splices it out — keeps cops from respawning.
    function updatePed(p, dt) {
      if (!p.alive) {
        p.deadTimer -= dt;
        if (p.launchVx || p.launchVz) {
          moveCircle(p, p.x + p.launchVx * dt, p.z + p.launchVz * dt, PLAYER_RADIUS);
          p.launchVx *= Math.max(0, 1 - 6 * dt); p.launchVz *= Math.max(0, 1 - 6 * dt);
          if (Math.abs(p.launchVx) < 0.05) p.launchVx = 0;
          if (Math.abs(p.launchVz) < 0.05) p.launchVz = 0;
        }
        if (p.deadTimer <= 0) {
          if (p.cop || p.bounty || p.gang !== undefined) return false; // cop/fugitive/gang: remove, don't recycle
          respawnPed(p);
        }
        return true;
      }
      if (p.cop) {
        // escaped/cleared: foot cop despawns when wanted is gone or the player is far
        if (W.wanted === 0 || dist(p.x, p.z, W.player.x, W.player.z) > COP_GIVEUP_DIST) return false;
        updateCopFoot(p, dt);
        return true;
      }
      if (p.stun > 0) { p.stun -= dt; p.speed = 0; p.yaw = p.dir; if (p.stun > 0) return true; } // staggered freeze
      if (p.witness) { p.reportTimer -= dt; if (p.reportTimer <= 0) { p.witness = false; alertPolice(p.reportLevel || 1, p.x, p.z); post('witness', '📞 "Officer, over here!" — a bystander called it in.'); } }
      p.think -= dt;
      if (p.hostile) {
        // tough peds charge the player to throw punches
        p.dir = Math.atan2(W.player.x - p.x, W.player.z - p.z); p.speed = PED_FLEE * 0.8;
        if (dist(p.x, p.z, W.player.x, W.player.z) < 2.2 && !W.player.inCar) { hurtPlayer(8 * dt + 0.1, 0.05); }
      } else if (p.panic > 0) {
        p.panic -= dt; p.dir = Math.atan2(p.x - W.player.x, p.z - W.player.z); p.speed = PED_FLEE;
      } else if (p.think <= 0) {
        p.think = rand(0.6, 2.4);
        if (Math.random() < 0.25) p.speed = 0; else { p.dir = rand(0, TWO_PI); p.speed = PED_WALK; }
      }
      if (p.speed > 0) { p.yaw = p.dir; var b = p.x + p.z; moveCircle(p, p.x + Math.sin(p.dir) * p.speed * dt, p.z + Math.cos(p.dir) * p.speed * dt, PLAYER_RADIUS); if (Math.abs((p.x + p.z) - b) < 0.001 && p.panic <= 0 && !p.hostile) p.dir = rand(0, TWO_PI); }
      return true;
    }
    function runOverPeds(car, byPlayer) {
      var s = Math.abs(car.speed);
      if (s < 7) return;
      var fx2 = Math.sin(car.yaw), fz2 = Math.cos(car.yaw);
      for (var i = 0; i < W.peds.length; i++) {
        var p = W.peds[i]; if (!p.alive) continue;
        var dd = d2(car.x, car.z, p.x, p.z);
        if (dd < (CAR_HALF_L + 0.7) * (CAR_HALF_L + 0.7)) {
          if (s < 18) {
            // glancing blow: shove + brief stagger, ped survives
            p.stun = 0.6; p.panic = Math.max(p.panic, 3);
            p.x += fx2 * 1.2; p.z += fz2 * 1.2;
            fx('blood', p.x, 0.5, p.z);
            if (byPlayer) commitCrime(CRIME.PETTY, p.x, p.z); // non-lethal bump, but witnessed
          } else {
            // lethal ram: kill and launch the corpse along the car's heading
            p.launchVx = fx2 * s * 0.4; p.launchVz = fz2 * s * 0.4;
            killPed(p, byPlayer);
          }
        } else if (dd < 18 * 18) p.panic = Math.max(p.panic, 2.5);
      }
    }
    function killPed(p, byPlayer) {
      if (!p.alive) return;
      var wasW = p.witness;
      p.alive = false; p.witness = false; p.hostile = false; p.deadTimer = rand(6, 10);
      fx('blood', p.x, 1, p.z);
      // Cops / bounty fugitives / gang members use a distinct kill path: credit + cash
      // but NO commitCrime — otherwise fighting them you were sent to fight re-escalates
      // wanted and the heat-relief loops can never actually cool you off.
      if (p.cop) { if (byPlayer) { W.kills++; W.money += randInt(15, 40); } return; }
      if (p.bounty) { if (byPlayer) { W.kills++; W.money += randInt(10, 30); } return; }
      if (p.gang !== undefined) { if (byPlayer) { W.kills++; W.money += randInt(10, 35); } return; }
      if (byPlayer) { W.kills++; W.money += randInt(5, 25); if (wasW) post('@you', '🤫 Silenced a witness.'); commitCrime(CRIME.MURDER, p.x, p.z); }
    }

    /* ----- carjacking ----- */
    function nearestPed(maxD) { var best = null, bd = maxD * maxD; for (var i = 0; i < W.peds.length; i++) { var p = W.peds[i]; if (!p.alive) continue; var d = d2(p.x, p.z, W.player.x, W.player.z); if (d < bd) { bd = d; best = p; } } return best; }
    function nearestCar(maxD) {
      var best = null, bd = maxD * maxD;
      for (var i = 0; i < W.cars.length; i++) { var c = W.cars[i]; if (c.driver === 'player') continue; var d = d2(c.x, c.z, W.player.x, W.player.z); if (d < bd) { bd = d; best = c; } }
      return best;
    }
    function nearestPoliceCar(maxD) {
      var best = null, bd = maxD * maxD;
      for (var i = 0; i < W.police.length; i++) { var c = W.police[i]; if (c.onFire || c.exploded) continue; var d = d2(c.x, c.z, W.player.x, W.player.z); if (d < bd) { bd = d; best = c; } }
      return best;
    }
    // Commandeer a police cruiser: yank the officer out if it's occupied (a struggle), then
    // move the car out of W.police into W.cars as your ride. Keeps its livery via wasPolice.
    function stealPoliceCar(c) {
      var occupied = !c.vacant;          // an officer is still driving it
      if (occupied) {
        var ox = c.x + Math.cos(c.yaw) * (CAR_HALF_W + 1.2);
        var oz = c.z - Math.sin(c.yaw) * (CAR_HALF_W + 1.2);
        if (circleHitsSolid(ox, oz, PLAYER_RADIUS)) { ox = c.x; oz = c.z; }
        var cop = makeCopFoot(ox, oz, W.wanted >= 5);
        cop.panic = 2; cop.yaw = Math.atan2(W.player.x - ox, W.player.z - oz);
        W.peds.push(cop);
      }
      var idx = W.police.indexOf(c); if (idx >= 0) W.police.splice(idx, 1);
      c.driver = 'player'; c.vacant = false; c.deployed = false; c.spotted = false;
      c.steer = 0; c.wasPolice = true;   // renderer keeps the cruiser look + flashing lightbar
      if (c.carHp === undefined || c.carHp <= 0) c.carHp = PCAR_HP;
      W.cars.push(c); W.playerCar = c; W.player.inCar = true; W.player.car = c;
      fx('jack', c.x, 1, c.z);
      post('@you', occupied ? '🚓 Hijacked a cop car — they will NOT be happy.' : '🚓 Commandeered a police cruiser.');
      // grand theft of a police vehicle draws heat (more if you fought a cop for it)
      var sev = occupied ? CRIME.ASSAULT : CRIME.PETTY;
      if (W.wanted >= 1) commitCrime(sev, c.x, c.z);
      else alertPolice(occupied ? 2 : 1, c.x, c.z);
    }
    function tryEnterExit() {
      var p = W.player;
      if (p.inCar) {
        var car = W.playerCar;
        var ox = car.x + Math.cos(car.yaw) * (CAR_HALF_W + 1.2);
        var oz = car.z - Math.sin(car.yaw) * (CAR_HALF_W + 1.2);
        if (circleHitsSolid(ox, oz, PLAYER_RADIUS)) { ox = car.x; oz = car.z; }
        p.x = ox; p.z = oz; p.inCar = false; p.car = null;
        car.driver = null; car.speed *= 0.3; car.steer = 0; W.playerCar = null;
        return;
      }
      var c = nearestCar(4.5);
      var pc = nearestPoliceCar(4.5);
      // steal the cruiser if it's the closest stealable vehicle
      if (pc && (!c || d2(pc.x, pc.z, p.x, p.z) < d2(c.x, c.z, p.x, p.z))) { stealPoliceCar(pc); return; }
      if (!c) return;
      var hadDriver = (c.driver === 'ai' || (c.npc && c.npc.inCar));
      if (hadDriver && c.npc) {
        // CARJACK: yank the driver out; they spill onto the road and flee
        var drv = c.npc;
        drv.inCar = false; drv.x = c.x + Math.cos(c.yaw) * 2.2; drv.z = c.z - Math.sin(c.yaw) * 2.2;
        drv.alive = true; drv.panic = 5; drv.hostile = drv.tough && Math.random() < 0.5;
        if (W.peds.indexOf(drv) < 0) W.peds.push(drv);
        c.npc = null;
        fx('jack', c.x, 1, c.z);
        post('@you', '🚗 Carjacked a ' + (drv.hostile ? 'very unhappy ' : '') + 'local.');
        commitCrime(CRIME.PETTY, c.x, c.z); // witnessed grand theft auto
      }
      if (c.onFire || c.exploded) return; // can't commandeer a burning wreck
      c.driver = 'player'; W.playerCar = c; p.inCar = true; p.car = c;
      if (c.carHp === undefined || c.carHp <= 0) c.carHp = PCAR_HP; // every ride has its own HP
      // swap vehicle while unseen -> shed the description
      if (W.wanted > 0 && !W.seen && W.disguiseCd <= 0 && hadDriver) {
        W.wanted--; W.disguiseCd = DISGUISE_CD; W.lkpValid = false; W.searchTimer = 0;
        post('@you', 'New ride threw off the cops. (' + W.wanted + '★)');
      }
    }
    function robNearest() {
      var p = nearestPed(3.5); if (!p || p.robbedCd > 0) return;
      var amt = randInt(15, 60); W.money += amt; popCash(amt, p.x, p.z); p.robbedCd = 12; p.panic = 4;
      if (p.tough && Math.random() < 0.6) { p.hostile = true; p.panic = 0; }
      post('@you', 'Mugged a local for $' + amt + '. 💸');
      commitCrime(CRIME.PETTY, p.x, p.z);
    }

    /* ----- shooting ----- */
    function fireWeapon(input) {
      if (W.fireCd > 0) return;
      var p = W.player;
      if ((p.ammo || 0) <= 0) return;
      if (p.ammo < 999999) p.ammo--;                 // unlimited sentinel never decrements meaningfully
      var wd = currentWeaponDef();
      W.fireCd = wd.cd * (p.fireRateMul || 1);        // per-weapon cooldown × upgrade
      var yaw = (input.aimYaw !== undefined) ? input.aimYaw : p.yaw;
      // vertical aim: up = positive pitch. Renderer solves this from the crosshair ray;
      // headless/AI callers omit it (default flat). Clamped so you can fire near-straight up.
      var pitch = (input.aimPitch !== undefined) ? clamp(input.aimPitch, -1.35, 1.35) : 0;
      var cp = Math.cos(pitch), sp = Math.sin(pitch);
      var oy = 1.1; // torso / car-body height — matches the y-band hit tests below
      var ox = p.x, oz = p.z;
      var dmg = wd.dmg * (p.gunDmgMul || 1);
      // single-pellet weapons fire dead-center (exact yaw); shotgun sprays pellets
      for (var s = 0; s < wd.pellets; s++) {
        var j = (wd.pellets === 1) ? 0 : rand(-wd.spread, wd.spread);
        var a = yaw + j, dx = Math.sin(a) * cp, dz = Math.cos(a) * cp, dy = sp;
        var b = makeBullet(ox + dx * 2, oy + dy * 2, oz + dz * 2, dx, dy, dz, 'player', dmg);
        b.life = BULLET_LIFE * wd.range;              // range tuning per weapon
        W.bullets.push(b);
      }
      fx('muzzle', ox + Math.sin(yaw) * cp * 2, oy + sp * 2, oz + Math.cos(yaw) * cp * 2);
      for (var i = 0; i < W.peds.length; i++) { var q = W.peds[i]; if (q.alive && d2(q.x, q.z, p.x, p.z) < 40 * 40) { if (q.tough && Math.random() < 0.4) q.hostile = true; else q.panic = 3; } }
      commitCrime(CRIME.PETTY, p.x, p.z); // firing in the open is petty; a kill upgrades it via killPed
    }
    function updateBullets(dt) {
      for (var i = W.bullets.length - 1; i >= 0; i--) {
        var b = W.bullets[i]; b.life -= dt; b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
        var dead = b.life <= 0 || b.x < 0 || b.z < 0 || b.x > WORLD || b.z > WORLD || b.y < 0;
        if (!dead && solidAt(b.x, b.z) && b.y < 18) { fx('spark', b.x, b.y, b.z); dead = true; }
        if (!dead && b.team === 'player') {
          for (var j = 0; j < W.peds.length && !dead; j++) { var p = W.peds[j]; if (p.alive && d2(b.x, b.z, p.x, p.z) < 1.4 * 1.4 && b.y < 2.2) { p.hp -= (b.dmg || BULLET_DMG); if (p.tough) p.hostile = true; else p.panic = 3; fx('blood', b.x, b.y, b.z); if (p.hp <= 0) killPed(p, true); dead = true; } }
          for (var k = 0; k < W.police.length && !dead; k++) { var c = W.police[k]; if (d2(b.x, b.z, c.x, c.z) < 2.8 * 2.8 && b.y < 2.6) { c.hp -= (b.dmg || BULLET_DMG); fx('spark', b.x, b.y, b.z); if (c.hp <= 0) fx('explode', c.x, 1, c.z); dead = true; } }
          // helis hover at altitude — a REAL 3D hit test, so you must actually aim up at them
          for (var hh = 0; hh < W.helis.length && !dead; hh++) { var H = W.helis[hh];
            var hdx = b.x - H.x, hdy = b.y - H.y, hdz = b.z - H.z;
            if (hdx * hdx + hdy * hdy + hdz * hdz < HELI_HIT_R * HELI_HIT_R) { H.hp -= (b.dmg || BULLET_DMG); H.hitFlash = 0.12; fx('spark', b.x, b.y, b.z); dead = true; } }
          // any traffic/parked car is shootable now: damage its carHp, ignite at 0 (GTA-style)
          for (var cc = 0; cc < W.cars.length && !dead; cc++) { var ac = W.cars[cc]; if (ac.onFire || ac.exploded) continue;
            if (d2(b.x, b.z, ac.x, ac.z) < 2.8 * 2.8 && b.y < 2.6) {
              if (ac.carHp === undefined) ac.carHp = (ac === W.playerCar ? PCAR_HP : 90);
              ac.carHp -= (b.dmg || BULLET_DMG); fx('spark', b.x, b.y, b.z);
              if (ac.carHp <= 0) igniteCar(ac);
              dead = true;
            }
          }
        } else if (!dead && b.team === 'police') {
          var pl = W.player; var rr = pl.inCar ? 2.2 : 1.2;
          if (d2(b.x, b.z, pl.x, pl.z) < rr * rr && b.y < 2.6) { hurtPlayer(b.dmg || 9, 0.12); fx('spark', b.x, b.y, b.z); dead = true; }
        }
        if (dead) W.bullets.splice(i, 1);
      }
    }
    function hurtPlayer(n, flash) {
      if (W.state !== 'play') return;
      // While driving, the CAR soaks most of the hit (its own HP, separate from yours).
      // Damage only bleeds through to the player once the car is wrecked/on fire.
      if (W.player.inCar && W.playerCar) {
        var car = W.playerCar;
        if (car.carHp === undefined) car.carHp = PCAR_HP;
        if (car.carHp > 0) {
          car.carHp -= n;
          if (flash) W.flash = Math.min(0.25, (W.flash || 0) + flash * 0.5);
          if (car.carHp <= 0) { car.carHp = 0; igniteCar(car); }
          return; // car absorbed it; player unharmed
        }
        // car is wrecked & burning: a fraction leaks to the player
        n *= 0.5;
      }
      if (W.player.armor > 0) { var a = Math.min(W.player.armor, n); W.player.armor -= a; n -= a; } // armor soaks first
      W.player.hp -= n;
      if (flash) W.flash = Math.min(0.4, (W.flash || 0) + flash);
      if (W.player.hp <= 0) { W.player.hp = 0; wasted(); }
    }
    // A wrecked car catches fire, burns down, then explodes — ejecting the player.
    function igniteCar(car) {
      if (car.onFire) return;
      car.onFire = true; car.fireTimer = rand(2.5, 4);
      fx('spark', car.x, 1, car.z);
      if (car === W.playerCar) post('@you', '🔥 Your ride is wrecked — bail out!');
    }
    function explodeCar(car) {
      fx('explode', car.x, 1.2, car.z);
      // splash damage to the player if still inside / nearby, plus nearby peds
      var dpl = dist(car.x, car.z, W.player.x, W.player.z);
      if (dpl < 6) { var prevInCar = W.player.inCar; if (prevInCar && W.playerCar === car) { car.driver = null; W.player.inCar = false; W.player.car = null; W.playerCar = null; } hurtPlayer(45 * (1 - dpl / 6), 0.3); }
      for (var i = 0; i < W.peds.length; i++) { var q = W.peds[i]; if (q.alive && d2(q.x, q.z, car.x, car.z) < 6 * 6) killPed(q, false); }
      // A vehicle going up near the player reads as heist-tier mayhem. Already hot ->
      // ratchet toward 5; cold start -> a 3-star response. Far-off AI wrecks stay silent.
      if (dpl < WITNESS_RANGE) {
        if (W.wanted >= 1) commitCrime(CRIME.HEIST, car.x, car.z);
        else alertPolice(Math.min(WANTED_MAX, 3), car.x, car.z);
      }
      car.onFire = false; car.carHp = 0; car.exploded = true; car.speed = 0; car.vx = 0; car.vz = 0;
    }
    function wasted() {
      if (W.state !== 'play') return;
      W.state = 'wasted'; W.respawnTimer = 2.6; W.message = 'WASTED';
      fx('blood', W.player.x, 1, W.player.z);
      if (W.player.inCar && W.playerCar) { W.playerCar.driver = null; W.player.inCar = false; W.playerCar = null; }
    }

    /* ----- police ----- */
    function managePolice(dt) {
      var want = W.wanted >= 1 ? W.wanted + 1 : 0;
      if (W.police.length < want && (W.time % 0.7) < dt) {
        var sx = W.lkpValid ? W.lkpX : W.player.x, sz = W.lkpValid ? W.lkpZ : W.player.z;
        // spawn OUTSIDE sight range (> POLICE_SIGHT) so cruisers never pop into view
        var sp = roadNear(sx, sz, POLICE_SIGHT + 20, 200); if (sp) W.police.push(makePolice(sp.x, sp.z));
      }
      W.seen = false;
      for (var i = W.police.length - 1; i >= 0; i--) {
        var c = W.police[i];
        if (c.hp <= 0) { fx('explode', c.x, 1, c.z); W.police.splice(i, 1); W.money += randInt(20, 60); continue; }
        var dl = dist(c.x, c.z, W.player.x, W.player.z);
        c.spotted = !c.vacant && dl < POLICE_SIGHT && lineOfSight(c.x, c.z, W.player.x, W.player.z);
        if (c.spotted) W.seen = true;
        // tear down empty cruisers once heat is gone or the player is far away
        if (c.vacant && (W.wanted === 0 || dl > COP_GIVEUP_DIST)) { W.police.splice(i, 1); continue; }
        if (W.wanted === 0 && dl > 160) { W.police.splice(i, 1); continue; }
        updatePoliceCar(c, dt);
      }
      if (W.seen) { W.lkpX = W.player.x; W.lkpZ = W.player.z; W.lkpValid = true; W.searchTimer = 0; }
      else if (W.wanted > 0) {
        W.searchTimer += dt;
        var giveUp = SEARCH_GIVEUP_BY_STAR[W.wanted] || SEARCH_GIVEUP; // higher stars persist longer
        if (W.searchTimer >= giveUp) { W.searchTimer = 0; W.wanted--; if (W.wanted <= 0) { W.wanted = 0; W.lkpValid = false; clearFootCops(true); W.helis = []; post('@LeonidaPD', 'Lost the suspect. 🚔💨'); } else post('@LeonidaPD', 'Narrowing the search… (' + W.wanted + '★)'); }
      }
    }
    function clearFootCops(corpsesToo) {
      for (var i = W.peds.length - 1; i >= 0; i--) { var q = W.peds[i]; if (q.cop && (corpsesToo || q.alive)) W.peds.splice(i, 1); }
    }
    function deployOfficer(c) {
      var ox = c.x + Math.cos(c.yaw) * (CAR_HALF_W + 1.0);
      var oz = c.z - Math.sin(c.yaw) * (CAR_HALF_W + 1.0);
      if (circleHitsSolid(ox, oz, PLAYER_RADIUS)) { ox = c.x; oz = c.z; }
      var swat = W.wanted >= 5;                 // 5★ brings out SWAT
      var cop = makeCopFoot(ox, oz, swat);
      cop.yaw = Math.atan2(W.player.x - ox, W.player.z - oz);
      W.peds.push(cop);
      c.vacant = true; c.deployed = true; c.speed *= 0.2; c.vx *= 0.2; c.vz *= 0.2;
      fx('jack', c.x, 1, c.z);
      if (swat) post('@LeonidaPD', 'SWAT deployed. 🚨');
    }

    /* ----- helicopter (4★+) ----- */
    var HELI_ORBIT = 34;       // hold this far out and circle, so it's visible (not straight overhead)
    function makeHeli() {
      // spawn off to the side, high up; descends to a circling standoff around the player
      var ang = rand(0, TWO_PI), R = 90;
      return { x: clamp(W.player.x + Math.cos(ang) * R, 4, WORLD - 4), z: clamp(W.player.z + Math.sin(ang) * R, 4, WORLD - 4),
        y: HELI_ALT + 14, yaw: 0, rotor: 0, hp: HELI_HP, maxHp: HELI_HP, hitFlash: 0, fireCd: rand(0.5, 1.2), orbit: ang, id: (W._id = (W._id || 0) + 1) };
    }
    function updateHeli(h, dt) {
      var pl = W.player;
      // circle the player at a standoff radius + altitude (visible, GTA-style), not directly overhead
      h.orbit += dt * 0.5;
      var tx = pl.x + Math.cos(h.orbit) * HELI_ORBIT, tz = pl.z + Math.sin(h.orbit) * HELI_ORBIT, ty = HELI_ALT;
      h.x = lerp(h.x, tx, 1 - Math.exp(-1.2 * dt));
      h.z = lerp(h.z, tz, 1 - Math.exp(-1.2 * dt));
      h.y = lerp(h.y, ty, 1 - Math.exp(-1.5 * dt));
      h.yaw = Math.atan2(pl.x - h.x, pl.z - h.z);
      h.rotor += dt * 30;
      if (h.hitFlash > 0) h.hitFlash = Math.max(0, h.hitFlash - dt);
      var d = dist(h.x, h.z, pl.x, pl.z);
      h.fireCd -= dt;
      if (d < HELI_FIRE_RANGE && h.fireCd <= 0 && Math.abs(h.y - HELI_ALT) < 6) {
        h.fireCd = HELI_FIRE_CD;
        // fire down-and-toward the player from the gunner
        var dx = pl.x - h.x, dy = (pl.y + 1) - h.y, dz = pl.z - h.z;
        W.bullets.push(makeBullet(h.x, h.y - 1, h.z, dx, dy, dz, 'police', HELI_DMG));
        fx('muzzle', h.x, h.y - 1, h.z);
      }
    }
    function manageAir(dt) {
      // spawn helis at 4★+, target count rises with stars; despawn when heat clears
      var want = W.wanted >= 4 ? (W.wanted - 3) : 0; // 1 heli at 4★, 2 at 5★
      W.heliCd -= dt;
      if (W.helis.length < want && W.heliCd <= 0) { W.helis.push(makeHeli()); W.heliCd = 4; if (W.helis.length === 1) post('@LeonidaPD', 'Air support inbound. 🚁'); }
      for (var i = W.helis.length - 1; i >= 0; i--) {
        var h = W.helis[i];
        if (h.hp <= 0) { fx('explode', h.x, h.y, h.z); fx('explode', h.x, 1, h.z); W.helis.splice(i, 1); var hb = randInt(200, 400); W.money += hb; popCash(hb); post('@you', '🚁💥 Took down a chopper!'); continue; }
        if (W.wanted < 4 && dist(h.x, h.z, W.player.x, W.player.z) > 60) { W.helis.splice(i, 1); continue; }
        updateHeli(h, dt);
      }
    }
    function updatePoliceCar(c, dt) {
      if (c.vacant) { // parked empty cruiser: just bleed velocity
        c.vx *= Math.max(0, 1 - 2 * dt); c.vz *= Math.max(0, 1 - 2 * dt); c.speed *= Math.max(0, 1 - 2 * dt);
        return;
      }
      var tx, tz;
      if (c.spotted) { tx = W.player.x; tz = W.player.z; }
      else if (W.lkpValid) { tx = W.lkpX; tz = W.lkpZ; }
      else { tx = c.x + Math.sin(c.searchDir) * 20; tz = c.z + Math.cos(c.searchDir) * 20; }
      if (!c.spotted && d2(c.x, c.z, tx, tz) < 100) { c.searchRetarget -= dt; if (c.searchRetarget <= 0) { c.searchDir = rand(0, TWO_PI); c.searchRetarget = rand(1, 2.5); } }
      var desired = Math.atan2(tx - c.x, tz - c.z);
      c.yaw = angTowards(c.yaw, desired, 2.8 * dt);
      driveCar(c, dt, c.spotted ? 1 : 0.5, 0, false, false);
      var d = dist(c.x, c.z, W.player.x, W.player.z);
      if (c.spotted) {
        if (d < CAR_HALF_L + 1.5 && Math.abs(c.speed) > 14) hurtPlayer(12 * dt + 0.1, 0.06);
        // GTA-style: get out and fight on foot rather than shoot from inside the car
        var stopped = Math.abs(c.speed) < 4;
        if (!c.deployed && (d < COP_EXIT_RANGE || (!W.player.inCar && d < COP_FIRE_RANGE && stopped) || (stopped && d < POLICE_FIRE_RANGE))) {
          deployOfficer(c); return;
        }
      }
    }

    /* ----- pickups ----- */
    function updatePickups() {
      var p = W.player, r = p.inCar ? 2.4 : 1.8;
      for (var i = W.pickups.length - 1; i >= 0; i--) { var pk = W.pickups[i];
        if (d2(pk.x, pk.z, p.x, p.z) < (r + 0.6) * (r + 0.6)) {
          if (pk.type === 'cash') { var ca = randInt(25, 90); W.money += ca; popCash(ca, pk.x, pk.z); fx('cash', pk.x, 1, pk.z); }
          else { p.hp = clamp(p.hp + 35, 0, PLAYER_MAX_HP); fx('health', pk.x, 1, pk.z); }
          var np = randomRoad(); pk.x = np.x; pk.z = np.z; // recycle
        }
      }
    }

    /* ------------------------------- step -------------------------------- */
    function step(dt, input) {
      input = input || {};
      W.time += dt;
      if (W.fireCd > 0) W.fireCd -= dt;
      if (W.disguiseCd > 0) W.disguiseCd -= dt;
      if (W.flash > 0) W.flash = Math.max(0, W.flash - dt);
      for (var i = 0; i < W.peds.length; i++) if (W.peds[i].robbedCd > 0) W.peds[i].robbedCd -= dt;

      // store cooldowns + passive income + live net worth/goals + weather run every tick (even dead)
      for (i = 0; i < W.stores.length; i++) if (W.stores[i].cooldown > 0) W.stores[i].cooldown -= dt;
      passiveIncome(dt);
      recomputeNetWorth();
      checkGoals();
      updateWeather(dt);
      while (W.popups.length && W.time - W.popups[0].t > 1.6) W.popups.shift(); // prune faded cash popups

      if (W.state === 'wasted') {
        W.respawnTimer -= dt; ageFeed(dt);
        if (W.respawnTimer <= 0) { W.state = 'play'; W.money = Math.max(0, W.money - 100); W.wanted = 0; W.lkpValid = false; W.seen = false; W.police = []; W.helis = []; W.bullets = []; clearFootCops(true); W.currentShop = null; W.shopIndex = 0; W.player.armor = 0; if (W.job) { W.jobCombo = 0; W.job = null; } var pr = randomRoad(); W.player.x = pr.x; W.player.z = pr.z; W.player.hp = W.player.maxHp; W.player.y = 0; W.player.vy = 0; W.player.inCar = false; W.playerCar = null; post('@you', 'Out of the hospital, $100 lighter.'); }
        return;
      }
      if (W.player.hp <= 0) { wasted(); return; }

      // edge actions handled by renderer via input.actionPressed etc.
      if (input.enterPressed) tryEnterExit();
      if (input.robPressed && !W.player.inCar) { if (!robStore()) robNearest(); } // store robbery, else mug a ped
      if (input.buyPressed) tryOpenOrBuy();
      if (input.cyclePressed) cycleShop();
      if (input.safehousePressed) enterSafehouse();
      if (input.jobPressed) acceptJob();
      if (input.weaponSlot >= 0 && input.weaponSlot !== undefined) switchWeapon(WEAPON_ORDER[input.weaponSlot]);
      if (input.weaponCyclePressed) cycleWeapon(1);
      if (input.shoot) fireWeapon(input);
      // close the buy menu if the player wandered off
      if (W.currentShop && (W.player.inCar || !nearestShop(SHOP_RADIUS))) W.currentShop = null;

      // courier job: tick the timer + arrival/expiry (live play only — never while dead)
      if (W.job) {
        W.job.timeLeft -= dt;
        if (d2(W.player.x, W.player.z, W.job.dropX, W.job.dropZ) < JOB_RADIUS * JOB_RADIUS) completeJob();
        else if (W.job.timeLeft <= 0) failJob('time');
      }
      tickVigilante(dt);
      tickRampage(dt);
      tickZones(dt);

      if (W.player.inCar) updatePlayerCar(dt, input);
      else updatePlayerFoot(dt, input);

      for (i = 0; i < W.cars.length; i++) { var c = W.cars[i]; if (c.driver === 'ai') updateAiCar(c, dt); else if (c.driver === null) { c.vx *= Math.max(0, 1 - 2 * dt); c.vz *= Math.max(0, 1 - 2 * dt); c.speed *= Math.max(0, 1 - 2 * dt); } }
      resolveCarCollisions(); // fender-benders instead of tunneling
      // backward so a dead cop (updatePed -> false) can be spliced out index-safely
      for (i = W.peds.length - 1; i >= 0; i--) { if (updatePed(W.peds[i], dt) === false) W.peds.splice(i, 1); }
      managePolice(dt);
      manageAir(dt);
      updateBurningCars(dt);
      updateBullets(dt);
      updatePickups();
      ageFeed(dt);
    }
    // day/night phase advances continuously (~5 min/day); weather flips occasionally.
    // Pure scalar state the renderer reads; no gameplay effect, so headless-safe.
    function updateWeather(dt) {
      W.timeOfDay = (W.timeOfDay + dt / 300) % 1; // full day = 300s
      W.weatherTimer -= dt;
      if (W.weatherTimer <= 0) {
        W.weather = (W.weather === 'clear') ? (Math.random() < 0.5 ? 'rain' : 'overcast') : 'clear';
        W.weatherTimer = rand(40, 100);
      }
    }
    // tick wrecked cars: emit smoke, count down, then explode
    function updateBurningCars(dt) {
      for (var i = 0; i < W.cars.length; i++) { var c = W.cars[i];
        if (!c.onFire) continue;
        c.fireTimer -= dt;
        if ((W.time * 10 | 0) % 2 === 0) fx('smoke', c.x, 1.5, c.z);
        if (c.fireTimer <= 0) explodeCar(c);
      }
    }

    reset();

    return {
      world: W,
      step: step,
      constants: { TILE: TILE, MAP: MAP, WORLD: WORLD, T_ROAD: T_ROAD, T_BUILDING: T_BUILDING, T_PARK: T_PARK,
        T_WATER: T_WATER, WATER_MARGIN: WATER_MARGIN, DOWNTOWN: DOWNTOWN, PIER_COLS: PIER_COLS,
        CHANNEL_Z0: CHANNEL_Z0, CHANNEL_Z1: CHANNEL_Z1, BRIDGE_X0: BRIDGE_X0, BRIDGE_X1: BRIDGE_X1,
        CAR_HALF_L: CAR_HALF_L, CAR_HALF_W: CAR_HALF_W, PLAYER_HEIGHT: PLAYER_HEIGHT, WANTED_MAX: WANTED_MAX,
        CRIME: CRIME, SEARCH_GIVEUP_BY_STAR: SEARCH_GIVEUP_BY_STAR },
      _internal: { tryEnterExit: tryEnterExit, robNearest: robNearest, fireWeapon: fireWeapon, commitCrime: commitCrime,
        lineOfSight: lineOfSight, circleHitsSolid: circleHitsSolid, nearestCar: nearestCar, reset: reset, alertPolice: alertPolice,
        hurtPlayer: hurtPlayer, buyItem: buyItem, shopCatalog: shopCatalog, nearestShop: nearestShop, nearestProperty: nearestProperty,
        robStore: robStore, enterSafehouse: enterSafehouse, spawnPlayer: spawnPlayer, applyCarTier: applyCarTier, CAR_TIERS: CAR_TIERS, PROPERTY_DEFS: PROPERTY_DEFS,
        killPed: killPed, acceptJob: acceptJob, completeJob: completeJob, failJob: failJob, nearestDepot: nearestDepot,
        startVigilante: startVigilante, startRampage: startRampage, findPedById: findPedById,
        giveWeapon: giveWeapon, switchWeapon: switchWeapon, cycleWeapon: cycleWeapon, currentWeaponDef: currentWeaponDef,
        WEAPON_DEFS: WEAPON_DEFS, WEAPON_ORDER: WEAPON_ORDER, zoneAt: zoneAt, makeGangPed: makeGangPed }
    };
  }

  var GTA3D = { createEngine: createEngine, VERSION: '3.0.0' };
  if (typeof module !== 'undefined' && module.exports) module.exports = GTA3D;
  if (typeof window !== 'undefined') window.GTA3D = GTA3D;
})();
