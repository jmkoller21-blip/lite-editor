use engine::cutout;
use engine::export::Progress;
use engine::ff::Ff;
use std::sync::atomic::AtomicBool;

/// Needs the runtime and model: set LITE_AI_DIR (the CI does). Skipped otherwise.
#[test]
fn makes_a_matte_video() {
    let ai = match cutout::ai_dir(None) {
        Some(d) if cutout::available(Some(&d)) => d,
        _ => {
            eprintln!("skipped: LITE_AI_DIR not set");
            return;
        }
    };
    let ff = Ff::locate();
    let dir = std::env::temp_dir().join(format!("lite-cutout-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("src.mp4");
    // a bright disc moving over a dark noisy background
    let st = ff.command("ffmpeg")
        .args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x202830:s=640x360:r=30:d=2",
               "-f", "lavfi", "-i", "color=c=0xe0c0a0:s=200x200:r=30:d=2", "-filter_complex",
               "[1]format=rgba,geq=lum='lum(X,Y)':a='if(lt(hypot(X-100,Y-100),95),255,0)'[d];[0][d]overlay=x='100+t*150':y=80",
               "-c:v", "mpeg4", "-q:v", "3"])
        .arg(&src).status().unwrap();
    assert!(st.success());
    let out = dir.join("mask.webm");
    let prog = Progress::new();
    cutout::make_mask(&ff, &ai, &src.to_string_lossy(), 2.0, &out, &prog, &AtomicBool::new(false)).unwrap_or_else(|e| panic!("matte failed: {}", e));
    let info = ff.probe(&out.to_string_lossy()).unwrap();
    assert!((info.dur as f64 / 1e6 - 2.0).abs() < 0.4, "matte length {}", info.dur);
    // the matte is not blank and not solid
    let o = ff.command("ffmpeg")
        .args(["-v", "error", "-ss", "1.0", "-i"]).arg(&out)
        .args(["-frames:v", "1", "-vf", "format=gray", "-f", "rawvideo", "-"]).output().unwrap();
    let (mut lo, mut hi) = (255u8, 0u8);
    for &b in &o.stdout { lo = lo.min(b); hi = hi.max(b); }
    assert!(o.stdout.len() == 320 * 320 && hi > lo + 80, "matte should have both dark and light areas: lo={} hi={}", lo, hi);
}

#[test]
fn export_uses_the_matte_as_transparency() {
    use engine::export::{self, Settings};
    use engine::json::Json;
    use engine::model::Project;
    let ai = match cutout::ai_dir(None) {
        Some(d) if cutout::available(Some(&d)) => d,
        _ => {
            eprintln!("skipped: LITE_AI_DIR not set");
            return;
        }
    };
    let ff = Ff::locate();
    let dir = std::env::temp_dir().join(format!("lite-cutout-test2-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let src = dir.join("src.mp4");
    let st = ff.command("ffmpeg")
        .args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x202830:s=640x360:r=30:d=2",
               "-f", "lavfi", "-i", "color=c=0xe0c0a0:s=200x200:r=30:d=2", "-filter_complex",
               "[1]format=rgba,geq=lum='lum(X,Y)':a='if(lt(hypot(X-100,Y-100),95),255,0)'[d];[0][d]overlay=x=220:y=80",
               "-c:v", "mpeg4", "-q:v", "3"])
        .arg(&src).status().unwrap();
    assert!(st.success());
    let blue = dir.join("blue.mp4");
    assert!(ff.command("ffmpeg").args(["-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=640x360:r=30:d=2", "-c:v", "mpeg4"]).arg(&blue).status().unwrap().success());
    let mask = dir.join("mask.webm");
    cutout::make_mask(&ff, &ai, &src.to_string_lossy(), 2.0, &mask, &Progress::new(), &AtomicBool::new(false)).unwrap();
    let f = |p: &std::path::Path| p.to_string_lossy().replace('\\', "/");
    let j = format!(r##"{{"name":"c","width":640,"height":360,"fps":30,
      "media":[{{"id":"m1","path":"{s}","kind":"video","dur":2000000,"w":640,"h":360,"has_audio":false}},
               {{"id":"m2","path":"{b}","kind":"video","dur":2000000,"w":640,"h":360,"has_audio":false}}],
      "tracks":[{{"id":"v1","kind":"video","clips":[{{"id":"c2","media":"m2","start":0,"dur":2000000}}]}},
                {{"id":"v2","kind":"video","clips":[{{"id":"c1","media":"m1","start":0,"dur":2000000,"cutout":"{m}"}}]}}]}}"##,
        s = f(&src), b = f(&blue), m = f(&mask));
    let p = Project::from_json(&Json::parse(&j).unwrap()).unwrap();
    let out = dir.join("out.mp4").to_string_lossy().to_string();
    let s = Settings { path: out.clone(), width: 640, height: 360, fps: 30.0, quality: "medium".into(), encoder: Ff::locate().usable_h264_encoders().into_iter().find(|e| e != "mpeg4").unwrap_or("mpeg4".into()), audio_only: false, font_regular: String::new(), font_bold: String::new(), work_dir: dir.clone() };
    let plan = export::plan(&p, &s, 0, p.duration()).unwrap();
    export::run(&ff, &plan, &out, &dir, &Progress::new()).unwrap_or_else(|e| panic!("cutout export failed: {}", e));
    let px = |x: u32, y: u32| {
        let o = ff.command("ffmpeg").args(["-v", "error", "-ss", "0.5", "-i", &out, "-frames:v", "1", "-vf", &format!("format=rgb24,crop=1:1:{}:{}", x, y), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).output().unwrap();
        (o.stdout[0], o.stdout[1], o.stdout[2])
    };
    let corner = px(8, 8);
    assert!(corner.2 > 150 && corner.0 < 100, "background should be removed so the blue clip shows through, got {:?}", corner);
}
