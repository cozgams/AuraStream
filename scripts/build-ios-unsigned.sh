#!/usr/bin/env bash
# Unsigned iOS build script for AuraStream.
# Maintains the Tauri iOS release options server while running Xcode build steps,
# pointing Swift compatibility library paths into the Xcode toolchain.
set -euo pipefail

VERSION="${1:?Usage: build-ios-unsigned.sh VERSION}"
ROOT="$(pwd)"
LOG="$ROOT/ios-build-session.log"
ADDR_FILE="$(node -p "require('os').tmpdir() + '/' + require('./src-tauri/tauri.conf.json').identifier + '-server-addr'")"
mkdir -p artifacts
rm -f "$ADDR_FILE"

# Initialize and sync AuraStream application icons before build
node scripts/generate-ios-icons.mjs
node scripts/sync-ios-icons.mjs --required

# Tauri does not provide --no-sign on iOS. Keep the release options server alive
# so Xcode Build Rust Code phase can communicate with it without panic.
pnpm tauri ios build --open --ci --features custom-protocol >"$LOG" 2>&1 &
SESSION_PID=$!
cleanup() {
  kill "$SESSION_PID" 2>/dev/null || true
  cat "$LOG"
}
trap cleanup EXIT
for ((attempt = 0; attempt < 240; attempt++)); do
  if ! kill -0 "$SESSION_PID" 2>/dev/null; then
    echo "Tauri build session exited before becoming ready" >&2
    exit 1
  fi
  if [[ -s "$ADDR_FILE" ]]; then
    break
  fi
  sleep 1
done
if [[ ! -s "$ADDR_FILE" ]]; then
  echo "Timed out waiting for the Tauri build options server" >&2
  exit 1
fi

# Resolve project and scheme dynamically
PROJECT="$(cd src-tauri/gen/apple && ls -d *.xcodeproj | head -1)"
SCHEME="$(cd src-tauri/gen/apple && xcodebuild -list -project "$PROJECT" 2>/dev/null | awk '/Schemes:/{f=1;next} f&&NF{print $1;exit}')"
if [[ -z "$PROJECT" || -z "$SCHEME" ]]; then
  echo "Cannot resolve xcodeproj / scheme: '$PROJECT' / '$SCHEME'" >&2
  ls -la src-tauri/gen/apple >&2 || true
  exit 1
fi
echo "project=$PROJECT scheme=$SCHEME"

# Xcode configuration uses lowercase release; point Swift compatibility library to toolchain
XCODE_TOOLCHAIN="$(xcode-select -p)/Toolchains/XcodeDefault.xctoolchain"
test -d "$XCODE_TOOLCHAIN/usr/lib/swift/iphoneos"

xcodebuild build \
  -toolchain com.apple.dt.toolchain.XcodeDefault \
  -project "src-tauri/gen/apple/$PROJECT" \
  -scheme "$SCHEME" \
  -configuration release \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$ROOT/build_output" \
  TOOLCHAIN_DIR="$XCODE_TOOLCHAIN" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""

APP_DIR="$ROOT/build_output/Build/Products/release-iphoneos"
APP="$(ls -d "$APP_DIR"/*.app 2>/dev/null | head -1)"
if [[ -z "$APP" ]]; then
  echo "No .app produced under $APP_DIR" >&2
  exit 1
fi
EXECUTABLE=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Info.plist")
test -s "$APP/$EXECUTABLE"
file "$APP/$EXECUTABLE" | grep "Mach-O.*arm64"

# Verify binary produced by release build
strings "$APP/$EXECUTABLE" > "$ROOT/ios-binary-strings.txt"
if grep -F "localhost:1420" "$ROOT/ios-binary-strings.txt" >/dev/null; then
  echo "warn: binary embeds devUrl string (normal for Tauri release builds)"
fi

PACKAGE_DIR=$(mktemp -d)
mkdir -p "$PACKAGE_DIR/Payload"
cp -R "$APP" "$PACKAGE_DIR/Payload/"
IPA="$ROOT/artifacts/AuraStream_${VERSION}_ios.ipa"
(cd "$PACKAGE_DIR" && zip -qr "$IPA" Payload)
unzip -tq "$IPA"
ls -lh "$IPA"
