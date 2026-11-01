# Progress log

Newest at the bottom. One line per step, big or small. Update and push after every step.

## Done
- Recon map, feature matrix, architecture, SQLite schema, design tokens and component specs (`docs/`).
- Engine (Rust, std only): JSON, project model, FFmpeg driver, media import/probe/thumbnails/waveforms/proxies, export graph (transitions, effects, text, audio mix), command layer, local HTTP server with per-launch token. 16 tests pass.
- Original CC0 stock pack (6 videos, 4 images, 3 music loops, 3 sound effects) with licence records.
- Tauri 2 shell, NSIS installer config, Windows CI workflow.
- Repo renamed to `lite-editor` (trailing dot had broken CI checkout).
- 2026-10-28: first successful Windows build. Release `build-4` has `Lite.Editor_0.1.0_x64-setup.exe` (about 97 MB, NSIS, unsigned). **Do not use it**: `ui/main.js` and several UI modules were never committed, so that build opens to a blank window.
- 2026-10-28/30: wrote the missing UI modules (`main.js`, `ui.js`, `library.js`, `props.js`, `panels.js`): home screen, new-project dialog, transport, shortcuts, settings, media/stock/text/transitions/filters/audio panels, properties panel, export dialog, SRT import, voiceover recording.

## RESUME HERE (read this first)
Build 9 (commit 46bb5a9) ran the new Windows acceptance test. Result: **install, startup, window, import, encoder detection and uninstall all PASS on Windows; EXPORT FAILS.** Fixes in progress:
1. **Export broken on Windows.** The bundled FFmpeg (BtbN master, 2026) no longer has `-filter_complex_script`: "Unrecognized option". Fix: in `engine/src/export.rs::run`, detect at runtime whether `-/filter_complex <file>` works (FFmpeg 7+) and use it, else fall back to `-filter_complex_script` (older FFmpeg, e.g. the Linux 6.1 here). Cache the detection.
2. **Engine tests fail on Windows** (`tests/export_it.rs`, `tests/server_it.rs`): they call `ffmpeg` from PATH (not found on the runner), hard-code libx264 (absent in the LGPL build) and Linux font paths. Fix: use `Ff::locate()`, pick `libx264` if available else `mpeg4`/`pick_encoder`, fonts from `../ui/fonts` via `CARGO_MANIFEST_DIR`. NOTE `cargo test` stops at the first failing test file, so `server_it` has not yet run on Windows.
3. Add a preview-proxy check to the CI acceptance test (import a 1080p or non-browser-friendly clip, wait for the proxy job, ffprobe the result). Proxy encoders on Windows will be `h264_mf` (usable encoders on the runner: h264_mf, libopenh264, mpeg4, libvpx).
Then: push, wait for CI, read the release body. Only when it says `ACCEPTANCE: PASS` and engine tests pass, send the installer to the user.

### Windows numbers from build 9 (real, from the runner)
- Silent install OK, installed size 270 MB, installer 91 MB.
- Installed app answers on its local port in 0.6 s; window title "Lite Editor" opens.
- Idle memory: app 30 MB + WebView2 six processes 289 MB = about 319 MB total (target was under 300 MB; WebView2 dominates).
- Usable video encoders on the runner: h264_mf, libopenh264, mpeg4, libvpx.
- Uninstall exits 0 and removes the files.

## In progress
- Fixes 1 to 3 are WRITTEN and the 16 engine tests pass on Linux (old-syntax fallback path). The new `-/filter_complex` path can only be proven on Windows CI. Next: push, wait for the build, read the release body.

## Verified so far
- Linux, headless Chromium + real engine (`tools/smoke-ui.js`): full flow passes, no console errors. Export is 1280x720 H.264 + AAC, 6 s, frames not black.
- Installer `build-8` (commit 2c932e1) contents checked by decompressing the NSIS stream: all UI modules (including the page-load fix), `ffmpeg.exe`, `ffprobe.exe`, stock pack, fonts, licences. 95 MB installer, about 271 MB unpacked.
- Windows CI: engine tests step and installer build succeeded for build-8. NOTE: the tests step is `continue-on-error`, so its success flag proves little. The new report in the release body shows the true result.
- Low-spec numbers measured on Linux: engine process about 3.4 MB RSS; FFmpeg peak about 239 MB for a 720p export with layered clips, transition, text and audio mix; thumbnails about 65 MB. NOT yet measured: Windows webview memory (CI report will show it).

## Next
1. Read the CI report in the newest release body. Fix any failing check (likely areas: file dialogs via PowerShell, encoder availability in the LGPL FFmpeg build, window creation).
2. When the report says ACCEPTANCE: PASS, send the installer to the user (REST download, see CLAUDE.md) with the release link.
3. Open items: code signing (SmartScreen warning), H.264 licensing review before any public release, app name and audience decision, keyframes / speed curves / masks not built, per-clip waveform on timeline only for audio.
4. Old release `build-4` is the broken blank-window build. This session cannot edit or delete releases; user should delete it.

## Log
- 2026-11-01: export now probes for `-/filter_complex` vs `-filter_complex_script`; tests made portable (Ff::locate, working H.264 encoder, repo fonts); CI acceptance test gained a preview-copy (proxy) check.
- 2026-11-01: saved the Windows CI findings (this section) before starting the fixes.
- 2026-10-30: verified build-8 installer contents; measured engine memory; wrote the Windows CI acceptance test and test hook in `src-tauri/src/main.rs`; release body now carries the CI report.
- 2026-10-30: widened timeline track headers (labels were wrapping). Added a CI `concurrency` group so a newer push cancels the older build. Release `build-4` is the broken blank-window build; this session cannot edit releases, so the user should delete it or ignore it.
- 2026-10-30: added `tools/smoke-ui.js` (headless Chromium end-to-end test). Found and fixed one bug (media tab rendered before a project was open). Full flow passes: import, timeline, split, undo/redo, text, transition, filter, stock, playback, export (1280x720 H.264+AAC, 6 s, frames not black), reopen.
- 2026-10-30: added `CLAUDE.md` and this file so a new session can resume from the repo alone.
