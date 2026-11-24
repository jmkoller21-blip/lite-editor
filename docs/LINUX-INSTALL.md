# Linux installer (.deb and AppImage)

Every build on `main` now ships a Linux installer alongside the Windows `.exe`.
The CI job `linux` in `.github/workflows/build-windows.yml` builds both on
`ubuntu-22.04` from the same commit as the Windows build and attaches them to
the GitHub release `build-<N>`:

- `Lite.Editor_0.1.0_amd64.deb` — Debian/Ubuntu installer (~145 MB)
- `Lite.Editor_0.1.0_amd64.AppImage` — portable single-file (~210 MB)

## Installing a build

The repo includes a helper that downloads and installs a build from GitHub:

```bash
# latest release, .deb (Debian/Ubuntu/Mint)
./tools/install-linux.sh

# a specific build, .deb
./tools/install-linux.sh 32

# latest release, AppImage (portable, no install needed)
./tools/install-linux.sh --appimage

# a specific build, AppImage
./tools/install-linux.sh 32 --appimage
```

The `.deb` path uses `dpkg`/`apt` and may ask for `sudo`; it pulls in the
Tauri system dependencies (WebKitGTK, OpenSSL, etc.) automatically.

The `AppImage` path just downloads, `chmod +x`, and runs — no root, no system
changes. Copy it to `~/.local/bin/lite-editor.AppImage` and add a `.desktop`
file (the script prints one) if you want it in your app menu.

## How the CI builds it

The `linux` job runs after `windows` on every push and `workflow_dispatch`:

1. Installs Tauri system libraries on `ubuntu-22.04`
   (`libwebkit2gtk-4.1-dev`, `libssl-dev`, `patchelf`, `file`, …)
2. Fetches the BtbN linux64 LGPL FFmpeg and ONNX Runtime 1.20.1 (PyPI wheel)
   plus the U2-Net-p background-removal model into `ffmpeg/` and `ai/`
3. Runs the engine test suite with `LITE_FFMPEG_DIR` and `LITE_AI_DIR`
4. Runs `npx --yes @tauri-apps/cli@2 build --bundles deb appimage`
5. Uploads the `.deb` and `.AppImage` as artifacts and attaches them to the
   `build-<N>` release

The same FFmpeg and ONNX Runtime binaries are bundled into the installed app
at runtime (resources `ffmpeg` and `ai` in `src-tauri/tauri.conf.json`).

## Current status

- Build-32 (CI run 32, commit 67b7cec) PASSED the Linux job:
  `Lite.Editor_0.1.0_amd64.deb` (145 MB) and `Lite.Editor_0.1.0_amd64.AppImage`
  (210 MB) are on release `build-32`. ACCEPTANCE: PASS (same known
  `server_it` engine-test failure as Windows).
- Linux installers have **not** been launched on a real Linux desktop yet.
  The next step is a smoke test on Linux: install the `.deb`, start the app,
  import a clip, export, and confirm the AppImage runs.

## Notes

- The Windows target is still the primary platform (`windows 10/11`,
  i3 / 4 GB / Intel HD 4000 class). Linux is a best-effort extra build from the
  same source; there is no WebView2 on Linux, so the shell uses WebKitGTK.
- The installer is unsigned. On Linux this is normally fine, but a package
  manager may warn about an untrusted origin.
