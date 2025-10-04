# Releases via GitHub Actions

Trigger a cross-platform build and GitHub Release by pushing a semver tag.

How to release:

1. Update `package.json` version as needed.
2. Create and push a tag:
   - `git tag v0.1.0`
   - `git push origin v0.1.0`

What gets built and attached:

- Windows: `xexamai-<version>.exe`
- macOS: `*.zip` for `x64` and `arm64`
- Linux: `xexamai-<version>-linux-x64.tar.gz`

Checksums:

- Each platform job also uploads a `checksums-<platform>.sha256` file.

Notes:

- Builds run with Node 20.
- macOS builds use hardened runtime with minimal entitlements.
- No code signing or notarization is performed in CI by default.

