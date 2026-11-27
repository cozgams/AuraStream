#!/bin/bash
set -euo pipefail

BUILD_TOOLS_DIR="$(ls -d "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/android-sdk}}"/build-tools/* 2>/dev/null | sort -V | tail -n1 || true)"
if [ -n "$BUILD_TOOLS_DIR" ]; then
  export PATH="${BUILD_TOOLS_DIR}:$PATH"
fi
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-1}"
cd /data/home/Project/A/HGhubX

VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version")"
KEYSTORE="${AURASTREAM_KEYSTORE:-/data/home/Project/A/.signing/release.keystore}"
KEY_ALIAS="${AURASTREAM_KEY_ALIAS:-}"
KS_PASS="${AURASTREAM_KEYSTORE_PASS:-}"

if [ ! -f "$KEYSTORE" ]; then
  echo "Error: keystore not found at $KEYSTORE (set AURASTREAM_KEYSTORE)" >&2
  exit 1
fi
if [ -z "$KEY_ALIAS" ] || [ -z "$KS_PASS" ]; then
  echo "Error: set AURASTREAM_KEY_ALIAS and AURASTREAM_KEYSTORE_PASS environment variables" >&2
  exit 1
fi

echo "=== Building split APKs for v$VERSION ==="
# Gradle incremental JNI tasks track symlink inodes rather than target .so mtimes;
# clear native-lib intermediates so fresh Cargo/Vite assets are always packaged.
rm -rf \
  src-tauri/gen/android/app/build/intermediates/merged_jni_libs \
  src-tauri/gen/android/app/build/intermediates/merged_native_libs \
  src-tauri/gen/android/app/build/intermediates/stripped_native_libs \
  src-tauri/gen/android/app/build/outputs/apk

pnpm tauri android build --apk --target aarch64 armv7 x86_64 --split-per-abi

APK_BASE="/data/home/Project/A/HGhubX/src-tauri/gen/android/app/build/outputs/apk"
OUT_DIR="/data/home/Project/A/HGhubX/downloads"
mkdir -p "$OUT_DIR"

echo "=== Aligning and Signing APKs (16KB alignment) ==="
for abi in arm64 arm x86_64; do
  in_apk="$APK_BASE/${abi}/release/app-${abi}-release-unsigned.apk"
  out_apk="$OUT_DIR/AuraStream_${VERSION}_${abi}.apk"
  zipalign -P 16 -f 4 "$in_apk" "$out_apk"
  printf '%s\n' "$KS_PASS" | apksigner sign --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" --ks-pass stdin "$out_apk"
  rm -f "${out_apk}.idsig"
  apksigner verify "$out_apk"
  if [ "$(unzip -p "$out_apk" "lib/*/libhghubx_lib.so" | grep -acF "$VERSION")" -eq 0 ]; then
    echo "Error: stale native library packaged in $out_apk (missing $VERSION)" >&2
    exit 1
  fi
done

echo "=== Successfully built and signed all APKs for v$VERSION ==="
ls -lh "$OUT_DIR"/AuraStream_${VERSION}_*.apk
