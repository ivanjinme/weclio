# Release

Desktop installers only. Low frequency: read this when building, signing or publishing a
release. Daily development and checks live in `COMMANDS.md`.

## Build and sign

```bash
npm run setup:desktop-updates   # one-off; never overwrites existing key or config
npm version patch --no-git-tag-version
npm run release:desktop
(cd build/desktop/dist && sha256sum -c SHA256SUMS.txt)
```

## Publish

```bash
VERSION=$(node -p "require('./package.json').version")
COMMIT=$(git rev-parse HEAD)   # only when verified as the artifact source

gh release create "desktop-v$VERSION" --draft --target "$COMMIT" \
  "build/desktop/dist/Weclio-$VERSION-x64-Setup.exe" \
  "build/desktop/dist/Weclio-$VERSION-x64-Setup.exe.blockmap" \
  "build/desktop/dist/desktop-update-manifest.json" \
  "build/desktop/dist/SHA256SUMS.txt"
```

## Constraints

- Tag `desktop-v*`, never `v*`.
- Upload exactly those four artifacts. No dist wildcards, no `--clobber`.
- `--target` must be the commit that produced the artifacts.
- Back up `~/.weclio/release-keys/desktop-update.ed25519.pem`. A lost key cannot be regenerated,
  and re-initializing `desktop-update.json` breaks clients already installed.
- Verify assets, signature, version and source before `--draft=false --latest`. Flipping Latest is
  a separate, explicitly approved action.
- Ed25519 signs update metadata only, not Authenticode: Windows still shows an unknown publisher.
- Acceptance needs a real installed A→B upgrade on a Windows VM, not a source-mode window.
- Never run `npm run release`; npm publish is retired.
