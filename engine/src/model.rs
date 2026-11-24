//! Project model, parsed from the JSON the UI sends. Times are integer microseconds.

use crate::json::Json;
use std::collections::HashMap;

pub const US: i64 = 1_000_000;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum TrackKind {
    Video,
    Audio,
    Text,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

#[derive(Clone, Debug)]
pub struct Media {
    pub id: String,
    pub path: String,
    pub proxy: Option<String>,
    pub kind: MediaKind,
    pub dur: i64,
    pub w: u32,
    pub h: u32,
    pub has_audio: bool,
}

/// Numeric look parameters. The UI resolves named filters and their strength into these,
/// so preview (CSS) and export (FFmpeg) are driven by the same numbers.
#[derive(Clone, Debug)]
pub struct Adjust {
    pub brightness: f64, // -1..1, 0 = unchanged
    pub contrast: f64,   // 0..2, 1 = unchanged
    pub saturation: f64, // 0..3, 1 = unchanged
    pub hue: f64,        // degrees
    pub warmth: f64,     // -1..1 (cool..warm)
    pub blur: f64,       // pixels at project resolution
}

impl Default for Adjust {
    fn default() -> Self {
        Adjust { brightness: 0.0, contrast: 1.0, saturation: 1.0, hue: 0.0, warmth: 0.0, blur: 0.0 }
    }
}

impl Adjust {
    pub fn is_identity(&self) -> bool {
        self.brightness.abs() < 0.001
            && (self.contrast - 1.0).abs() < 0.001
            && (self.saturation - 1.0).abs() < 0.001
            && self.hue.abs() < 0.01
            && self.warmth.abs() < 0.001
            && self.blur < 0.01
    }
}

#[derive(Clone, Debug)]
pub struct TextSpec {
    pub content: String,
    pub size: f64, // fraction of canvas height
    pub color: String,
    pub bold: bool,
    pub outline: bool,
    pub shadow: bool,
    pub boxed: bool,
}

#[derive(Clone, Debug)]
pub struct Transition {
    pub kind: String,
    pub dur: i64,
}

#[derive(Clone, Debug)]
pub struct Clip {
    pub id: String,
    pub media_id: Option<String>,
    pub start: i64,
    pub dur: i64,
    pub src_in: i64,
    pub speed: f64,
    /// speed curve: (position along the clip 0..1, speed), linear between points
    pub curve: Option<Vec<(f64, f64)>>,
    /// matte video from background removal (used as the clip's transparency)
    pub cutout: Option<String>,
    /// shape mask (rectangle, circle, heart, line, mirror)
    pub mask: Option<Mask>,
    /// keyframes: per property, (position along the clip 0..1, value), linear between
    pub kf: Kf,
    /// edge softness 0..1 and grow/shrink -1..1 for the cut-out edge
    pub cutout_soft: f64,
    pub cutout_grow: f64,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rot: f64,
    pub opacity: f64,
    pub mirror: bool,
    /// freeze frame: shows the single source frame at `src_in` for the whole clip, no sound
    pub freeze: bool,
    pub volume: f64,
    pub fade_in: i64,
    pub fade_out: i64,
    pub adj: Adjust,
    pub text: Option<TextSpec>,
    pub transition_in: Option<Transition>,
}

#[derive(Clone, Debug)]
pub struct Mask {
    pub shape: String, // rect | ellipse | heart | linear | mirror
    pub x: f64,        // centre offset, fraction of the frame width (-0.5..0.5)
    pub y: f64,
    pub w: f64,        // size as a fraction of the frame
    pub h: f64,
    pub rot: f64,      // degrees
    pub feather: f64,  // 0..1
    pub invert: bool,
}

impl Mask {
    fn from_json(j: Option<&Json>) -> Option<Mask> {
        let m = j?;
        let shape = m.str_or("shape", "");
        if !["rect", "ellipse", "heart", "linear", "mirror"].contains(&shape.as_str()) {
            return None;
        }
        Some(Mask {
            shape,
            x: m.f64_or("x", 0.0).clamp(-1.0, 1.0),
            y: m.f64_or("y", 0.0).clamp(-1.0, 1.0),
            w: m.f64_or("w", 0.6).clamp(0.02, 4.0),
            h: m.f64_or("h", 0.6).clamp(0.02, 4.0),
            rot: m.f64_or("rot", 0.0),
            feather: m.f64_or("feather", 0.1).clamp(0.0, 1.0),
            invert: matches!(m.get("invert"), Some(Json::Bool(true))),
        })
    }

    /// FFmpeg `geq` expression (0..255) for this mask. X, Y, W, H are the frame's own variables.
    pub fn geq_expr(&self) -> String {
        self.geq_expr_with(None, None, None, None)
    }

    /// Same, but x, y, w and h may be FFmpeg expressions (of `T`) instead of the stored numbers,
    /// for an animated mask.
    pub fn geq_expr_with(&self, x: Option<String>, y: Option<String>, w: Option<String>, h: Option<String>) -> String {
        let a = self.rot.to_radians();
        let (c, s) = (a.cos(), a.sin());
        let f = self.feather.max(0.002);
        let xe = x.unwrap_or_else(|| format!("{:.5}", self.x.clamp(-1.0, 1.0)));
        let ye = y.unwrap_or_else(|| format!("{:.5}", self.y.clamp(-1.0, 1.0)));
        let we = w.unwrap_or_else(|| format!("{:.5}", self.w));
        let he = h.unwrap_or_else(|| format!("{:.5}", self.h));
        // st(0)=dx st(1)=dy st(2)=px st(3)=py (geq has only ten slots, 0..9, and the heart uses 4..6)
        let mut e = format!(
            "st(0,X-(0.5+({xe}))*W);st(1,Y-(0.5+({ye}))*H);st(2,(ld(0)*{c:.6}+ld(1)*{s:.6})/(max(0.02,{we})*W/2));st(3,(-ld(0)*{s:.6}+ld(1)*{c:.6})/(max(0.02,{he})*H/2));",
            xe = xe, ye = ye, we = we, he = he, c = c, s = s
        );
        let alpha = match self.shape.as_str() {
            "ellipse" => format!("clip((1-hypot(ld(2),ld(3)))/{:.5},0,1)", f),
            "rect" => format!("clip((1-max(abs(ld(2)),abs(ld(3))))/{:.5},0,1)", f),
            "linear" => format!("clip((0-ld(3))/{:.5}+0.5,0,1)", f),
            "mirror" => format!("clip((1-abs(ld(3)))/{:.5},0,1)", f),
            _ => {
                // heart: (x^2+y^2-1)^3 - x^2*y^3 <= 0
                e.push_str("st(4,ld(2)*1.15);st(5,-ld(3)*1.15);st(6,pow(ld(4)*ld(4)+ld(5)*ld(5)-1,3)-ld(4)*ld(4)*pow(ld(5),3));");
                format!("clip(0.5-ld(6)/{:.5},0,1)", 0.03 + f * 0.6)
            }
        };
        if self.invert {
            format!("{}255*(1-{})", e, alpha)
        } else {
            format!("{}255*{}", e, alpha)
        }
    }
}

/// One keyframe: time in seconds from the clip start, value, and the easing of the stretch up to the
/// next keyframe (0 linear, 1 smooth, 2 ease in, 3 ease out, 4 hold).
pub type KfPt = (f64, f64, u8);

#[derive(Clone, Debug, Default)]
pub struct Kf {
    pub x: Vec<KfPt>,
    pub y: Vec<KfPt>,
    pub scale: Vec<KfPt>,
    pub rot: Vec<KfPt>,
    pub opacity: Vec<KfPt>,
    pub volume: Vec<KfPt>,
    pub brightness: Vec<KfPt>,
    pub saturation: Vec<KfPt>,
    pub mask_x: Vec<KfPt>,
    pub mask_y: Vec<KfPt>,
    pub mask_w: Vec<KfPt>,
    pub mask_h: Vec<KfPt>,
}

pub fn parse_ease(s: &str) -> u8 {
    match s {
        "ease" => 1,
        "in" => 2,
        "out" => 3,
        "hold" => 4,
        _ => 0,
    }
}

fn parse_kf_track(j: Option<&Json>) -> Vec<KfPt> {
    let mut v: Vec<KfPt> = match j {
        Some(a) => a
            .as_arr()
            .iter()
            .filter_map(|p| {
                let a = p.as_arr();
                if a.len() < 2 {
                    return None;
                }
                let e = a.get(2).and_then(|x| x.as_str()).map(parse_ease).unwrap_or(0);
                // the UI sends microseconds; convert to seconds
                Some((a[0].as_f64()?.max(0.0) / 1_000_000.0, a[1].as_f64()?, e))
            })
            .collect(),
        None => Vec::new(),
    };
    v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    v
}

impl Kf {
    pub fn from_json(j: Option<&Json>) -> Kf {
        match j {
            Some(k) => Kf {
                x: parse_kf_track(k.get("x")),
                y: parse_kf_track(k.get("y")),
                scale: parse_kf_track(k.get("scale")),
                rot: parse_kf_track(k.get("rot")),
                opacity: parse_kf_track(k.get("opacity")),
                volume: parse_kf_track(k.get("volume")),
                brightness: parse_kf_track(k.get("brightness")),
                saturation: parse_kf_track(k.get("saturation")),
                mask_x: parse_kf_track(k.get("mask_x")),
                mask_y: parse_kf_track(k.get("mask_y")),
                mask_w: parse_kf_track(k.get("mask_w")),
                mask_h: parse_kf_track(k.get("mask_h")),
            },
            None => Kf::default(),
        }
    }
}

impl Clip {
    pub fn end(&self) -> i64 {
        self.start + self.dur
    }

    /// Source time (us) that has played `tl` us after the clip starts.
    pub fn src_off(&self, tl: i64) -> i64 {
        if self.freeze {
            return 0;
        }
        match &self.curve {
            None => (tl as f64 * self.speed) as i64,
            Some(k) => {
                let u = (tl as f64 / self.dur.max(1) as f64).clamp(0.0, 1.0);
                (self.dur as f64 * curve_integral(k, u)) as i64
            }
        }
    }
}

/// Integral of a piecewise-linear speed curve from 0 to u. The curve starts at 0 and ends at 1.
pub fn curve_integral(k: &[(f64, f64)], u: f64) -> f64 {
    let mut acc = 0.0;
    let (mut px, mut ps) = (0.0, k[0].1);
    for &(x, sp) in k {
        if x > px {
            let xe = x.min(u);
            if xe > px {
                let se = ps + (sp - ps) * ((xe - px) / (x - px));
                acc += (ps + se) / 2.0 * (xe - px);
            }
            if x >= u {
                return acc;
            }
        }
        px = x;
        ps = sp;
    }
    if u > px {
        acc += ps * (u - px);
    }
    acc
}

fn parse_curve(c: &Json) -> Option<Vec<(f64, f64)>> {
    let arr = c.get("curve")?.as_arr();
    let mut pts: Vec<(f64, f64)> = arr
        .iter()
        .filter_map(|p| {
            let a = p.as_arr();
            if a.len() < 2 {
                return None;
            }
            Some((a[0].as_f64()?.clamp(0.0, 1.0), a[1].as_f64()?.clamp(0.1, 10.0)))
        })
        .collect();
    if pts.len() < 2 {
        return None;
    }
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
    if pts[0].0 > 0.0 {
        let s = pts[0].1;
        pts.insert(0, (0.0, s));
    }
    if pts[pts.len() - 1].0 < 1.0 {
        let s = pts[pts.len() - 1].1;
        pts.push((1.0, s));
    }
    Some(pts)
}

#[derive(Clone, Debug)]
pub struct Track {
    pub id: String,
    pub kind: TrackKind,
    pub muted: bool,
    pub hidden: bool,
    pub clips: Vec<Clip>,
}

#[derive(Clone, Debug)]
pub struct Project {
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub tracks: Vec<Track>, // bottom to top
    pub media: HashMap<String, Media>,
}

impl Project {
    pub fn from_json(j: &Json) -> Result<Project, String> {
        let width = j.i64_or("width", 1920).clamp(16, 7680) as u32;
        let height = j.i64_or("height", 1080).clamp(16, 4320) as u32;
        let fps = j.f64_or("fps", 30.0).clamp(1.0, 120.0);
        let mut media = HashMap::new();
        for m in j.get("media").map(|m| m.as_arr()).unwrap_or(&[]) {
            let kind = match m.str_or("kind", "video").as_str() {
                "audio" => MediaKind::Audio,
                "image" => MediaKind::Image,
                _ => MediaKind::Video,
            };
            let id = m.str_or("id", "");
            if id.is_empty() {
                continue;
            }
            let proxy = m.get("proxy").and_then(|p| p.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
            media.insert(
                id.clone(),
                Media {
                    id,
                    path: m.str_or("path", ""),
                    proxy,
                    kind,
                    dur: m.i64_or("dur", 0),
                    w: m.i64_or("w", 0).max(0) as u32,
                    h: m.i64_or("h", 0).max(0) as u32,
                    has_audio: m.bool_or("has_audio", false),
                },
            );
        }
        let mut tracks = Vec::new();
        for t in j.get("tracks").map(|t| t.as_arr()).unwrap_or(&[]) {
            let kind = match t.str_or("kind", "video").as_str() {
                "audio" => TrackKind::Audio,
                "text" => TrackKind::Text,
                _ => TrackKind::Video,
            };
            let mut clips = Vec::new();
            for c in t.get("clips").map(|c| c.as_arr()).unwrap_or(&[]) {
                let adj = match c.get("adj") {
                    Some(a) => Adjust {
                        brightness: a.f64_or("brightness", 0.0).clamp(-1.0, 1.0),
                        contrast: a.f64_or("contrast", 1.0).clamp(0.0, 3.0),
                        saturation: a.f64_or("saturation", 1.0).clamp(0.0, 3.0),
                        hue: a.f64_or("hue", 0.0).clamp(-180.0, 180.0),
                        warmth: a.f64_or("warmth", 0.0).clamp(-1.0, 1.0),
                        blur: a.f64_or("blur", 0.0).clamp(0.0, 60.0),
                    },
                    None => Adjust::default(),
                };
                let text = c.get("text").map(|x| TextSpec {
                    content: x.str_or("content", ""),
                    size: x.f64_or("size", 0.08).clamp(0.01, 0.5),
                    color: x.str_or("color", "#ffffff"),
                    bold: x.bool_or("bold", true),
                    outline: x.bool_or("outline", true),
                    shadow: x.bool_or("shadow", false),
                    boxed: x.bool_or("boxed", false),
                });
                let transition_in = c.get("transition_in").and_then(|t| {
                    let kind = t.str_or("kind", "");
                    let dur = t.i64_or("dur", 0);
                    if kind.is_empty() || dur <= 0 { None } else { Some(Transition { kind, dur }) }
                });
                let dur = c.i64_or("dur", 0);
                if dur <= 0 {
                    continue;
                }
                clips.push(Clip {
                    id: c.str_or("id", ""),
                    media_id: c.get("media").and_then(|m| m.as_str()).map(|s| s.to_string()),
                    start: c.i64_or("start", 0).max(0),
                    dur,
                    src_in: c.i64_or("in", 0).max(0),
                    speed: c.f64_or("speed", 1.0).clamp(0.1, 16.0),
                    curve: parse_curve(c),
                    kf: Kf::from_json(c.get("kf")),
                    mask: Mask::from_json(c.get("mask")),
                    cutout_soft: c.f64_or("cutout_soft", 0.0).clamp(0.0, 1.0),
                    cutout_grow: c.f64_or("cutout_grow", 0.0).clamp(-1.0, 1.0),
                    cutout: c.get("cutout").and_then(|m| m.as_str()).filter(|m| !m.is_empty()).map(|m| m.to_string()),
                    x: c.f64_or("x", 0.0),
                    y: c.f64_or("y", 0.0),
                    scale: c.f64_or("scale", 1.0).clamp(0.01, 20.0),
                    rot: c.f64_or("rot", 0.0),
                    opacity: c.f64_or("opacity", 1.0).clamp(0.0, 1.0),
                    mirror: c.bool_or("mirror", false),
                    freeze: c.bool_or("freeze", false),
                    volume: c.f64_or("volume", 1.0).clamp(0.0, 4.0),
                    fade_in: c.i64_or("fade_in", 0).max(0),
                    fade_out: c.i64_or("fade_out", 0).max(0),
                    adj,
                    text,
                    transition_in,
                });
            }
            clips.sort_by_key(|c| c.start);
            tracks.push(Track {
                id: t.str_or("id", ""),
                kind,
                muted: t.bool_or("muted", false),
                hidden: t.bool_or("hidden", false),
                clips,
            });
        }
        Ok(Project { name: j.str_or("name", "Untitled"), width, height, fps, tracks, media })
    }

    /// End of the last clip on any track.
    pub fn duration(&self) -> i64 {
        self.tracks.iter().flat_map(|t| t.clips.iter()).map(|c| c.end()).max().unwrap_or(0)
    }
}
