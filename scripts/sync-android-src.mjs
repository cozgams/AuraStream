#!/usr/bin/env node
/**
 * Synchronizes Android source files (MainActivity, AuraDownloadService, AndroidManifest, file_paths)
 * into the generated Android project directory.
 * Ensures local builds and CI release builds preserve native background services and permissions.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const required = process.argv.includes("--required");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src-tauri", "android-src");
const genApp = join(root, "src-tauri", "gen", "android", "app", "src", "main");

try {
  if (!existsSync(src)) {
    const msg = `[android-src] Missing source directory: ${src}`;
    if (required) {
      console.error(msg);
      process.exit(1);
    }
    console.log(`[android-src] Skipped: missing ${src}`);
    process.exit(0);
  }
  if (!existsSync(genApp)) {
    const msg = `[android-src] Missing generated Android directory: ${genApp}`;
    if (required) {
      console.error(msg);
      process.exit(1);
    }
    console.log("[android-src] Skipped: gen/android directory not yet initialized");
    process.exit(0);
  }

  const ktFiles = readdirSync(src).filter((f) => f.endsWith(".kt"));
  for (const reqKt of ["MainActivity.kt", "AuraDownloadService.kt"]) {
    if (!ktFiles.includes(reqKt)) {
      throw new Error(`Missing required Kotlin source file: ${join(src, reqKt)}`);
    }
  }
  for (const xmlReq of ["AndroidManifest.xml", "file_paths.xml"]) {
    const p = join(src, xmlReq);
    if (!existsSync(p)) {
      throw new Error(`Missing required Android resource/manifest file: ${p}`);
    }
  }

  // 1. Copy all *.kt files (including MainActivity.kt and AuraDownloadService.kt)
  const javaDest = join(genApp, "java", "com", "aurastream", "app");
  mkdirSync(javaDest, { recursive: true });
  for (const kt of ktFiles) {
    cpSync(join(src, kt), join(javaDest, kt), { force: true });
  }

  // 2. Copy AndroidManifest.xml
  cpSync(join(src, "AndroidManifest.xml"), join(genApp, "AndroidManifest.xml"), { force: true });

  // 3. Copy file_paths.xml
  const xmlDest = join(genApp, "res", "xml");
  mkdirSync(xmlDest, { recursive: true });
  cpSync(join(src, "file_paths.xml"), join(xmlDest, "file_paths.xml"), { force: true });

  // 4. Copy theme resources if present so CI builds preserve cold-launch windowBackground
  if (existsSync(join(src, "themes.xml"))) {
    const valDest = join(genApp, "res", "values");
    mkdirSync(valDest, { recursive: true });
    cpSync(join(src, "themes.xml"), join(valDest, "themes.xml"), { force: true });
  }
  if (existsSync(join(src, "themes-night.xml"))) {
    const valNightDest = join(genApp, "res", "values-night");
    mkdirSync(valNightDest, { recursive: true });
    cpSync(join(src, "themes-night.xml"), join(valNightDest, "themes.xml"), { force: true });
  }

  // 5. Align Kotlin & Java target to JVM 17 in generated Gradle scripts
  const appGradle = join(root, "src-tauri", "gen", "android", "app", "build.gradle.kts");
  if (existsSync(appGradle)) {
    let gradleText = readFileSync(appGradle, "utf8");
    const updatedGradle = gradleText
      .replace(/jvmTarget\s*=\s*"1\.8"/g, 'jvmTarget = "17"')
      .replace(
        /(kotlinOptions\s*\{)/,
        gradleText.includes("compileOptions")
          ? "$1"
          : 'compileOptions {\n        sourceCompatibility = JavaVersion.VERSION_17\n        targetCompatibility = JavaVersion.VERSION_17\n    }\n    $1',
      );
    if (updatedGradle !== gradleText) {
      writeFileSync(appGradle, updatedGradle, "utf8");
    }
  }

  const gradleProps = join(root, "src-tauri", "gen", "android", "gradle.properties");
  if (existsSync(gradleProps)) {
    let propsText = readFileSync(gradleProps, "utf8");
    if (!propsText.includes("android.suppressUnsupportedCompileSdk=")) {
      propsText = `${propsText.trimEnd()}\nandroid.suppressUnsupportedCompileSdk=36\n`;
      writeFileSync(gradleProps, propsText, "utf8");
    }
  }

  console.log(`[android-src] Synchronized ${ktFiles.length} Kotlin file(s) + manifest/xml/themes -> ${genApp}`);
} catch (err) {
  console.error("[android-src] Synchronization failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
