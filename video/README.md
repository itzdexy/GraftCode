# Graft's launch film

A 50-second film of Graft at work. Everything on screen is the real renderer: the app is built
as a plain web page, framed on a 1920×1080 stage, and shot one frame at a time.

```
film/
  film.mjs          shoots the film: browser, clock, encoder
  scenes.mjs        the film itself, scene by scene: what happens and where the camera is
  stage/            the page the film is shot on: window frame, camera, captions, titles
  page/time.js      a clock the film script steps, in place of the page's own
  app/bridge.js     stand-in for the preload bridge (canned answers from the main process)
  app/turns.js      the agent's side of each scene, sent as real session events
  app/overlay.js    the caption buttons, the text caret and the pointer
```

## Shoot it

You need the repo's dependencies installed (`npm ci` in the repo root) and `ffmpeg` on your PATH.

```bash
npm run app     # builds the renderer into .cache/app (again after any change to src/renderer)
npm run film    # the whole film -> out/graft-launch.mp4
```

One scene at a time, while working on it:

```bash
node film/film.mjs agents            # out/scenes/agents.mp4
node film/film.mjs agents --sheet    # a picture every half second -> .cache/stills/agents.jpg
```

## How it works

- **Time.** `page/time.js` replaces timers, `requestAnimationFrame`, `Date` and
  `performance.now`, and pauses every CSS animation and transition. The film script moves this
  clock 1/60 s, lets the page settle, and takes a picture. A frame can take as long as it likes
  to draw, and the film still plays at an exact 60 frames a second, the same every time.
- **The app.** `app/bridge.js` answers the renderer's IPC calls, and `app/turns.js` sends the
  session events a real turn sends (text deltas, tool calls, permission requests, checks, agent
  runs). The renderer does the rest, so what you see is its own rendering. The provider list
  comes from `resources/catalog/models.json`.
- **The picture.** Frames are drawn at 3840×2160 and scaled to 1920×1080 by ffmpeg (x264,
  CRF 15, bt709).
- **No ports.** Pages are served from disk through request interception, and the browser is
  driven over a pipe, so nothing depends on the loopback network.

## Change it

- **Words and pacing:** `film/scenes.mjs`. Captions are the README's own sentences.
- **What the agent does:** `film/app/turns.js`.
- **Type, colours, titles:** `film/stage/stage.css`, which follows the app's tokens.

The film has no sound. To add a track:

```bash
ffmpeg -i out/graft-launch.mp4 -i music.wav -c:v copy -c:a aac -b:a 192k -shortest out/graft-launch-music.mp4
```
