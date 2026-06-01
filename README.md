# GTA 7: JS

A little GTA-style open-world game I built in plain JavaScript — no engine, no build step. Open `index.html` and pick **3D** (third-person, Three.js) or **2D** (top-down, Canvas).

> Not the real GTA 7 (that's Rockstar's, and nobody's building that in JS). Just a fun homage.

## Play

Open `index.html` in a browser. The 3D version streams Three.js from a CDN, so it needs internet the first time. The 2D version is fully offline.

**On a phone?** The 3D version auto-detects touch and shows on-screen controls — a floating left stick to move/drive, drag the right side to look, and buttons for everything else. Same game, just thumbs.

## Controls (3D)

- **WASD** drive/move · **Shift** run · **Space** jump (or handbrake in a car)
- **Mouse** look · **right-click** aim · **click** shoot
- **F** enter car / carjack · **E** rob (store or person) · **B** shop / **N** next item
- **H** lie low at your apartment · **J** courier job · **1-4** / **Q** switch weapon

## What you can do

Steal cars, shoot it out with cops (they get out and fight on foot, choppers show up at 4 stars, SWAT at 5), and build an empire: rob stores, run courier jobs (chain deliveries for big combos), hunt bounties, take over gang turf, then spend it all on weapons, faster cars, body armor, and apartments that pay you rent. There's a full day/night cycle and weather too.

Wanted system works like GTA — crimes only count if someone sees them, and you shake the cops by breaking line of sight or switching cars. Loops escalate the more you chain them, with permanent unlocks for sticking with one.

## Dev

```bash
node test/headless.js      # 2D engine tests
node test/headless3d.js    # 3D engine tests
node test/browser3d.js     # boots the 3D build in headless Chrome
```

Game logic lives in `engine3d.js` (pure, testable) / `game.js`; the renderers are `game3d.html` / `game2d.html`.
