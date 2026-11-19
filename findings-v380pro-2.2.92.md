# V380 Pro 2.2.92 — static protocol findings (2026-11-18)

**Status: static observations only.** Nothing below has been verified against the camera.
REA (6.9.0, JADX provider, jadx-headless-mcp 0.7.1) decompiled the shipped APK; the APK was never executed.

## Artifacts

| Item | Value |
|---|---|
| Phone | `M2101K6P` (`sweetin`), Android 13 / SDK 33, build `TKQ1.221013.002 test-keys`, ADB serial `59d45ae8` |
| Package | `com.macrovideo.v380pro` versionName 2.2.92, versionCode 230, minSdk 24, targetSdk 35, installer `com.android.vending` |
| `base.apk` | SHA-256 `41777ca38be5fe6c74a1a73dab25b6fcf83e623533ee85a6f7a24b5276e473ff` (285,952,280 B), matches on-device hash |
| `split_config.arm64_v8a.apk` | SHA-256 `ed38d0d7dd1f9a0067d3538fa5293f53b2ab90354dcbc8f711dcc0ed6da230d8` (43,285,953 B), matches on-device hash |
| `libhsMediaLibrary.so` (arm64) | SHA-256 `3bae3985487662aa8d4a5500c848e0cdbc2f436da4039112040136dfc794a484`, holds all `Java_com_macrovideo_sdk_media_HSMediaLibrary_*` exports |
| Local copies | `C:\Users\ankitc\cctv-v380-work\` (outside OneDrive; see checkpoint for why) |

REA evidence bundles, raw JSON and extracted method sources are under `C:\Users\ankitc\cctv-v380-work\rea\` (`out\`, `src\`).

## 1. Four protocol families; the app may treat this camera as "new platform"

`GlobalConfiguration.DeviceProtocolType` has V380 / XVV / SFV / ICS variants, and each has its own discovery strings
(`DeviceLanUDPScanner.changeDevLanSearchProtocol`, ev_69a1a036…). V380 uses `NVDEVSEARCH^100` and the
`NVDEVRESULT^100|^200|^300` replies.

## 2. LAN discovery (likely reason the earlier probe got no reply)

- **Sender** (`DeviceLanUDPScanner$BroadcastSenderThread.run`, ev_dd711ab9…): a socket bound to **UDP 10008** sends
  `NVDEVSEARCH^100` to the route broadcast address and to `255.255.255.255`, both on **port 10008**, roughly every 100 ms.
- **Receiver** (`…$BroadcastReceiverThread.run`, ev_d140e4a5…): a separate socket bound to **UDP 10009** collects replies.
  - `NVDEVRESULT^100/^200` (or binary cmd 1280) means old platform.
  - `NVDEVRESULT^300` means **new platform**. If the reply's port is 0, the app uses `Protocol.IOT_PLATFORM_DEVICE_DEFAULT_PORT` = **8089**.
  - A device found this way gets `nOnLineStat = 101` ("in LAN").
- The 2026-11-18 probe (`discover-camera.mjs`) sent unicast from an ephemeral port and listened only on that port, never on 10009.
  Its "no reply" result therefore does **not** show that discovery is unsupported.
- **TCP 8089 has never been tested.** The earlier refused ports were 8800, 554, 80, 443, 8899 and 5050.
- `discover-camera-v2.mjs` reproduces the app's behaviour: bind 10008 and 10009, broadcast, then a TCP-connect-only check on 8089.
  **It has not been run yet** because permission was declined this session.

## 3. Login paths (`LoginHelper.login(Context, DeviceInfo, int, int)`, ev_83d132d7…)

- **Old platform** (`platformType < NEW`): classic binary TCP login, `LoginHelper.b(ip,user,pwd,port,devId)` (ev_0d7123af…).
  It uses the port from discovery (not necessarily 8800). The password goes through `GlobalDefines.changeDevPwd` first,
  which is the identity unless longer than 28 chars (ev_3b6dbc09…). This is the family the public C# client implements.
- **New platform, LAN-pass mode** (`isLanPassMode()` or save type `IOT_LAN_ADD`/`IOT_LAN_SEARCH`):
  `keyExchangeByLanSync(cameraIp, 8089, lanPassword)` (ev_52a0a2f1…). This path is **fully local**:
  1. Over TCP it sends a framed JSON request (`Protocol.createCommonJsonRequestBuffer`, `CMD_COMMON_IOT`,
     `METHOD_ID_IOTC_LANPASS_REQUEST`) with `act:1`. The `verify` object contains:
     - `cKM` = base64(appPublicKey XOR magic)
     - `cS` = base64(sha256(cKM bytes ‖ lanPassword))
     - `tz` and `ts`
  2. The camera returns `dK`/`dS`. `dS` must equal base64(sha256(dK)).
  3. Session key = `ED25519Utils.getSKeyByte(dK)`, plus `sid`, `perm` and `origin`.
  4. Code 1119 means wrong password.
  5. The resulting handle has `MRMode=false`, `bInLan=true`, port 8089 and no MR server.
- **New platform, account-bound (normal cloud-added device)** (`LoginHelper.a(Context,DeviceInfo,int)`, ev in `src\…LoginHelper.a.0.java`):
  - The session key comes from **vendor HTTPS** `keyExchangeFromHttpsSync(accessToken, devId, …)`, possibly cached by `KeyExchangeHelper`.
  - If the device was LAN-discovered (`nOnLineStat==101`), media goes **direct to camIP:8089** (`MRMode=false`). Otherwise it goes through the relay.
  - A `pver >= 5` variant (`b(Context,DeviceInfo,int)`) uses `callMqServiceFromHttpsSync` and `keyExchangeFromMqSocket`.

## 4. SD recording listing

- `RecordFileHelper.getRecordFilesSegmentNewPlatform` (ev_91511a82…) tries LAN first. On `-257` it retries via the relay, and the reverse also happens.
  **This silent fallback must be ruled out when testing vendor independence.**
- For `pver >= 5`, `RecordFileHelper.a(boolean isMR, …)` (ev_b5dba39a…) does the following, **even on the LAN path**:
  1. It waits for `MqttHelper.isConnected` (vendor MQTT broker).
  2. It publishes an MQTT "exchange"/"search" signal.
  3. Only then does it connect TCP to `camIP:8089`.

  The account-bound flow on newer firmware may therefore need vendor MQTT to authorise each local session.
  The firmware's `pver` for this camera is unknown.
- `isLanPassMode` is consulted by 26 static call sites (ev_e4ad5a28…), including
  `HSFileDownloader.StartDownloadRecSegment`, `HSMediaPlayer.setDeviceInfo`, `DeviceConfigSetting.getDeviceSDCardInfo`
  and `startActionRecOpt`. That points to a dedicated local path for SD download and playback in LAN-pass mode. **Not yet traced.**

## 5. Media transport is native

The SD playback and download entry points are JNI methods on `HSMediaLibrary`, implemented in `libhsMediaLibrary.so`:
`startPlayback`, `startDownload`, `seek2TimeSegment`, `cipherJsonData`, `refreshMqKeyExchangeInfo` and others.
Callbacks such as `jniCallKeyExchangeRes`, `jniCallMqRefreshKeyExchange` and `jniCallMqErrorStartP2p` show that the native
layer also interacts with the MQTT/key-exchange state. Wire formats for SD segment listing and download beyond the Java
request builders need **Ghidra** on `libhsMediaLibrary.so`.

## Verified on the camera (2026-11-18, user-approved, no login sent)

- `discover-camera-v2.mjs` received **27 identical replies on UDP 10009** from 172.20.10.2. Each was 110 bytes with prefix
  **`NVDEVRESULT^300`**, which marks a **new-platform device**. No replies arrived on 10008.
- Fields as interpreted by `Functions.ParseDevice` (ev_84c15460…):

  | Field | Value |
  |---|---|
  | [2] | MAC |
  | [3] | IP |
  | [9] | port = 0, so the app uses 8089 |
  | [12] | 9-digit device ID |
  | [14] | netType = 1 |
  | [15] | bindState = 2 (meaning not yet established) |
  | [16] | config-ability bitmask |
  | [17] | specDevType = 0 |

  The raw reply, including the ID and MAC, is kept only in the git-ignored `camera-discovery-v2.local.json`.
- **TCP 8089 accepted a connection** in 111 ms. It was closed immediately; no bytes were sent.
- The earlier "no reply" came from listening on the wrong port. The camera's protocol family matches the static new-platform path.

## Implications / open questions

1. ~~Discovery reply?~~ Yes: `NVDEVRESULT^300` on UDP 10009.
2. ~~TCP 8089?~~ Open.
3. Does this camera have, or can it be given, a **LAN password** (LAN-pass mode)?
   - App resource names exist: `setting_lan_pass_tip`, `pls_set_new_lan_password`, `lan_pass_error` and `forget_lan_pass_can_reset_device`.
   - Code paths exist: `LoginHelper.changeLanPassSync` and `resetLanPassSync`.
   - If so, a fully local login exists in the vendor's own design.
   - Note: `forget_lan_pass_can_reset_device` suggests that losing a LAN password may require a device reset. Treat setting one as a deliberate decision.
4. The camera's `pver`. If it is ≥5 and LAN-pass mode is unavailable, local SD access may depend on vendor MQTT signalling.

## 6. LAN-password ("LAN safety password") flow in the official app (static, 2026-11-18)

- **Add flow** (`AddDeviceActivity$LanDeviceKeyExchangeThread.run`, ev_0e93d98d…):
  1. The app calls `keyExchangeByLanSync(ip, 8089, mLanPass)`.
  2. On `-261` (`RESULT_CODE_FAIL_PWD_ERROR`, mapped from camera code 1119 `VALUE_NOT_MATCH`), it **retries automatically with the
     hard-coded string `"origin"`**. If that also fails, it shows `showInputLanSecurityPassDialog`.
  3. On success, if the camera reports `origin == 1` (still on its factory LAN password), the app shows `setting_lan_pass_tip`
     (`showSettingLanPassTipDialog`, ev_cea00c7f… / ev_f6be160c…). That opens `LanDeviceSetPasswordFragment` (START_TYPE_NEARBY = 1).
  4. The device is stored as `SERVER_SAVE_TYPE_IOT_LAN_ADD` in the app's separate LAN-device database (`DatabaseManager.getLanDevice`).
- **Setting/changing:** `LanDeviceSetPasswordFragment.SetLanPasswordThread` → `LoginHelper.changeLanPassSync(handle, currentPwd, newPwd)` (ev_1cf5ffc3…, ev_94fa7b51…).
  - It requires an existing session (`sKey`/`sid`).
  - It sends `{act:2, change:{lprC: b64(newPwd XOR magic), lprS: b64(sha256(lprC bytes ‖ currentPwd))}}` encrypted with the session key.
  - `currentPwd` is the app's stored `DeviceInfo.strPassword`. When opened from Settings (START_TYPE_SETTING = 2 / SET_LAN_PASS = 3),
    only new + confirm fields are shown.
  - On `1104` (session expired) it re-runs `keyExchangeByLanSync` with the current password and retries.
- **Settings screen of a cloud-added camera:** the "Device password" item (`cl_config_devie_pwd`) opens
  `DeviceConfigSettingDeviceAutoPwdFragment`, which sets the classic device password and supports QR sharing. **That is not the LAN password.**
  The LAN-password item (`DEVICE_PASSWORD_LAN_PASS`) is only added while the camera is opened in LAN-pass mode
  (`DeviceConfigSettingHomePageFragment.initNewUiView`, `onClicked`).
- `resetLanPassSync` (act 3/4 with an `RDSC` token) has **no callers** in 2.2.92 and is marked `@Deprecated`.
- Implication: an unconfigured camera should accept the LAN key exchange with the app's built-in factory value `"origin"`.
  This is a vendor-designed local login that needs no cloud and no settings change. **Not yet tested.**

## 7. LAN key-exchange wire format (static, from Protocol/ED25519Utils/LoginHelper)

All multi-byte integers are **little-endian** (`Functions.IntToBytes`/`BytesToInt`, ev confirmed).

**Frame (LAN, non-MR):** 16-byte header + body
| Offset | Size | Field | Value for LANPASS key exchange |
|---|---|---|---|
| 0 | 4 | cmd | `CMD_COMMON_IOT` = 939722776 (0x38030818) |
| 4 | 1 | version | 1 |
| 5 | 1 | secureType | 2 |
| 6 | 1 | sessionId byte (b2) | 0 (key exchange) |
| 7 | 1 | magicNum (b3) | random 1..127 |
| 8 | 4 | (zero) | 0 |
| 12 | 4 | bodyLen | length of encrypted body |
| 16 | n | body | `cipherJsonData(1, 2, headerJsonBytes, len, key)` |

(MR mode prepends a 64-byte forward header with cmd 1200 = `CMD_DATA_FORWARD_DATA_TRANSPORT`; not needed on LAN.)

**Body before encryption** (`createCommonJsonHeader`):
`{"id":randomId, "method_id":196870 (METHOD_ID_IOTC_LANPASS_REQUEST), "chn":1, "ts":epoch_s, "params":{...}}`

For the **key exchange** the `params` are (`keyExchangeByLanSync`, ev_52a0a2f1…):
`{"act":1, "verify":{"cKM":b64(appPubKey XOR magic), "cS":b64(sha256(cKMbytes ‖ lanPassword)), "tz":customTZ, "ts":epoch_s}}`
where `appPubKey` = X25519 public key (`ED25519Utils.getPKeyByte()`); `cKMbytes` is the XOR'd 32 bytes **before** base64;
XOR uses the 1-byte magic repeated (`ED25519Utils.xor`).

**Response:** header cmd must equal 939722776; body decrypted with `cipherJsonData(0, secureType, …, key)` then Gson→`KeyExchangeLanJsonParse`.
Success when `result.code == 1000` and `method_id == 196871`; `data.verify.dK`/`dS` with `dS == b64(sha256(decode(dK)))`.
Session key = `ED25519Utils.getSKeyByte(decode(dK))` = **X25519(appSeed, cameraPubKey)**, 32 bytes.
`origin == 1` ⇒ camera still on factory LAN password. Wrong password ⇒ code 1119 → app result -261.

**Crypto primitives:**
- X25519 is native (`curve25519_CalculatePublicKey`/`CreateSharedKey` in a `System.loadLibrary` lib), standard Curve25519.
  App seed = 32 random ASCII chars (`Functions.getCharAndNumr(32)`).
- `sha256` = standard SHA-256 (`GlobalDefines.sha256`).
- **Pre-session key for the LANPASS cipher** = `LoginHelper.i`, a fixed 32-byte array:
  `363ae5281638cf84969a634e9f966a98b573d1ffe937b277d1f1d62b38748ae5`
- **`cipherJsonData(dir, secureType, data, len, key)` is NATIVE** (`HSMediaLibrary`, in `libhsMediaLibrary.so`).
  secureType 1 and 2 are two different native ciphers; secureType 2 is used for IoT/LAN. **This is the one routine still to be recovered (Ghidra).**
  `sRandomKey = "macrovideo+*#!^@"` is the OLD-platform login key (`Functions.encrypt`), not used on the IoT/LAN path.

## 8. Body cipher recovered (Ghidra, native)

`Protocol.cipherJsonData(op, secureType, data, len, key32)` (Java) splits the 32-byte key:
**AES key = key32[0:16], IV = key32[16:32]**; output buffer = len+32; calls native
`HSMediaLibrary.cipherJsonData(op, secureType, data, len, out, key16, iv16)`.

Native chain: `libhsMediaLibrary.so cipherJsonData @0x9ab98` → `mvt_cipher_start/process/finish`
(PLT) → `libHSMbedtls.so mvt_cipher_start @0x10e3f8` (mbedtls):
- **secureType 2** → `mbedtls_cipher_info_from_type(5)` = **AES-128-CBC**, setkey 128 bits, set_iv 16, padding mode 0 = **PKCS7**.
- **secureType 1** → type 2 = **AES-128-ECB**, 128-bit key, no IV, PKCS7.
- op arg: 1 = encrypt, 0 = decrypt.
`mvt_cipher_process` does manual 16-byte block buffering around `mbedtls_cipher_update`; net result is
standard CBC, PKCS7 applied at `mbedtls_cipher_finish`. No IV is prepended to the ciphertext (IV comes from the key).

Reimplemented in `cipher-sectype2.mjs` (Node `aes-128-cbc`/`aes-128-ecb`, PKCS7). Round-trip and padding self-tests pass.
For the LANPASS exchange the key is `LoginHelper.i`, so **AES key = 363ae5281638cf84969a634e9f966a98, IV = b573d1ffe937b277d1f1d62b38748ae5**.

Probe `lan-login-probe.mjs` is now complete (X25519 + SHA-256 password proof + this cipher + framing).

## 9. VERIFIED: local authentication succeeds with our own code (2026-11-19)

`node lan-login-probe.mjs 172.20.10.2 8089` (factory value `origin`, no password change):
- TCP connect to 8089; response header cmd = 939722776 (CMD_COMMON_IOT), secureType 2, body 272 bytes.
- Body decrypted with our AES-128-CBC/PKCS7 (key `LoginHelper.i`) → valid JSON.
- **result.code = 1000 (OK)**, **origin = 1** (camera still on factory LAN password), camera returned `dK`.
- X25519(appSeed, cameraPubKey) → **32-byte session key** derived.

This proves end-to-end: discovery, 16-byte framing, AES body cipher, X25519 key agreement and the SHA-256
password proof are all correct, and **local login works with no vendor cloud**. The camera accepts the vendor's
built-in factory LAN value, so no password needed to be set. Next: use `sid`+`sKey` for SD recording listing and clip retrieval.

Note: if a LAN password is ever set in the app, `origin` stops working and that password is required (held locally only).

## 10. VERIFIED: SD recording listing with our own code (2026-11-19)

`node sd-list.mjs` (auth with factory `origin`, then record-file-list queries) over the hotspot, no cloud:
- Request `METHOD_ID_REC_FILE_LIST_REQUEST` (197152), secureType 2, body encrypted with the **session key** `sKey`,
  header sid byte = session sid; params `{filter, mode, start, end}` (start/end = absolute epoch ms).
  **filter = 15** (all-types bitmask — filter 0 returns nothing); mode: 1=BRIEF, 2=LIST, 3=EVENT.
- Response `method_id` 197153, `data.list[]` of `{s: ms offset from window start, d: duration ms, t: type}`,
  plus `data.brief[]` "YYYYMM-<dayBitmask>" (bit i => day i+1) in BRIEF mode. `slice`/`flag` for paging (single frame sufficed here).
- Result: **62 segments** — 2026-11-18 (60) and 2026-11-19 (2); types continuous(1)/motion(2); durations ~6–243 s.
  Absolute times reconstruct as windowStart + s (UTC).

End-to-end proven locally: discovery → LAN key exchange → session key → **SD recording listing**. No vendor cloud, no settings changed.
Shared protocol in `v380lan.mjs`; tools `sd-list.mjs` (brief→per-day) and `sd-day.mjs`. Still remaining for the milestone: download one segment and play it.

## 11. SD segment retrieval — protocol mapped, params in progress (2026-11-19)

Download path: `HSFileDownloader.StartDownloadRecSegment` (overload 3) → native `HSMediaLibrary.startDownload`
→ `HSFileDownloader::startDownload(int, tagRecFileParam*)` → TFV3 replay threads (`replayDataCtrlThreadTFV3` /
`replayDataGetterThreadTFV3` → `dataCtrlThreadFunc`/`getDataFromDeviceOrServer`). It reuses TCP 8089 + the same
framing/cipher as listing.

Request builder `dataCtrlThreadFunc@0x165468` (Ghidra base 0x100000) sends **METHOD_ID_REPLAY_CTRL_REQUEST = 197154
(0x30222)** via `initIotcReq` (same frame + `cipherJsonData` with the session key). Params (cJSON):
`{"sts": <long>, "pts": <long>+1, "time_id": <n>, "frames": 200, "rtype": <int>, "vsspec": <int>}`.
A continuation request `{"frames": N}` pulls more. `initIotcReq@0x19a9ac` confirms frame = cmd 0x38030818 + body
`{id, chn, method_id, ts, params}` encrypted with secureType/key.

Java inputs (`HSTFCardRecNewPlatformInfo`): `lStartTime, lEndTime, nSegmentID, nFileType, lPlayTime(=lStartTime-rawOffset),
nFileSource=6, uYear..uStartSec`. Exact sts/pts/rtype/vsspec mapping is being read from the JNI `startDownload`
(`tagRecFileParam` fill) — my first guess (sts=absStartMs, pts=absStartMs+1, rtype=0, vsspec=0) returned
**result code 1106 = RESULT_CODE_PARAM_ILLEGAL** (plaintext control frame, secureType 0), which confirms the camera
accepts our framing/session and validates params. `replay-probe.mjs` sends the request and captures response frames.

Remaining to play a clip: (a) correct replay params; (b) response media-frame format (`parseReplayMediaInfo`,
`parseCommonJsonRespHeader`) and the per-frame media cipher (`iotc_ms_frame_cipher_init/update/end`); (c) reassemble
H.264/H.265 NALUs (strings `h264_parse_sps`/`h265_parse_sps`) into a playable file.

## 12. Replay START accepted; media on a separate channel (2026-11-19)

The initial replay request (native log 0x696) is minimal and is now **accepted (result code 1000)**:
`METHOD_ID_REPLAY_CTRL_REQUEST` (197154), secureType 2, session key, header sid byte, params
`{"sts": <segment start, epoch ms>, "pts": 0, "time_id": <float counter>, "rtype": <segment type>}`
— NO `frames`/`vsspec` (including those gave 1106 PARAM_ILLEGAL). The camera replies encrypted (secureType 2)
`{"data":{}, "method_id":197155, "result":{"code":1000}}` (REPLAY_CTRL_RESPONSE). `replay-sweep.mjs` found this;
`replay-probe.mjs` reproduces it. A continuation `{"frames": N}` on the same socket is also acked but streams no media.

So the control socket only starts/acks the replay. The **media bytes flow on a separate channel** handled by
native `getDataFromDeviceOrServer` (opens its own connection; uses `initIotcReq` + `recvfrom`, decrypts each media
frame with `iotc_ms_frame_cipher_init/update/end`, parses via `parseReplayMediaInfo`/`parseFrameDataV20`, reassembles
H.264/H.265). Remaining work to produce a playable clip = reverse that channel: (a) the media-channel request it sends,
(b) the media frame header format, (c) the `iotc_ms_frame_cipher` algorithm/key, (d) NALU reassembly + mux to a file.
Request builder: `dataCtrlThreadFunc@0x165468`; getter: `getDataFromDeviceOrServer@0x166ac8`.

## 13. Media streaming channel architecture (2026-11-19)

Native `getDataFromDeviceOrServer@0x166ac8` (TFV3 getter) runs the media transfer on its OWN TCP connection to
camIP:8089, in three steps:
1. **Media key exchange** — method `0x30108` = 196872 (`MVS_IOTC_MTHID_Q_TSK_EXCHANGE`), plaintext (secureType 0),
   params `{"uuid": <client uuid>, "cS": <proof/pubkey>}`. Response parsed by `parseKeyExchange` → per-channel
   sid + key + iv (logged "sid=%d, keyHex=%s, ivHex=%s"). Error string: "keyExchange uuid info not match".
2. **Replay request** — method `0x30222` = 197154, secureType 2 with the media key, params
   `{sts, pts+1, time_id(float), frames, speed:10(0x4024…), mode, video:1, audio:1, rtype, vsspec?}`.
   Keep-alive: method `0x30200` `{flag:2, tms1:0, decode_tms:0}` every ~2 s.
3. **Media frames** — each frame decrypted with `iotc_ms_frame_cipher_init/ _cipher/ _end` (per-frame stream cipher
   seeded from the media key/iv). Info frames have method_id `0x30224` → `parseReplayMediaInfo`; others are
   H.264/H.265 media (`parseFrameDataV20`, `h264_parse_sps`/`h265_parse_sps`), with audio/video lost-frame tracking.

`media-probe.mjs` reproduced steps using the LOGIN session key: the replay request is ACKed (code 1000) but no media
streams, because the data channel needs its own step‑1 exchange first. Remaining: reverse `parseKeyExchange` (step‑1 key
derivation) + `iotc_ms_frame_cipher` (frame cipher) + the frame header, then reassemble NALUs. These are the last unknowns.

## 14. MILESTONE: SD clip retrieved, decrypted and validated as playable H.264 (2026-11-19)

Full local pipeline in our own code (`media-save.mjs` + `v380lan.mjs` + `cipher-sectype2.mjs`), no vendor cloud:
1. LAN-pass login (factory `origin`) → session sid + sKey.
2. Record-file-list → pick a segment (its `s` offset gives the absolute start).
3. **Replay request** method 197154 on one TCP/8089 connection, params that make it STREAM:
   `{sts: <segment start epoch ms>, pts: sts+1, time_id:0, frames:200, speed:10, mode:2, video:1, audio:1, rtype:<type>}`
   (pts MUST be non-zero; pts:0 only starts/seeks. For LAN-pass the data channel reuses the login sKey — no separate
   TSK key-exchange needed, since the session sid is already set.) Keep-alive method 0x30200 `{flag:2,tms1:0,decode_tms:0}`.
4. Camera streams frames: control ack (0x38030818), **REPLAY_INFORMATION** (0x38030822, method 197156) with
   `vattr{codec:4,width:2304,height:2592}` + `aattr{codec:107,8000Hz,16-bit,mono}`, then **media data frames** (0x38030820).
5. **Frame decryption** = AES-128-CBC, key `sKey[0:16]`, IV `sKey[16:32]`, **no padding, IV reset per frame**, over the
   16-byte-aligned prefix (tail < 16 bytes kept verbatim). Each decrypted video frame = 32-byte header + Annex-B NAL(s).
6. Keep valid H.264 NAL types (audio codec-107 frames interleave and are dropped). Result: a clean Annex-B .h264.

**Verified:** captured ~5 s = 200 media frames (1.69 MB). Clean stream = 3× SPS/PPS/IDR + 127 P-frames, **High profile,
level 5.1**. Our own Exp-Golomb SPS parse → **2304×2592**, exactly matching the camera's reported resolution → the
decrypt + reassembly are correct. File: `clip-clean.local.h264` (git-ignored), plays directly in VLC / ffmpeg.

This satisfies the first milestone: our own code retrieves and plays an existing microSD recording from this exact camera,
locally over the phone hotspot, with no vendor cloud and no camera changes. Remaining polish: longer captures (loop the
replay window to span a full segment), audio (G.711-family codec 107) mux, MP4 container, and running on the hotspot phone.

## 15. Full-length segment capture (2026-11-19)

Media-data frame header (32 bytes, after per-frame AES-CBC decrypt):
`[1]=type (1=I-frame, 2=P-frame, 4=audio)`, `[2..3]=u16 sequence`, `[6..7]=u16 payload size`,
`[10..11]=u16 ms timestamp`; the Annex-B video NAL payload begins at offset 32.

`media-full.mjs`: streams the replay, sends continuation `{"frames":N}` as the socket drains, keeps video frames
(types 1/2) deduped by sequence, drops audio (type 4), and stops when the sequence stalls (segment end).

Result for the 240.2 s Nov-19 segment: **3601 unique video frames (81 I-frames + 3520 P-frames), sequence 0..3600
contiguous (no gaps/dupes), 45.7 MB, downloaded in ~22 s** (faster than real time). Clean H.264: 81× SPS/PPS/IDR +
3520 P-frames, High profile L5.1, SPS → 2304×2592. File `clip-full-clean.local.h264` plays in VLC.
Effective frame rate ≈ 15 fps (3601 frames / 240 s); raw .h264 has no timing, so a player may need fps set or an MP4 mux.

## 16. Audio + MP4 (2026-11-19)

Audio frames (type 4) are **AAC-LC ADTS** (sync `0xFFF1`), 8 kHz mono — confirmed by native `encodePcmToAac` /
`NVEncodeAACToMP4` and codec id 107. One ADTS frame per media frame; strip the 7-byte ADTS header for raw AAC; the
AudioSpecificConfig derives from the ADTS header (AOT 2, sf-index 11, 1 channel → `0x1588`). Audio frame count (~1876)
matches 240 s ÷ (1024/8000 s).

`mp4mux.mjs` is a dependency-free ISO-BMFF muxer (ftyp + moov[mvhd, video trak avc1/avcC, audio trak mp4a/esds] + mdat,
with stts/stsc/stsz/stco/stss). `media-mp4.mjs` captures the full segment (video+audio), builds it, and writes a timed MP4.

Result `clip.local.mp4` (46.2 MB): **H.264 2304×2592 @15 fps, 240.2 s, 3601 samples, 81 sync frames**, + **AAC-LC
8 kHz mono, 240.1 s, 1876 samples**. Validated by walking the box tree: both tracks' chunk offsets land inside mdat,
sample-byte totals match the mdat payload exactly, and both track durations ≈ 240 s. Plays in VLC / Windows / browsers /
QuickTime. No ffmpeg used — the whole pipeline (discover → login → list → retrieve → decrypt → demux → mux) is our own code.

## 17. Video corruption diagnosis + browser viewer (2026-11-19)

Built a local browser viewer (preview/server.mjs + index.html, served by node) to visually inspect decoded frames.
Findings on the bottom-edge / accumulating corruption:
- Keyframes decode mostly clean (2304×2592, single continuous fisheye lens — NOT two stacked lenses; pano center/r are in
  the upper region). Corruption accumulates across the GOP (long GOP: ~1 I-frame per 250 frames observed) → P-frame drift.
- Frame bodies are contiguous (video seq 0..N, no gaps), frame 0 is an I-frame → not dropped frames.
- Decryption model confirmed EMPIRICALLY: **per-frame IV reset is correct** (headers + all full payload blocks parse/decode).
  Continuous-CBC across frames breaks header parsing (proved twice). So the camera resets the CBC IV per frame.
- The remaining error is the per-frame **partial-block tail** (body.length % 16, ~0-15 bytes): plaintext tail decodes but
  leaves a corrupt slice end that CABAC-desyncs → bottom band that P-frames propagate. CFB(E(Clast)) and CBC-CTS both make
  it WORSE (MEDIA_ERR_DECODE), so neither is the scheme. Exact tail handling still unresolved — needs a precise read of
  native `iotc_ms_frame_cipher`/`_init` buffer math (the uVar3/uVar6/uVar5 chunking), not more guessing.
- Dual-lens / "two cameras": this frame is one lens. The second 4MP lens is likely a separate channel (replay uses chn:1);
  channel mapping not yet investigated.

Tools: `media-fix.mjs` (continuous-CBC test, disproven), `media-mp4.mjs` TAILMODE=plain|cts, `tail-check.mjs`, `seqgap.mjs`.

## 18. CORRUPTION FIXED + dual-lens confirmed (2026-11-19)

Root cause (from `iotc_ms_frame_cipher_init` decrypt branch): each media frame begins with a 32-byte ENCRYPTED header
whose u32 at offset 22 = `uVar6` (encrypted-chunk size). Video frames are only PARTIALLY encrypted: **header + first
`uVar6` bytes** of the payload are AES-128-CBC (one continuous CBC per frame, IV reset per frame), and the **rest of the
payload is PLAINTEXT** (uVar5 = 0xFFFFFFFF = skip-the-rest). Observed uVar6: **1024 for video**, ~272/288 for audio.
I was decrypting the whole payload, scrambling the plaintext bulk → the accumulating bottom/band corruption.
Fix in `decFrame`: decrypt `body[0:32]` then `body[32:32+uVar6]` (continuing the same CBC), keep `body[32+uVar6:]` as-is.
Video is now clean (scene, OSD timestamp, REC indicator all correct).

Dual-lens: the 2304×2592 frame is the **two 4MP lenses stacked vertically** (each 2304×1296) — the "two cameras".
Both are already in one stream; the app can split top/bottom into two views. (No separate channel needed for the second lens.)

## 19. Local prototype viewer app — working (2026-11-19)

Built `app/` — a local viewer prototype (decision: local prototype first, then port to Android):
- `app/lib.mjs` — protocol library: `discover()` (subnet-broadcast NVDEVSEARCH), `openSession`, `listDays` (BRIEF),
  `listSegments`, `fetchSegmentMp4` (the fixed partial-encryption decrypt → MP4 via mp4mux). Imports verified parent modules.
- `app/server.mjs` — Node HTTP backend on :8777: `/api/discover`, `/api/days`, `/api/segments`, `/api/clip` (MP4,
  cached to C:/Users/ankitc/cctv-v380-work/clipcache, HTTP Range for seeking). Session cache per IP.
- `app/index.html` + `app/app.js` — dark-themed UI: camera discovery + rescan, day picker, recording list (type-colored),
  **dual-lens split view** (two canvases drawing top/bottom halves of the 2304×2592 frame), Both/Top/Bottom layout,
  **scroll-to-zoom + drag-pan** (1–8×), fullscreen, play/seek/mute. Local vs Server(cloud) mode toggle (server stubbed).

Verified in-browser against the real camera: discovered 172.20.10.2, listed 31 recordings for 2026-11-19, played a clip
with clean dual-lens video and working zoom (3.5× shown). Run: launch config "v380-app" (preview_start) or
`node app/server.mjs` then open http://localhost:8777.

Remaining: Server/cloud mode (vendor relay + account), live view, timeline scrubber, then port to Android (Kotlin).

## 20. Live view — working (2026-11-19)

Live protocol: **METHOD_ID_LIVE_CTRL_REQUEST = 197122 (0x301c2)**, params `{ "up": { quality:1, video:1, audio:1, IDRreq:1 } }`
(IDRreq forces an immediate keyframe). Same framing/crypto/partial-encryption as replay; LAN reuses the login sKey (no
separate data-channel key exchange). Keep-alive 0x30200 `{flag:2,tms1:0,decode_tms:0}` every ~2 s. The camera streams the
same 0x38030820 media frames; response LIVE_CTRL 197123 (`uprs.rs:1000` = OK). Live stream is the **sub-stream 640×720
(two 640×360 lenses stacked)** — lower-res than the 4K recordings; `quality` selects main/sub.

Pipeline: `app/lib.mjs openLive()` streams decrypted H.264 frames → `app/fmp4.mjs` (fragmented-MP4: init segment +
moof/mdat per frame; trun flags 0x0701) → backend `/api/live` chunked HTTP → browser **Media Source Extensions**
(`avc1.64001f`, sequence mode, buffer trimmed to stay near the live edge). Verified in-browser: live plays in real time,
both lenses rendered in the split view with the OSD timestamp/REC indicator; zoom works on the live canvases too.

## 21. Live HD + audio (2026-11-19)

Live `quality` selects the stream: **1 = SD sub-stream 640×720**, **2 = HD main stream 2304×2592** (same as recordings,
level 5.1). The live request `{up:{quality,video:1,audio:1,IDRreq:1}}`.

Audio: live frames carry AAC-LC ADTS (type 4); muxed into the fMP4 as a second track (mp4a/esds). Fixed an esds length
bug (ES_Descriptor len = 23+ascLen, DecoderConfig len = 15+ascLen) that had silently disabled the audio track. Verified
`webkitAudioDecodedByteCount > 0` (audio decodes; silent only because the scene is quiet). A/V timing: video uses measured
inter-frame duration (clamped) accumulating from 0, audio accumulates 1024/frame — both start at 0 for a continuous buffer
(fixed an initial-gap stall) and track real time for sync.

UI: SD/HD toggle in the toolbar switches `quality` live; codec string `avc1.640033,mp4a.40.2` (HD) / `avc1.64001f,mp4a.40.2`
(SD). Verified in-browser: HD live 2304×2592 both lenses, continuous playback near the live edge, audio+video decoding.

## 22. Timeline + browsing polish (2026-11-19)

Added to the prototype app:
- **Day timeline** (`#timeline`): a 24-hour bar with hour ticks and recording blocks positioned by local time-of-day,
  colored by type (continuous/motion/alarm/event). Hover shows the time; click plays the segment covering that time and
  seeks to the offset (nearest segment if in a gap). A live **playhead** tracks the current position during playback.
