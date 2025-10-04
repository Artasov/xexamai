# Releases via GitHub Actions

Automated cross-platform builds and releases triggered by pushing tags.

## 🚀 How to create a release

```bash
# Recommended way
npm version patch  # 0.1.0 → 0.1.1
git push origin main --tags

# Or manual tag
git tag v1.0.0
git push origin main --tags
```

## 📦 What gets built

- **Windows**: `xexamai-<version>.exe` (portable)
- **macOS**: `xexamai-<version>-x64.zip`, `xexamai-<version>-arm64.zip` 
- **Linux**: `xexamai-<version>-x86_64.AppImage` + `xexamai-<version>-linux-x64.tar.gz`

## 🔐 Integrity verification

Each platform creates a `checksums-<platform>.sha256` file.

## 🎯 Supported tags

- **Releases**: `v1.0.0`, `v2.1.3`
- **Prerelease**: `v1.0.0-beta.1`, `v1.0.0-alpha.2`
- **Hotfixes**: `release-1.0.0`, `release-hotfix`

## 🚨 Troubleshooting

- **Workflow not running**: Make sure the tag is new (not existing)
- **Build errors**: Check logs in GitHub Actions

