import { writeFileSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const root = "/data/home/Project/A/HGhubX";
const brainDir = "/data/home/.gemini/antigravity-cli/brain/f3dd6a2f-052a-4132-80ac-b16d5e967f6d";

// 1. MASTER STANDALONE SVG (Framed squircle with smooth gradients matching the user artwork)
const standaloneSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-label="AuraStream Official Logo">
  <defs>
    <!-- Background Velvet Midnight -->
    <linearGradient id="aura-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#020412"/>
      <stop offset="35%" stop-color="#050e26"/>
      <stop offset="70%" stop-color="#030817"/>
      <stop offset="100%" stop-color="#010207"/>
    </linearGradient>

    <!-- Deep Ambient Radial Backlight -->
    <radialGradient id="aura-backlight" cx="50%" cy="50%" r="55%">
      <stop offset="0%" stop-color="#0284c7" stop-opacity="0.32"/>
      <stop offset="45%" stop-color="#3b82f6" stop-opacity="0.18"/>
      <stop offset="75%" stop-color="#7c3aed" stop-opacity="0.10"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </radialGradient>

    <!-- Left Arch: Electric Sapphire into Radiant Ocean Cyan -->
    <linearGradient id="left-arch" x1="10%" y1="90%" x2="50%" y2="10%">
      <stop offset="0%" stop-color="#0052d4"/>
      <stop offset="25%" stop-color="#0072ff"/>
      <stop offset="60%" stop-color="#00c6ff"/>
      <stop offset="85%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#7ee7fc"/>
    </linearGradient>

    <!-- Right Leg: Electric Cyan into Majestic Neon Violet & Magenta -->
    <linearGradient id="right-leg" x1="45%" y1="15%" x2="95%" y2="85%">
      <stop offset="0%" stop-color="#00c6ff"/>
      <stop offset="18%" stop-color="#3b82f6"/>
      <stop offset="45%" stop-color="#6366f1"/>
      <stop offset="70%" stop-color="#9333ea"/>
      <stop offset="90%" stop-color="#c026d3"/>
      <stop offset="100%" stop-color="#e879f9"/>
    </linearGradient>

    <!-- Right Leg Underbelly Shadow -->
    <linearGradient id="right-leg-inner" x1="40%" y1="30%" x2="80%" y2="80%">
      <stop offset="0%" stop-color="#1e1b4b"/>
      <stop offset="40%" stop-color="#2e1065"/>
      <stop offset="100%" stop-color="#701a75"/>
    </linearGradient>

    <!-- Dynamic Stream Wave Body: Electric Azure to Brilliant Cyan -->
    <linearGradient id="wave-body" x1="5%" y1="80%" x2="95%" y2="25%">
      <stop offset="0%" stop-color="#004cd4"/>
      <stop offset="25%" stop-color="#0077ff"/>
      <stop offset="55%" stop-color="#00c8ff"/>
      <stop offset="80%" stop-color="#38f9d7"/>
      <stop offset="100%" stop-color="#4facfe"/>
    </linearGradient>

    <!-- Dynamic Wave Crest & 3D Lighting -->
    <linearGradient id="wave-crest" x1="10%" y1="90%" x2="90%" y2="20%">
      <stop offset="0%" stop-color="#00f2fe"/>
      <stop offset="40%" stop-color="#38bdf8"/>
      <stop offset="75%" stop-color="#7ee7fc"/>
      <stop offset="100%" stop-color="#ffffff"/>
    </linearGradient>

    <!-- Wave Lower Shadow Drop -->
    <linearGradient id="wave-shadow" x1="20%" y1="20%" x2="30%" y2="100%">
      <stop offset="0%" stop-color="#020617" stop-opacity="0.8"/>
      <stop offset="100%" stop-color="#020617" stop-opacity="0"/>
    </linearGradient>

    <!-- Play Core: Pure Luminous Pearl with Ice Cyan Reflection -->
    <linearGradient id="play-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="45%" stop-color="#f0fdf4"/>
      <stop offset="80%" stop-color="#e0f2fe"/>
      <stop offset="100%" stop-color="#bae6fd"/>
    </linearGradient>

    <!-- Filters -->
    <filter id="emblem-shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#000000" flood-opacity="0.9"/>
    </filter>
    <filter id="wave-drop" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="-4" dy="14" stdDeviation="16" flood-color="#020817" flood-opacity="0.85"/>
    </filter>
    <filter id="play-glow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="0" stdDeviation="20" flood-color="#38bdf8" flood-opacity="0.75"/>
    </filter>
  </defs>

  <!-- Squircle Base Canvas -->
  <rect width="1024" height="1024" rx="224" fill="url(#aura-bg)"/>
  <rect width="1020" height="1020" x="2" y="2" rx="222" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>

  <!-- Ambient Nebula Halo -->
  <circle cx="512" cy="512" r="460" fill="url(#aura-backlight)"/>

  <!-- ================= MASTER EMBLEM GROUP ================= -->
  <g filter="url(#emblem-shadow)">

    <!-- 1. BACK/INNER ARCH FILL of the "A" (Forms the inner negative space contour) -->
    <!-- The outer left arch curves up to apex, right leg sweeps down -->
    
    <!-- LEFT PILLAR OF "A" -->
    <path d="M 270 730
             C 240 680, 270 520, 340 390
             C 390 290, 450 230, 512 220
             C 545 220, 570 240, 595 285
             C 530 330, 430 460, 375 580
             C 335 665, 305 725, 270 730 Z"
          fill="url(#left-arch)"/>

    <!-- RIGHT PILLAR OF "A" (Vibrant violet flare) -->
    <path d="M 512 220
             C 575 220, 640 280, 695 380
             C 755 490, 805 630, 870 748
             C 860 755, 835 756, 805 752
             C 750 745, 715 695, 680 620
             C 630 510, 575 360, 512 220 Z"
          fill="url(#right-leg)"/>

    <!-- INNER ARCH TRANSITION (Deep gradient shadow under apex) -->
    <path d="M 512 220
             C 475 250, 440 330, 420 400
             C 470 380, 540 370, 600 400
             C 580 330, 550 250, 512 220 Z"
          fill="#06122c" opacity="0.4"/>

    <!-- 2. STREAM WAVE CROSSBAR RIBBON (The Flagship Wave Swoop) -->
    <!-- Starts at left tail (140, 545), dips down through (260, 715), sweeps across center, crests at (740, 400), tapers to flick at (885, 525) -->
    <g filter="url(#wave-drop)">
      <!-- Main Wave Body -->
      <path d="M 144 548
               C 150 590, 185 680, 256 718
               C 325 752, 400 700, 490 610
               C 580 520, 670 420, 755 408
               C 830 398, 875 450, 888 528
               C 880 480, 840 425, 765 425
               C 660 425, 540 520, 440 615
               C 350 700, 275 735, 220 705
               C 175 680, 148 600, 144 548 Z"
            fill="url(#wave-body)"/>

      <!-- Wave Upper Facet / Brilliant Cyan Crest -->
      <path d="M 144 548
               C 170 640, 230 708, 305 708
               C 400 708, 525 560, 645 470
               C 725 410, 810 395, 888 528
               C 860 440, 800 405, 740 408
               C 650 415, 545 495, 455 580
               C 365 665, 290 710, 225 690
               C 170 665, 148 595, 144 548 Z"
            fill="url(#wave-crest)" opacity="0.95"/>

      <!-- Specular Highlight Line on Crest Ridge -->
      <path d="M 235 695
               C 320 720, 430 630, 540 535
               C 640 450, 735 410, 820 415"
            stroke="#ffffff" stroke-width="5" stroke-linecap="round" fill="none" opacity="0.8"/>
    </g>

    <!-- 3. MEDIA PLAY TRIANGLE (Centered in lower aperture) -->
    <g transform="translate(545, 665)" filter="url(#play-glow)">
      <!-- Soft bloom backplate -->
      <circle cx="-10" cy="0" r="85" fill="#38bdf8" opacity="0.25"/>
      
      <!-- Rounded Play Triangle -->
      <path d="M -42 -58
               C -42 -68, -28 -74, -20 -69
               L 66 -16
               C 74 -11, 74 3, 66 8
               L -20 61
               C -28 66, -42 60, -42 50 Z"
            fill="url(#play-grad)"/>

      <!-- Internal Facet Highlight -->
      <path d="M -34 -46 L 48 -4 L -34 38 Z" fill="#ffffff" opacity="0.6"/>
    </g>

  </g>
</svg>`;

// Write standalone master SVG
writeFileSync(join(brainDir, "aurastream_official_choice.svg"), standaloneSvg);
writeFileSync(join(root, "app-icon.svg"), standaloneSvg);
writeFileSync(join(root, "public", "logo.svg"), standaloneSvg);

// Unmasked source for iOS & Tauri pipeline (no rx/stroke on base rect)
const unmaskedSourceSvg = standaloneSvg
  .replace('<rect width="1024" height="1024" rx="224" fill="url(#aura-bg)"/>', '<rect width="1024" height="1024" fill="url(#aura-bg)"/>')
  .replace('<rect width="1020" height="1020" x="2" y="2" rx="222" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="2"/>', '');

writeFileSync(join(root, "src-tauri", "icons", "ios", "source.svg"), unmaskedSourceSvg);

// Android background color matching this artwork: #020412
const bgXml = `<?xml version="1.0" encoding="utf-8"?>
<resources>
   <color name="ic_launcher_background">#020412</color>
</resources>
`;
writeFileSync(join(root, "src-tauri", "icons", "android", "values", "ic_launcher_background.xml"), bgXml);
writeFileSync(join(root, "src-tauri", "gen", "android", "app", "src", "main", "res", "values", "ic_launcher_background.xml"), bgXml);

console.log("Master SVGs written successfully!");