- **Full-length clip loading**: default now loads the entire recording (max=0; cached so replays are instant), with a
  duration-aware loading spinner ("Fetching & decoding Ns recording…"). The clip's start time shows in the controls.
- **Auto-advance**: when a recording finishes, the next segment plays automatically (continuous day playback).
- Dev hook `window.__app` (state, renderTimeline, playSegment) for testing.

**Verified end-to-end against camera 172.20.10.2 (2026-11-19):** the day loaded 55 real recordings → 55 timeline
blocks + 12 hour ticks. Block-click played the exact segment (idx 20 = 10:10:10 AM, 2304×2592 dual-lens, both lenses
clean including the previously-corrupt bottom). The **playhead tracked the recording's real time-of-day to 3 decimals**
(42.374%, matching the clicked block). **Seek** jumped `currentTime` and the playhead (60% → 146.3s / 2:26). **Auto-advance**
carried idx 20 → idx 21 on `ended`, and idx 21 loaded and played. The container click-to-time handler's selection logic
was also confirmed correct (an off-by-one appeared only with synthetic sub-pixel click coordinates on contiguous
back-to-back recordings, not with real block clicks).

**Concurrency fix (server.mjs):** on a cold cache the browser fires `/api/days` and `/api/segments` together; both missed
`sessionCache` and opened parallel LAN logins, and the camera rejects the second auth → HTTP 500 ("auth failed"), leaving
the UI stuck on "loading recordings…" (`r.segments is not iterable`). `getSession` now dedupes in-flight logins through a
`sessionPending` promise map (one login per IP, cleared in `finally`). Cold reload then loads all 55 recordings with no 500.

