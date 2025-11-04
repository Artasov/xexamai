# Releases via GitHub Actions

Automated cross-platform builds and releases triggered by pushing tags.

## 🚀 How to create a release

```bash
# Patch
npm version patch # 0.1.0 → 0.1.1
git push origin main --tags

# Minor
npm version minor # 0.1.1 → 0.2.0
git push origin main --tags

# Major
npm version major # 0.2.0 → 1.0.0
git push origin main --tags

# Or manual tag
git tag v1.0.0
git push origin main --tags

```