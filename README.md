# CCTV Offline — Android app (V380Local)

Android wrapper (`com.drvision.cctv`) that runs the reverse-engineered Node engine **on-device** via
**nodejs-mobile** and renders the web UI in a WebView — the same local pipeline as the desktop version
(the `main` branch of this repo), packaged for a phone. No vendor app, no cloud required for local use.

## How it works
- `app/src/main/cpp/` + `app/src/main/jniLibs/arm64-v8a/libnode.so` — embeds the Node runtime (nodejs-mobile).
- `app/src/main/assets/nodejs-project/` — the bundled Node app: our `server.mjs`, `lib.mjs`, `v380lan.mjs`,
  `cipher-sectype2.mjs`, `mp4mux.mjs`, `fmp4.mjs`, plus the web UI (`app/index.html`, `app/app.js`).
- `MainActivity.kt` / `NodeBridge.kt` — launch the Node server (port 8777), wait for it to accept, then
  load `http://127.0.0.1:8777` in a WebView.

## Build
- Android Gradle Plugin 8.5.2, Kotlin 1.9.24, Gradle 8.5, NDK 26.1.x, compileSdk 34, **arm64-v8a only**.
- Create `local.properties` with your SDK path (git-ignored): `sdk.dir=/path/to/android-sdk`
- `nodejs-mobile-headers/` (node/v8 headers) and `app/src/main/jniLibs/arm64-v8a/libnode.so` are **vendored**
  so the native build works without fetching nodejs-mobile separately.
- Build a debug APK: `gradle assembleDebug` (or open in Android Studio and Run).

## Install the prebuilt APK
A prebuilt debug APK (arm64-v8a) is at [`dist/app-debug.apk`](dist/app-debug.apk):
```
adb install dist/app-debug.apk
```

## On-device notes / TODO
- Make the Node server's clip-cache path app-internal (the desktop `server.mjs` currently hardcodes a
  Windows path — override via env/arg from the launcher).
- Permissions the app needs on the phone: location / `NEARBY_WIFI_DEVICES` (Android 13+) for UDP camera
  discovery, and a held `MulticastLock` for the whole app lifetime.
- Default live view to the SD sub-stream first (640x720); HD is High-profile L5.1 ~6MP and some phone HW
  decoders may choke.

See the **`main`** branch for the full reverse-engineering findings (`findings-v380pro-2.2.92.md`) and the
desktop pipeline; **`web`** for the web codebase.