## 23. Device control & settings protocol + UI (2026-11-19)

**Control mechanism.** Everything in "Settings" rides the channel we already use (TCP 8089, CMD_COMMON_IOT, 16-byte LE
header, body AES-128-CBC with sKey). Three generic methods: **GET_PROPERTIES=197376, SET_PROPERTIES=197378,
ACTION=197384** (ABILITY=197386). The JSON envelope is exactly the `{id, method_id, chn:1, ts, params}` our
`buildRequest` already emits. Properties/actions are addressed by computed ids: **DPID=(group<<16)|0x100|idx**,
**DAID=(group<<16)|0x200|idx**. Groups: SDCARD=2, TIME=3, NETWORK=4, LIGHT=5, PTZ=6, AUDIO=7, VIDEO=8, OSD=9,
ALARM=10, DET/ALERT_V2=14. Payloads: GET `{dplist:[dpid,…]}` → `data.dplist_result[{dpid,value,vs,code}]`; SET
`{dplist:[{dpid,value,vs?}]}`; ACTION `{daid, vsbmp:(1<<ch), in:{…}}`. Per-property `code`: 1000=ok,
**1114=unsupported on this device**, 1103/1104=stale session key (re-run key exchange).

**This camera's real capability map** (probed live, kept only code 1000): image flip (0x80100, =1), night vision
(0x80105, =0 auto), anti-flicker (0x80106); floodlight mode (0x50100) + sensitivity (0x50103); mic vol (0x70100=50),
speaker vol (0x70101=50), prompt tones (0x70103), prompt lang (0x70102); **detection sensitivity (0x60103… no —
0xe0103 = {set:3,max:3})**, auto-tracking (0x60105=false); record quality (0x20104=2 HD), mode (0x20103=3 continuous),
audio (0x20105), loop (0x20106); PTZ pan/tilt speed (0x60103/0x60104=8); PTZ cruise config (0x60101). **Unsupported
here (1114):** OSD clock (0x90100), status LED (0x50105), ISP brightness/contrast/sharpness/saturation, legacy alarm
group 10, person-detect toggle (0xe0100), ALERT_V2 md/person attrs. So the UI is built from GET results, not guesses.

