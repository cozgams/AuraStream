<div align="center">

<img src="public/logo.png" alt="AuraStream" width="128" height="128" style="border-radius: 28px;" />

# AuraStream 2.1.0

**Next-Generation Streaming Experience · Powered by Rust & Tauri 2**

### This App Created by AAA

Android Universal Release · Zero Data Offline Playback · AI Bilingual Subtitles · 1-Tap RAM Booster

</div>

---

## Overview

AuraStream is a high-performance streaming application crafted for modern Android devices. Built with a lightweight, secure Rust core and a fluid, responsive interface, AuraStream delivers instant swipe transitions, zero-data offline storage, and intelligent playback enhancements.

---

## Key Features

- **This App Created by AAA**: Premium handcrafted design with clean typography and zero emojis.
- **Amber Gold Star Favorite System**: Elegant, consistent amber-gold star theme across all feed items, comments, and profile collections.
- **Zero-Data Offline Playback**: Download single episodes or full seasons directly to local storage (IndexedDB & native storage export) with live transfer speed metrics and ETA indicators.
- **1-Tap RAM Booster & Deep Cache Purge**: Instant memory optimization that flushes preloaded media segments, eviction of unneeded M3U8 manifests, and cache optimization directly from Settings and Profile.
- **Real-Time AI Bilingual Subtitles**: Clean English and dual-language subtitles with custom Netflix-style caption typography, styling, and color personalization.
- **Turbo Wi-Fi Pre-Caching & Smart Auto-Cleaner**: 8-thread concurrent segment buffering on Wi-Fi with LRU cache memory eviction to prevent phone memory pressure.
- **Picture-in-Picture (PiP) & Background Audio**: Native Android Picture-in-Picture mode and MediaSession audio controls.
- **Smart Sleep Timer & Auto-Skip**: Automatic intro and outro skipping (5s–30s) and sleep timer with custom durations and "End of Episode" pause.
- **Multi-Select Batch Management**: Batch export episodes directly to the phone's Movies/Downloads folders, or batch delete with 1-tap storage cleanup.

---

## Architecture & Tech Stack

- **Core Engine**: Rust (Tauri 2) with local HTTP streaming proxy, AES decryption, and DNS fallback recovery.
- **Frontend**: React 18, TypeScript, Tailwind CSS, and HLS.js with MSE/hardware decoding.
- **Packaging**: Android Universal APK signed with v2+v3 scheme (`apksigner`).

---

## Building the Android APK

Ensure the Android SDK and NDK (version 26+) are installed on your system.

```bash
# 1. Install dependencies
pnpm install

# 2. Build the Android universal release package
pnpm tauri android build --apk

# 3. Align and sign the APK with apksigner (v2 + v3 scheme)
/opt/android-sdk/build-tools/35.0.0/zipalign -f -v -p 4 \
  src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release-unsigned.apk \
  AuraStream_2.1.0_universal_aligned.apk

/opt/android-sdk/build-tools/35.0.0/apksigner sign \
  --ks ~/.android/debug.keystore \
  --ks-pass pass:android \
  --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out AuraStream_2.1.0_universal.apk \
  AuraStream_2.1.0_universal_aligned.apk

# 4. Verify signature
/opt/android-sdk/build-tools/35.0.0/apksigner verify --verbose AuraStream_2.1.0_universal.apk
```

---

## License

This App Created by AAA. All rights reserved.
