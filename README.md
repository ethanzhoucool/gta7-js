# GTA 7: JS

A little GTA-style open-world game I built in plain JavaScript — no engine, no build step. Open `index.html` and pick **3D** (third-person, Three.js) or **2D** (top-down, Canvas).

> Not the real GTA 7 (that's Rockstar's, and nobody's building that in JS). Just a fun homage.

## Play

Open `index.html` in a browser. The 3D version streams Three.js from a CDN, so it needs internet the first time. The 2D version is fully offline.

**On a phone?** The 3D version auto-detects touch and shows on-screen controls — a floating left stick to move/drive, drag the right side to look, and buttons for everything else. Same game, just thumbs.

## Controls (3D)

- **WASD** drive/move · **Shift** run · **Space** jump (or handbrake in a car)
- **Mouse** look (look up to aim at choppers) · **right-click** aim · **click** shoot
- **F** enter/steal a car, hijack a cop car, or walk into a shop (and back out) · **E** rob (store or person)
- **B** buy / **N** next item · **H** lie low at your apartment · **J** courier job · **1-4** / **Q** switch weapon

## What you can do

Steal cars (including cop cars — yank the officer right out), shoot it out with the police (they get out and fight on foot, choppers show up at 4 stars — aim up and shoot them down — SWAT at 5), and build an empire: rob stores, run courier jobs (chain deliveries for big combos), hunt bounties, take over gang turf, then spend it all on weapons, faster cars, body armor, and apartments that pay you rent. You can walk *into* the shops — the gun shop is a proper gun shop inside. There's a full day/night cycle and weather too.

It's set in a big San Francisco-ish city — a bay, the Golden Gate bridge you can actually drive across to a second landmass, a downtown highrise cluster, pastel row-houses, and sidewalks lining the streets.

Wanted system works like GTA, but heat scales with the crime: a mugging is one star, a shootout climbs fast, and the cops keep searching longer the hotter you are. Crimes only count if someone sees them, and you shake the cops by breaking line of sight or switching cars. Loops escalate the more you chain them, with permanent unlocks for sticking with one.

## Dev

```bash
node test/headless.js      # 2D engine tests
node test/headless3d.js    # 3D engine tests
node test/browser3d.js     # boots the 3D build in headless Chrome
```

Game logic lives in `engine3d.js` (pure, testable) / `game.js`; the renderers are `game3d.html` / `game2d.html`.