**PTZ.** Preset goto / home (DAID 0x60202) / recalibrate (0x60204) work over the JSON ACTION channel. **Live pan-tilt
MOVE turned out NOT to be a binary packet** — the native `setPTZParam` just stores state and a worker thread emits the
very same JSON ACTION (method_id 197384) we already build: `daid=0x60200`, `in:{op,cnt}` with op stop=0/left=1/right=2/
up=3/down=4 and cnt=step (min 1); the app sends `no_rsp:true` but we omit it so `request()` gets an ACK (`chn`=channel+1
=1 for this single-lens cam). Zoom = `daid=0x60203, in:{ctrl,val}`. Implemented as `lib.ptzMove/ptzZoom`, `/api/ptz?cmd=move`,
and a press-and-hold direction pad (resend every 350 ms, send `op:0` stop on release). **Verified vs camera:** API
left/right/stop each returned result 1000 (ACTION_RESPONSE 197385, ~186 ms); UI hold-left then hold-right moved and
returned to origin. (Evidence: `ghidra-work/out/ptz.json`, `actionobj.json`.) Two-way talk audio uplink is still native
and two-stage (negotiate ACTION method_id 0x30202, then audio frames on MEDIA cmd 0x38030820 via the media-frame cipher)
— feasible later, not built.

