import { execSync } from "node:child_process";
import { writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";

const root = "/data/home/Project/A/HGhubX";
const brainDir = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";
const inputJpg = join(brainDir, "user_uploaded_aurastream_logo.jpg");

console.log("=== PROCESSING USER'S CHOSEN AURASTREAM LOGO ===");

// 1. Convert JPG to full uncompressed raw RGBA buffer (1024x1024)
const rawRgba = execSync(`ffmpeg -v error -i "${inputJpg}" -f rawvideo -pix_fmt rgba -`, {
  maxBuffer: 10 * 1024 * 1024
});

const width = 1024;
const height = 1024;

// 2. Generate Unmasked Square Source (Fill black corners with cosmic navy #010a24 to #000410)
// This is required for iOS AppIcon and Tauri, because iOS masks the square itself.
const unmaskedBuf = Buffer.from(rawRgba);

// Squircle distance function: (|x-512|/460)^4 + (|y-512|/460)^4 <= 1
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const idx = (y * width + x) * 4;
    const nx = Math.abs(x - 512) / 468;
    const ny = Math.abs(y - 512) / 468;
    const d4 = Math.pow(nx, 4.4) + Math.pow(ny, 4.4);
    
    // If outside the squircle, fill with deep space navy radial gradient
    if (d4 > 0.98) {
      const rDist = Math.hypot(x - 512, y - 512) / 724; // 0 to 1
      // Smooth gradient from #010d2f to #000208
      const r = Math.round(1 * (1 - rDist * 0.7));
      const g = Math.round(13 * (1 - rDist * 0.7));
      const b = Math.round(47 * (1 - rDist * 0.8));
      unmaskedBuf[idx] = r;
      unmaskedBuf[idx + 1] = g;
      unmaskedBuf[idx + 2] = b;
      unmaskedBuf[idx + 3] = 255;
    }
  }
}

// Write unmasked 1024x1024 PNG
const unmaskedPngPath = join(brainDir, "aurastream_user_unmasked.png");
execSync(`ffmpeg -y -v error -f rawvideo -pix_fmt rgba -s 1024x1024 -i - "${unmaskedPngPath}"`, {
  input: unmaskedBuf
});
console.log("Created unmasked square master:", unmaskedPngPath);

// 3. Generate Transparent Squircle Master PNG (Transparent outside squircle)
const transparentBuf = Buffer.from(rawRgba);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const idx = (y * width + x) * 4;
    const nx = Math.abs(x - 512) / 468;
    const ny = Math.abs(y - 512) / 468;
    const d4 = Math.pow(nx, 4.4) + Math.pow(ny, 4.4);
    
    if (d4 > 1.0) {
      transparentBuf[idx + 3] = 0; // Fully transparent
    } else if (d4 > 0.97) {
      // Smooth anti-aliased edge
      const alpha = Math.round(255 * (1.0 - (d4 - 0.97) / 0.03));
      transparentBuf[idx + 3] = alpha;
    }
  }
}

const transparentPngPath = join(brainDir, "aurastream_user_master.png");
execSync(`ffmpeg -y -v error -f rawvideo -pix_fmt rgba -s 1024x1024 -i - "${transparentPngPath}"`, {
  input: transparentBuf
});
console.log("Created transparent squircle master:", transparentPngPath);

// Copy to master app-icon.png
copyFileSync(transparentPngPath, join(root, "app-icon.png"));

// 4. Generate Android Adaptive Foreground (Scale emblem to ~70% safe zone, transparent background)
// The Android Adaptive icon safe circle is 72dp out of 108dp (66.6% diameter).
// We scale the emblem down and center it onto a transparent 1024x1024 canvas.
const fgPngPath = join(brainDir, "aurastream_user_adaptive_fg.png");
execSync(`ffmpeg -y -v error -i "${transparentPngPath}" -vf "scale=720:720,pad=1024:1024:152:152:color=0x00000000" "${fgPngPath}"`);
console.log("Created adaptive foreground:", fgPngPath);

// 5. Generate all Android Mipmaps
const mipmaps = [
  { dir: "mipmap-mdpi", fgSize: 108, legacySize: 48 },
  { dir: "mipmap-hdpi", fgSize: 162, legacySize: 72 },
  { dir: "mipmap-xhdpi", fgSize: 216, legacySize: 96 },
  { dir: "mipmap-xxhdpi", fgSize: 324, legacySize: 144 },
  { dir: "mipmap-xxxhdpi", fgSize: 432, legacySize: 192 }
];

for (const m of mipmaps) {
  const targetDir = join(root, "src-tauri", "icons", "android", m.dir);
  
  // Foreground
  execSync(`ffmpeg -y -v error -i "${fgPngPath}" -vf "scale=${m.fgSize}:${m.fgSize}" "${join(targetDir, "ic_launcher_foreground.png")}"`);
  
  // Legacy Square
  execSync(`ffmpeg -y -v error -i "${transparentPngPath}" -vf "scale=${m.legacySize}:${m.legacySize}" "${join(targetDir, "ic_launcher.png")}"`);
  
  // Legacy Round
  execSync(`ffmpeg -y -v error -i "${transparentPngPath}" -vf "scale=${m.legacySize}:${m.legacySize}" "${join(targetDir, "ic_launcher_round.png")}"`);
}

// 6. Set background color to #010d2c
const bgXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
   <color name="ic_launcher_background">#010d2c</color>
</resources>
`;
writeFileSync(join(root, "src-tauri", "icons", "android", "values", "ic_launcher_background.xml"), bgXml);
writeFileSync(join(root, "src-tauri", "gen", "android", "app", "src", "main", "res", "values", "ic_launcher_background.xml"), bgXml);

// 7. Generate iOS and Desktop Icons with Tauri icon tool
console.log("Generating multiplatform icons with tauri icon...");
// Create an unmasked SVG source embedding the unmasked master PNG for vector compatibility
const sourceSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="aura-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#020412"/>
      <stop offset="100%" stop-color="#000208"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#aura-bg)"/>
  <image href="${unmaskedPngPath}" x="0" y="0" width="1024" height="1024"/>
</svg>`;

writeFileSync(join(root, "src-tauri", "icons", "ios", "source.svg"), sourceSvg);
writeFileSync(join(root, "app-icon.svg"), sourceSvg);
writeFileSync(join(root, "public", "logo.svg"), sourceSvg);

execSync(`node /data/home/Project/A/HGhubX/node_modules/@tauri-apps/cli/tauri.js icon src-tauri/icons/ios/source.svg`, {
  cwd: root,
  stdio: "inherit"
});

// Sync icons to Android gen directory
execSync("node scripts/sync-android-icons.mjs", { cwd: root, stdio: "inherit" });

console.log("=== ALL ASSETS GENERATED FOR USER'S CHOSEN LOGO! ===");
