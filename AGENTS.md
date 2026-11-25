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

## 4. Mandatory Public Repo & Secret Hygiene Rule
- `cozgams/AuraStream` is a PUBLIC repository. Never commit, hardcode, print, or expose any secrets anywhere in source code, scripts, workflows, docs, tests, or git history.
- Forbidden in the repository and git history: GitHub tokens (`ghp_`, `github_pat_`), API keys (`AIza`, `AQ.`, `sk-`, `gsk_`), Android signing keystores (`*.keystore`, `*.jks`, `*.p12`, `*.pem`), keystore/signing passwords (`--ks-pass pass:...`), `.env` files, private certificates, or personal credentials.
- Keep signing keystores exclusively outside the repository (e.g. `/data/home/Project/A/.signing/release.keystore` with `0600` permissions) and inject signing credentials only via environment variables (`AURASTREAM_KEYSTORE`, `AURASTREAM_KEYSTORE_PASS`, `AURASTREAM_KEY_ALIAS`) or GitHub Actions Secrets (`${{ secrets.* }}`).
- Before ANY commit, tag push, or release, scan tracked files and git history to verify zero leaked tokens, keys, or signing passwords exist.