**Implementation.** `lib.mjs`: `getProps/setProps/invokeAction` + `DP`/`DA` constants + `ptzPreset/ptzHome/ptzRecal`.
`server.mjs`: `/api/settings` (probe CATALOG → supported items + current values + metadata), `/api/setprop`
(bool/int/enum/objset), `/api/ptz`. `index.html`+`app.js`: a "⚙ Controls" right-side drawer with a PTZ pad and
section-grouped switch/select/slider controls that read current values and write on change.

**Verified vs camera (2026-11-19):** GET returns real values; SET reversible round-trips (mic vol 50→40→50 via API;
prompt-tones toggle off→on via the UI switch) read back correctly and were restored — nothing left changed. PTZ
home/recal are wired but intentionally not triggered in the automated test (they physically move the camera).
Enum option *labels* are best-effort; the current value shown is the device's. 0xe0103 {set,max} labelled "Detection
sensitivity" is MEDIUM confidence (could be warning-light level on some firmware).

## 24. Cloud / remote-access ("MR" relay) protocol (2026-11-19)

**Headline:** the remote path reuses our LAN IoT stack almost unchanged. Remote vs local differs in only two
places: (1) the session key comes from a tunnel/HTTP key-exchange instead of the LAN login, and (2) every
**outbound** frame gets a **64-byte relay-forward header** (`cmd 1200`, then innerLen). The 16-byte `0x38030818`
header + AES-128-CBC(sKey) body and every method (GET/SET/ACTION 197376/197378/197384, live 197122, replay 197154)
are byte-identical inside the tunnel. `sKey` is still `X25519(appSeed, devicePub)`.

