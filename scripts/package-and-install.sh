#!/bin/bash
set -e

export PATH="/opt/android-sdk/build-tools/35.0.0:$PATH"
cd /data/home/Project/A/HGhubX
echo "Building release APKs with Tauri CLI..."
pnpm tauri android build --apk --target x86_64 aarch64 --split-per-abi

KEYSTORE="$HOME/.android/debug.keystore"
if [ ! -f "$KEYSTORE" ]; then
  mkdir -p "$HOME/.android"
  keytool -genkey -v -keystore "$KEYSTORE" -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
fi

APK_DIR="/data/home/Project/A/HGhubX/src-tauri/gen/android/app/build/outputs/apk"
OUT_DIR="/data/home/Project/A/HGhubX/downloads"
mkdir -p "$OUT_DIR"

echo "Signing APKs..."
find "$APK_DIR" -name "*-release-unsigned.apk" | while read -r apk; do
  base=$(basename "$apk")
  echo "Found APK: $base"
  if [[ "$base" == *"universal"* ]]; then
    zipalign -f -p 4 "$apk" "$OUT_DIR/AuraStream_v0.1_universal.apk"
    apksigner sign --ks "$KEYSTORE" --ks-pass pass:android --ks-key-alias androiddebugkey "$OUT_DIR/AuraStream_v0.1_universal.apk"
    cp -f "$OUT_DIR/AuraStream_v0.1_universal.apk" /data/home/Project/A/
    echo "Universal signed: $OUT_DIR/AuraStream_v0.1_universal.apk"
  elif [[ "$base" == *"arm64"* ]]; then
    zipalign -f -p 4 "$apk" "$OUT_DIR/AuraStream_v0.1_arm64-v8a.apk"
    apksigner sign --ks "$KEYSTORE" --ks-pass pass:android --ks-key-alias androiddebugkey "$OUT_DIR/AuraStream_v0.1_arm64-v8a.apk"
    cp -f "$OUT_DIR/AuraStream_v0.1_arm64-v8a.apk" /data/home/Project/A/
    echo "ARM64 signed: $OUT_DIR/AuraStream_v0.1_arm64-v8a.apk"
  elif [[ "$base" == *"x86_64"* ]]; then
    zipalign -f -p 4 "$apk" "$OUT_DIR/AuraStream_v0.1_x86_64.apk"
    apksigner sign --ks "$KEYSTORE" --ks-pass pass:android --ks-key-alias androiddebugkey "$OUT_DIR/AuraStream_v0.1_x86_64.apk"
    cp -f "$OUT_DIR/AuraStream_v0.1_x86_64.apk" /data/home/Project/A/
    echo "x86_64 signed: $OUT_DIR/AuraStream_v0.1_x86_64.apk"
  fi
done

echo "Installing on emulator..."
TARGET_APK="$OUT_DIR/AuraStream_v0.1_x86_64.apk"
if [ ! -f "$TARGET_APK" ]; then
  TARGET_APK="$OUT_DIR/AuraStream_v0.1_universal.apk"
fi

DEVICE=$(adb devices | grep -E "device$" | head -n 1 | awk '{print $1}')
echo "Targeting device: $DEVICE"
adb -s "$DEVICE" push "$TARGET_APK" /data/local/tmp/app.apk
adb -s "$DEVICE" shell pm install -r -d /data/local/tmp/app.apk

echo "Package and install completed successfully!"
