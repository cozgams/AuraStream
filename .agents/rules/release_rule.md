# Mandatory GitHub APK Release Rule

Whenever updates, improvements, bug fixes, or UI changes are made to AuraStream:
1. Bump version: `node scripts/set-version.mjs <new_version>`
2. Test and verify: `pnpm tsc --noEmit && pnpm tsc --project tsconfig.tests.json && pnpm test`
3. Commit and Tag: `git tag v<version>` and push `git push origin main --tags`
4. Publish GitHub Release with downloadable APK assets attached
5. Surface the clickable GitHub Release URL (`https://github.com/cozgams/AuraStream/releases/tag/v<version>`) to the user.

# Mandatory Public Repo & Secret Hygiene Rule

Never commit or push GitHub tokens, API keys, Android signing keystores (`*.keystore`/`*.jks`), keystore passwords, or `.env` files into tracked files or git history. Always keep signing keystores outside the repository and pass credentials via environment variables or GitHub Actions Secrets.