**Hosts (verbatim):** account+device-list `https://mapi.av380.net`; dispatch (relay allocation)
`http://dispatch.av380.net:8001/api/v1/get_stream_server`; key-exchange `http://secret.av380.net/v1/app/exch`;
bind/online `http://tmpalive.av380.net`; login twins `msglogin(t).av380.net:8443`; temp-account `rapi.av380.net`.

**Remote flow:** `user/login` → `sAccessToken`; `device/binds` → device `{dev_id, p_key (base64 X25519 pub),
password, online_stat (101=LAN-reachable), pver}`; if not LAN → `dispatch` (sign =
`sha1("dev_id=..&platform=20001&timestamp=..hsdata2022")`) → `createRelaySession(access_token+device_id)` →
`{app_trs_ip, app_trs_port, channel_handle, channel_token, uuid}` (code 1012 = offline); **[pver≥5: MQTT wake]**;
TCP connect `app_trs_ip:app_trs_port`; forward-attach `1500B [1100][devId][channel_handle][token≤36]` → read 64B,
expect `[1101][..][1000]`; TSK key-exchange (method **196872** plaintext `{uuid, cS=base64(sha256(appPub))}` →
`data.pubKC` → `sKey`) or HTTP `/v1/app/exch` using `p_key`; then drive control/live/replay with our lib, wrapping
each outbound frame in the 64-byte 1200 header.

**Implementation:** `v380cloud.mjs` (new, parent folder) — `accountLogin`, `getDeviceList`, `dispatchRelay`,
`createRelaySession`, `forwardAttachBuffer`, `wrapMR`/`stripMR`, `tskExchangeOverTunnel`, `openRemoteSession`. Reuses
the LAN X25519 + `cipher-sectype2`. Syntax-checked and primitives smoke-tested; **not yet run against the live
vendor servers** (needs account credentials; keep login attempts few to avoid lockout).

**Hard prerequisites / gaps:** the camera must be **bound** to the account (ours is `bindState=2`, unbound) and must
have its own internet for remote to work. Open items to finalise live: (1) exact `user/login` param+signature recipe;
(2) the dynamic **MQTT broker** host/creds + wake payload for `pver≥5` (biggest unknown); (3) this camera's `pver`;
(4) inbound relay framing (handled tolerantly by `stripMR`); (5) `createRelaySession` exact request path/shape.
