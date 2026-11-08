//! Background removal. A small AI model (U2-Net, 4.5 MB) draws a matte for every few frames of a
//! video; the mattes are stored as a small grey video next to the cache. Export and preview use
//! that matte video as the clip's transparency, so the original footage is never touched.

use crate::export::Progress;
use crate::ff::Ff;
use crate::ort::{Matter, SIDE};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

pub const MASK_FPS: f64 = 15.0;

pub fn lib_name() -> &'static str {
    if cfg!(windows) { "onnxruntime.dll" } else { "libonnxruntime.so" }
}

/// Where the runtime and the model live: LITE_AI_DIR, or `ai` next to the bundled `ffmpeg` folder.
pub fn ai_dir(ffmpeg_dir: Option<&Path>) -> Option<PathBuf> {
    if let Ok(d) = std::env::var("LITE_AI_DIR") {
        if !d.is_empty() {
            return Some(PathBuf::from(d));
        }
    }
    ffmpeg_dir.and_then(|f| f.parent()).map(|p| p.join("ai"))
}

pub fn available(ai: Option<&Path>) -> bool {
    match ai {
        Some(d) => d.join(lib_name()).exists() && d.join("u2netp.onnx").exists(),
        None => false,
    }
}

/// Make the matte video for `src` (a video file). `dur_s` is only used for the progress bar.
pub fn make_mask(ff: &Ff, ai: &Path, src: &str, dur_s: f64, out: &Path, prog: &Progress, cancel: &AtomicBool) -> Result<(), String> {
    let mut matter = Matter::load(&ai.join(lib_name()), &ai.join("u2netp.onnx"), 2)?;
    let side = SIDE.to_string();
    let mut dec = ff
        .ffmpeg()
        .args(["-v", "error", "-i", src, "-an", "-vf"])
        .arg(format!("fps={},scale={}:{}:flags=bilinear", MASK_FPS, side, side))
        .args(["-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start FFmpeg: {}", e))?;
    let tmp = out.with_extension("part.webm");
    let mut enc = ff
        .ffmpeg()
        .args(["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "gray", "-s"])
        .arg(format!("{}x{}", side, side))
        .args(["-r"])
        .arg(format!("{}", MASK_FPS))
        .args(["-i", "-", "-c:v", "libvpx", "-pix_fmt", "yuv420p", "-b:v", "1500k", "-crf", "10", "-g", "30", "-auto-alt-ref", "0", "-f", "webm"])
        .arg(&tmp)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start FFmpeg: {}", e))?;
    let mut rd = dec.stdout.take().unwrap();
    let mut wr = enc.stdin.take().unwrap();
    let n = SIDE * SIDE;
    let mut rgb = vec![0u8; n * 3];
    let mut matte = vec![0u8; n];
    let total = (dur_s * MASK_FPS).max(1.0);
    let mut done = 0f64;
    let mut result = Ok(());
    loop {
        if cancel.load(Ordering::Relaxed) || prog.cancel.load(Ordering::Relaxed) {
            result = Err("cancelled".to_string());
            break;
        }
        match read_full(&mut rd, &mut rgb) {
            Ok(true) => {}
            Ok(false) => break,
            Err(e) => {
                result = Err(e);
                break;
            }
        }
        if let Err(e) = matter.matte(&rgb, &mut matte) {
            result = Err(e);
            break;
        }
        if wr.write_all(&matte).is_err() {
            result = Err("could not write the matte video".into());
            break;
        }
        done += 1.0;
        *prog.pct.lock().unwrap() = (done / total * 100.0).clamp(0.0, 99.0);
    }
    drop(wr);
    if result.is_err() {
        let _ = dec.kill();
        let _ = enc.kill();
    }
    let _ = dec.wait();
    let st = enc.wait().map_err(|e| e.to_string())?;
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    if !st.success() || done < 1.0 {
        let _ = std::fs::remove_file(&tmp);
        return Err("background removal produced no video".into());
    }
    std::fs::rename(&tmp, out).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_full(r: &mut impl Read, buf: &mut [u8]) -> Result<bool, String> {
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..]) {
            Ok(0) => return Ok(false),
            Ok(k) => got += k,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(true)
}
