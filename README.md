# CCTV Offline Version — Dr. Vision / V380 Pro local client

A from-scratch, **cloud-free local client** for a Dr. Vision 4+4MP dual-lens Wi-Fi PTZ camera
(V380 Pro "new platform", `com.macrovideo.v380pro`). The camera's protocol was reverse-engineered and
reimplemented in Node.js so recordings and live video can be retrieved **directly over the LAN / phone
hotspot** — no vendor app, no ads, no mandatory cloud. A prototype web UI runs on top. Cloud (remote
relay) mode is partially reverse-engineered and in progress.

## What works (verified against the real camera)
- LAN discovery, X25519 LAN-pass login, SD recording list + playback, full-segment → MP4
- Live view **SD + HD with audio** (dual-lens), via MSE / fragmented MP4
- Dual-lens split view, digital **zoom + pan**, per-lens **screen rotation** (persisted, works in fullscreen),
  24-hour **timeline** with click-to-play + auto-advance
- **PTZ**: press-and-hold pan/tilt move, home, recalibrate
- **Camera settings** read + write: image flip / night vision / anti-flicker, floodlight, mic & speaker
  volume, detection sensitivity, recording mode/quality, PTZ speeds
- **Cloud**: account login + bound-device list (both working live against the vendor API)

## In progress
- Cloud **remote relay** (view from anywhere, off-LAN): dispatch → relay session → tunnel + MQTT "wake"
  for pver≥5. The transport reuses the same IoT protocol wrapped in a relay header. See
  `findings-v380pro-2.2.92.md` §24 and `checkpoint.json` (`cloudModeRE`, `relayProgress`).

## Layout
| Path | What |
|---|---|
| `v380lan.mjs` | Core LAN protocol: framing, X25519 key exchange, session cipher, recordings |
| `v380cloud.mjs` | Cloud account login / device list / relay transport primitives |
| `cipher-sectype2.mjs`, `mp4mux.mjs` | AES cipher + complete-file MP4 muxer |
| `app/` | Web app — `server.mjs` (Node backend, :8777), `lib.mjs`, `fmp4.mjs`, `index.html`, `app.js` |
| `media-*.mjs`, `sd-*.mjs`, `replay-*.mjs`, `discover-*.mjs`, `*-probe.mjs`, `cloud-*.mjs` | Research / pipeline scripts |
| `findings-v380pro-2.2.92.md` | Full reverse-engineering notes (protocol, methods, hosts, crypto) |
| `checkpoint.json` | Project state, decisions, and the detailed protocol map (read this to resume) |
| `rea-local.*`, `rea-README.txt` | Wrapper for the REA APK-analysis tool (tooling not included) |

## Run the web app
Node 20+ (developed on Node 24). The camera must be reachable on your LAN / hotspot.
```bash
npm start            # = node app/server.mjs
```
Then open `http://localhost:8777` (or the LAN URL it prints) on any device on the same network.
- **Camera LAN password**: factory default is `origin`; override with env `V380_LAN_PASS` (never commit it).
- Note: `app/server.mjs` currently caches clips to a fixed path (`CACHE`) — adjust it for your machine /
  make it env-driven when porting.

## Cloud mode (optional, WIP)
Copy `cloud-creds.example.json` → `cloud-creds.local.json` and fill in your V380 account.
**`cloud-creds.local.json` is git-ignored — never commit real credentials.** The `cloud-*.mjs` runners then
exercise login / device-list (read-only checks print status only, never secrets).

## Security & privacy
- All camera + account credentials live ONLY in `*.local.json` files, which are git-ignored.
- The committed findings/state deliberately exclude the device's 9-digit cloud ID and all account secrets.
- Do not commit anything matching `*.local.*`, `*.secret*`, `.env`, or `credentials*` (see `.gitignore`).

## Branches
- **`main`** — this pipeline + reverse-engineering findings.
- **`web`** — the web application codebase (branch for front-end work).

## Next
Cloud remote relay is the active workstream; the following milestone is an Android app wrapping this Node
engine + web UI. See `checkpoint.json` for the current plan.

---
Reverse-engineered for interoperability and personal use with the owner's own camera.
