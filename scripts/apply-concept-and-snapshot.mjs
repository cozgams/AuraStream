import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const root = "/data/home/Project/A/HGhubX";
const brainDir = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

const conceptNum = process.argv[2];
if (!conceptNum || !["1", "2", "3", "5"].includes(conceptNum)) {
  console.error("Usage: node apply-concept-and-snapshot.mjs <1|2|3|5>");
  process.exit(1);
}

console.log(`=== APPLYING CONCEPT ${conceptNum} FOR ANDROID VM PREVIEW ===`);

const bgColors = {
  "1": "#0a081d",
  "2": "#0f0728",
  "3": "#0c101d",
  "5": "#08071e"
};

const conceptNames = {
  "1": "concept_1_lumina_aurora",
  "2": "concept_2_infinite_stream",
  "3": "concept_3_stellar_prism",
  "5": "concept_5_aura_glide"
};

const name = conceptNames[conceptNum];
const bgColor = bgColors[conceptNum];

// 1. Read the concept SVG
const rawSvg = readFileSync(join(brainDir, `${name}.svg`), "utf8");

// 2. Create unmasked square source for iOS / Tauri
// Remove rx and stroke from background rects to make it an unmasked square
const unmaskedSourceSvg = rawSvg
  .replace(/<rect width="1024" height="1024" rx="224"[^>]*\/>/, `<rect width="1024" height="1024" fill="url(#c${conceptNum}-bg)"/>`)
  .replace(/<rect width="1020" height="1020"[^>]*\/>/, "");

writeFileSync(join(root, "src-tauri", "icons", "ios", "source.svg"), unmaskedSourceSvg);
writeFileSync(join(root, "app-icon.svg"), rawSvg);
writeFileSync(join(root, "public", "logo.svg"), rawSvg);

// 3. Update Android background color
const bgXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
   <color name="ic_launcher_background">${bgColor}</color>
</resources>
`;
writeFileSync(join(root, "src-tauri", "icons", "android", "values", "ic_launcher_background.xml"), bgXml);
writeFileSync(join(root, "src-tauri", "gen", "android", "app", "src", "main", "res", "values", "ic_launcher_background.xml"), bgXml);

// 4. Create Adaptive Foreground SVG (scaled 70% centered, transparent background)
// Extract everything inside <g filter="url(#c...-shadow)"> or the emblem elements
// By wrapping the original emblem inside a 70% scale group without the background rects:
const defsMatch = rawSvg.match(/<defs>([\s\S]*?)<\/defs>/);
const defs = defsMatch ? defsMatch[1] : "";

// Remove background rects and halo from content
let body = rawSvg
  .replace(/<\?xml[\s\S]*?>/, "")
  .replace(/<svg[\s\S]*?>/, "")
  .replace(/<\/svg>/, "")
  .replace(/<defs>[\s\S]*?<\/defs>/, "")
  .replace(/<rect width="1024" height="1024"[\s\S]*?\/>/, "")
  .replace(/<rect width="1020" height="1020"[\s\S]*?\/>/, "")
  .replace(/<circle cx="512" cy="512" r="440" fill="url\(#c\d-halo\)"\/>/, "")
  .replace(/<circle cx="512" cy="480" r="450" fill="url\(#c2-nebula\)"\/>/, "")
  .replace(/<circle cx="512" cy="512" r="420" fill="url\(#c3-glow\)"\/>/, "");

const adaptiveFgSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    ${defs}
  </defs>
  <g transform="translate(512 512) scale(0.68) translate(-512 -512)">
    ${body}
  </g>
</svg>`;

writeFileSync(join(root, "hghubx-fg.svg"), adaptiveFgSvg);

// 5. Run tauri icon generator to produce all icon assets
console.log("Generating icon assets with tauri icon...");
execSync(`node /data/home/Project/A/HGhubX/node_modules/@tauri-apps/cli/tauri.js icon src-tauri/icons/ios/source.svg`, {
  cwd: root,
  stdio: "inherit"
});

// 6. Now generate the adaptive foreground mipmaps from adaptiveFgSvg using ffmpeg/resvg into src-tauri/icons/android/
const mipmaps = [
  { dir: "mipmap-mdpi", size: 108 },
  { dir: "mipmap-hdpi", size: 162 },
  { dir: "mipmap-xhdpi", size: 216 },
  { dir: "mipmap-xxhdpi", size: 324 },
  { dir: "mipmap-xxxhdpi", size: 432 }
];

writeFileSync(join(root, "temp_fg.svg"), adaptiveFgSvg);
for (const m of mipmaps) {
  const targetPath = join(root, "src-tauri", "icons", "android", m.dir, "ic_launcher_foreground.png");
  execSync(`ffmpeg -y -i ${join(root, "temp_fg.svg")} -vf scale=${m.size}:${m.size} ${targetPath} 2>/dev/null`, { cwd: root });
}

// Sync icons to Android gen directory
execSync("node scripts/sync-android-icons.mjs", { cwd: root, stdio: "inherit" });

// Also update master app-icon.png
copyFileSync(join(brainDir, `${name}.png`), join(root, "app-icon.png"));

console.log(`[apply-concept] Concept ${conceptNum} assets synced! Building APK...`);

// 7. Build Android APK
execSync("npx tauri android build --apk --debug --target x86_64", {
  cwd: root,
  stdio: "inherit"
});

const builtApk = join(root, "src-tauri", "gen", "android", "app", "build", "outputs", "apk", "universal", "debug", "app-universal-debug.apk");

// 8. Install to Android VM
console.log("Installing APK onto emulator 127.0.0.1:5555...");
execSync(`adb -s 127.0.0.1:5555 install -r "${builtApk}"`, { stdio: "inherit" });

// 9. Navigate Android VM to Launcher App Drawer
console.log("Navigating to Android App Drawer...");
execSync("adb -s 127.0.0.1:5555 shell input keyevent KEYCODE_HOME");
execSync("sleep 1");
// Open app drawer by tapping the dock all-apps icon or swiping up
execSync("adb -s 127.0.0.1:5555 shell input tap 412 1120"); // all apps button on standard launcher
execSync("sleep 1.5");

// 10. Capture Android VM screenshot
const vmScreenshot = join(brainDir, `vm_preview_option_${conceptNum}.png`);
execSync(`adb -s 127.0.0.1:5555 exec-out screencap -p > "${vmScreenshot}"`);
console.log(`Captured Android VM screenshot for Option ${conceptNum} -> ${vmScreenshot}`);

console.log(`=== FINISHED CONCEPT ${conceptNum} ===`);
