#!/bin/bash
set -e

export PATH="/opt/android-sdk/build-tools/35.0.0:$PATH"
export CARGO_BUILD_JOBS=1
cd /data/home/Project/A/HGhubX

VERSION="0.1.55"
echo "=== Building split APKs for v$VERSION (low-memory cached mode) ==="
pnpm tauri android build --apk --target aarch64 armv7 x86_64 --split-per-abi

APK_BASE="/data/home/Project/A/HGhubX/src-tauri/gen/android/app/build/outputs/apk"
KEYSTORE="${AURASTREAM_KEYSTORE:-/data/home/Project/A/.signing/release.keystore}"
OUT_DIR="/data/home/Project/A/HGhubX/downloads"

mkdir -p "$OUT_DIR"

echo "=== Aligning and Signing APKs with release.keystore (16KB alignment) ==="

# arm64
zipalign -f -p 16 "$APK_BASE/arm64/release/app-arm64-release-unsigned.apk" "$OUT_DIR/AuraStream_${VERSION}_arm64.apk"
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:${AURASTREAM_KEYSTORE_PASS:?}" --ks-key-alias "${AURASTREAM_KEY_ALIAS:?}" "$OUT_DIR/AuraStream_${VERSION}_arm64.apk"
apksigner verify "$OUT_DIR/AuraStream_${VERSION}_arm64.apk"

# arm
zipalign -f -p 16 "$APK_BASE/arm/release/app-arm-release-unsigned.apk" "$OUT_DIR/AuraStream_${VERSION}_arm.apk"
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:${AURASTREAM_KEYSTORE_PASS:?}" --ks-key-alias "${AURASTREAM_KEY_ALIAS:?}" "$OUT_DIR/AuraStream_${VERSION}_arm.apk"
apksigner verify "$OUT_DIR/AuraStream_${VERSION}_arm.apk"

# x86_64
zipalign -f -p 16 "$APK_BASE/x86_64/release/app-x86_64-release-unsigned.apk" "$OUT_DIR/AuraStream_${VERSION}_x86_64.apk"
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:${AURASTREAM_KEYSTORE_PASS:?}" --ks-key-alias "${AURASTREAM_KEY_ALIAS:?}" "$OUT_DIR/AuraStream_${VERSION}_x86_64.apk"
apksigner verify "$OUT_DIR/AuraStream_${VERSION}_x86_64.apk"

echo "=== Successfully built and signed all APKs for v$VERSION ==="
ls -lh "$OUT_DIR"/AuraStream_${VERSION}_*.apk
