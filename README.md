<div align="center">

<img src="public/logo.png" alt="AuraStream" width="128" height="128" style="border-radius: 28px; box-shadow: 0 8px 32px rgba(0,0,0,0.4);" />

# AuraStream

**Next-Generation Multi-Platform Streaming Experience · Powered by Rust & Tauri 2**

### This App Created by AAA

[![CI](https://github.com/cozgams/AuraStream/actions/workflows/ci.yml/badge.svg)](https://github.com/cozgams/AuraStream/actions/workflows/ci.yml)
[![Release](https://github.com/cozgams/AuraStream/actions/workflows/release.yml/badge.svg)](https://github.com/cozgams/AuraStream/actions/workflows/release.yml)
[![Version](https://img.shields.io/badge/version-0.1.9-amber)](https://github.com/cozgams/AuraStream/releases)

Android Native Application · Created by AAA

</div>

---

## 🌟 Key Highlights

- **This App Created by AAA**: Handcrafted user interface with minimalist typography and responsive ergonomics.
- **Dynamic Subtitle Collision Prevention**: Smart vertical anchor positioning that avoids caption collisions with drama titles and controls.
- **Customizable Closed Captions**: Instant fine-tuning slider (5%–92%) and quick presets (*Downside*, *Above Title*, *Middle*, *Top*), with selectable colors, edge shadows, and background styles.
- **Zero-Data Offline Playback**: Download single episodes or full seasons directly to storage with live speedometers and ETA countdowns.
- **1-Tap RAM Booster & Deep Cache Purge**: Clears in-memory HLS segments, decryption keys, and backend proxy cache.
- **Turbo Wi-Fi Pre-Caching & Smart Auto-Cleaner**: Concurrent segment buffering on Wi-Fi with LRU memory eviction.
- **Picture-in-Picture (PiP) & MediaSession Integration**: Lock controls, background audio playback, and OS-level media integration.

---

## 📦 Android Downloads

Download the latest production APKs directly from [GitHub Releases](https://github.com/cozgams/AuraStream/releases):

| Architecture | APK Package | Target Devices |
|---|---|---|
| **Android 64-bit** | `AuraStream_0.1.8_arm64-v8a.apk` | Modern smartphones & tablets (Snapdragon, MediaTek, Tensor) |
| **Android 32-bit** | `AuraStream_0.1.8_armeabi-v7a.apk` | Legacy 32-bit Android devices |
| **Android x86_64** | `AuraStream_0.1.8_x86_64.apk` | Intel/AMD Android emulators, ChromeOS & Chromebooks |

---

## 🛠️ Architecture & Tech Stack

```text
┌────────────────────────────────────────────────────────┐
│               AuraStream Client (React 18)             │
│   • Tailwind CSS  • HLS.js (MSE)  • WebVTT Parser     │
└───────────────────────────┬────────────────────────────┘
                            │ Tauri 2 IPC
┌───────────────────────────▼────────────────────────────┐
│                  Rust Core Engine                      │
│   • Local HTTP Proxy   • AES Decryption / Key Cache   │
│   • DNS Failover       • Network Policy & Strict Guard│
└────────────────────────────────────────────────────────┘
```

- **Frontend**: React 18, TypeScript, Tailwind CSS, Playwright.
- **Core Engine**: Rust (Tauri 2) with local HTTP streaming proxy, AES decryption, and DNS fallback recovery.
- **Packaging**: Tauri CLI with multi-target GitHub Actions automated release pipeline.

---

## 🚀 Development & Build

### Prerequisites

- Node.js (v20+) & `pnpm` (v10+)
- Rust (stable toolchain)
- Platform-specific SDKs:
  - **Android**: Android SDK & NDK 26+
  - **macOS / iOS**: Xcode 15+
  - **Windows**: Visual Studio C++ Build Tools & NSIS
  - **Linux**: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`

### Running Locally

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Run full test suite (9 test suites)
pnpm test

# Build production web bundle
pnpm build

# Run Rust unit tests
cd src-tauri && cargo test --lib
```

---

## 📄 License

**This App Created by AAA.** All rights reserved.
