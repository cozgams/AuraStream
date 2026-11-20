# Agent Rules & Instructions for AuraStream (HGhubX)

## 1. MANDATORY GitHub APK Release Rule
Whenever ANY UI improvements, new features, bug fixes, or design adjustments are made to the app:
1. **Version Bump**:
   - Always bump the version using:
     `node scripts/set-version.mjs <new_version>` (e.g. `0.1.15`).
   - This synchronizes `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` with the calculated Android `versionCode`.
2. **Build and Test Verification**:
   - Verify TypeScript compilation: `pnpm tsc --noEmit && pnpm tsc --project tsconfig.tests.json`.
   - Run tests: `pnpm test`.
3. **Commit & Tag**:
   - Commit all changes and the version bump with a conventional commit message.
   - Tag the commit with the release version: `git tag v<version>` (e.g., `git tag v0.1.15`).
   - Push commit and tag to GitHub: `git push origin main --tags` (or `git push origin v<version>`).
4. **Publish GitHub Release with Downloadable APK Assets**:
   - Pushing the tag triggers `.github/workflows/release.yml` on GitHub Actions to build and release APKs for all ABIs (`arm`, `arm64`, `x86_64`).
   - Additionally, create or update the release immediately using the GitHub CLI with the repository token:
     ```bash
     GH_TOKEN="<token>" gh release create v<version> \
       --title "v<version>" \
       --generate-notes \
       /data/home/Project/A/HGhubX/downloads/*.apk
     ```
   - Always ensure the `.apk` files are attached directly as downloadable assets to the GitHub Release.
5. **Surface Release Link**:
   - Always present the clickable GitHub Release link (`https://github.com/cozgams/AuraStream/releases/tag/v<version>`) in the final response to the user so they can immediately download the APK on their device.

## 2. Branding & Zero-Emoji Policy
- AuraStream is handcrafted by AAA.
- Strictly ZERO emojis in any UI strings, system notifications, or UI components.
- In about/profile/license headers, keep "This App Created by AAA. All rights reserved."

## 3. Platform Scoping
- Android APK releases are the primary distribution format.
- Test and verify locally on Android container (`127.0.0.1:5555`).
