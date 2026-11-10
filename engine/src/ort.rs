//! Minimal ONNX Runtime binding, loaded at run time (no build-time dependency). Used for the
//! background-removal model. Only the handful of C API calls we need; function positions in the
//! OrtApi table are fixed by the C header and never change between versions.
//!
//! The runtime library (onnxruntime.dll / libonnxruntime.so) is shipped next to the app. If it or
//! the model is missing, `Matter::load` returns an error and the rest of the editor is unaffected.

use std::ffi::{c_void, CStr, CString};
use std::os::raw::{c_char, c_int};
use std::path::Path;

#[cfg(unix)]
extern "C" {
    fn dlopen(path: *const c_char, flags: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, name: *const c_char) -> *mut c_void;
}
#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn SetErrorMode(mode: u32) -> u32;
    fn LoadLibraryExW(path: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
    fn GetProcAddress(handle: *mut c_void, name: *const c_char) -> *mut c_void;
}

fn load_symbol(lib: &Path, sym: &str) -> Result<*mut c_void, String> {
    let sym_c = CString::new(sym).unwrap();
    #[cfg(unix)]
    unsafe {
        let p = CString::new(lib.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
        let h = dlopen(p.as_ptr(), 2);
        if h.is_null() {
            return Err(format!("could not load {}", lib.display()));
        }
        let s = dlsym(h, sym_c.as_ptr());
        if s.is_null() { Err("onnxruntime entry point missing".into()) } else { Ok(s) }
    }
    #[cfg(windows)]
    unsafe {
        use std::os::windows::ffi::OsStrExt;
        let w: Vec<u16> = lib.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        SetErrorMode(1); // never show a blocking 'missing DLL' box
        // 8 = look for the DLL's own dependencies (the VC runtime we ship beside it) in its folder first
        let h = LoadLibraryExW(w.as_ptr(), std::ptr::null_mut(), 8);
        if h.is_null() {
            return Err(format!("could not load {}", lib.display()));
        }
        let s = GetProcAddress(h, sym_c.as_ptr());
        if s.is_null() { Err("onnxruntime entry point missing".into()) } else { Ok(s) }
    }
}

type Status = *mut c_void;
type ApiTable = *const *const c_void;

#[repr(C)]
struct ApiBase {
    get_api: extern "C" fn(u32) -> ApiTable,
}

// positions in the OrtApi function table (from onnxruntime_c_api.h)
const GET_ERROR_MESSAGE: usize = 2;
const CREATE_ENV: usize = 3;
const CREATE_SESSION: usize = 7;
const RUN: usize = 9;
const CREATE_SESSION_OPTIONS: usize = 10;
const SESSION_GET_INPUT_NAME: usize = 36;
const SESSION_GET_OUTPUT_NAME: usize = 37;
const SET_GRAPH_OPT_LEVEL: usize = 23;
const SET_INTRA_THREADS: usize = 24;
const CREATE_TENSOR_WITH_DATA: usize = 49;
const GET_TENSOR_MUTABLE_DATA: usize = 51;
const CREATE_CPU_MEMORY_INFO: usize = 69;
const ALLOCATOR_FREE: usize = 76;
const GET_ALLOCATOR_DEFAULT: usize = 78;
const RELEASE_ENV: usize = 92;
const RELEASE_STATUS: usize = 93;
const RELEASE_MEMORY_INFO: usize = 94;
const RELEASE_SESSION: usize = 95;
const RELEASE_VALUE: usize = 96;

pub const SIDE: usize = 320; // the model works on 320 x 320 pictures

pub struct Matter {
    api: ApiTable,
    env: *mut c_void,
    session: *mut c_void,
    mem: *mut c_void,
    in_name: CString,
    out_name: CString,
    prev: Vec<f32>,
}

// The runtime is used from one thread at a time (a job owns its Matter).
unsafe impl Send for Matter {}

impl Matter {
    unsafe fn f<T: Copy>(&self, i: usize) -> T {
        std::mem::transmute_copy(&*self.api.add(i))
    }

    unsafe fn check(&self, st: Status) -> Result<(), String> {
        if st.is_null() {
            return Ok(());
        }
        let msg: extern "C" fn(Status) -> *const c_char = self.f(GET_ERROR_MESSAGE);
        let m = CStr::from_ptr(msg(st)).to_string_lossy().to_string();
        let rel: extern "C" fn(Status) = self.f(RELEASE_STATUS);
        rel(st);
        Err(m)
    }

    /// Load the runtime library and the model. `threads` limits CPU use.
    pub fn load(lib: &Path, model: &Path, threads: i32) -> Result<Matter, String> {
        if !lib.exists() {
            return Err(format!("the background-removal runtime is missing ({})", lib.display()));
        }
        if !model.exists() {
            return Err(format!("the background-removal model is missing ({})", model.display()));
        }
        unsafe {
            let base_fn = load_symbol(lib, "OrtGetApiBase")?;
            let base: extern "C" fn() -> *const ApiBase = std::mem::transmute(base_fn);
            let b = base();
            if b.is_null() {
                return Err("onnxruntime did not answer".into());
            }
            let mut api = ((*b).get_api)(17);
            if api.is_null() {
                api = ((*b).get_api)(16);
            }
            if api.is_null() {
                return Err("this onnxruntime is too old".into());
            }
            let mut m = Matter {
                api,
                env: std::ptr::null_mut(),
                session: std::ptr::null_mut(),
                mem: std::ptr::null_mut(),
                in_name: CString::default(),
                out_name: CString::default(),
                prev: Vec::new(),
            };
            let create_env: extern "C" fn(c_int, *const c_char, *mut *mut c_void) -> Status = m.f(CREATE_ENV);
            let id = CString::new("lite").unwrap();
            let mut env: *mut c_void = std::ptr::null_mut();
            let st = create_env(3, id.as_ptr(), &mut env);
            m.env = env;
            m.check(st)?;
            let create_opts: extern "C" fn(*mut *mut c_void) -> Status = m.f(CREATE_SESSION_OPTIONS);
            let mut opts: *mut c_void = std::ptr::null_mut();
            m.check(create_opts(&mut opts))?;
            let set_threads: extern "C" fn(*mut c_void, c_int) -> Status = m.f(SET_INTRA_THREADS);
            m.check(set_threads(opts, threads.max(1)))?;
            let set_opt: extern "C" fn(*mut c_void, c_int) -> Status = m.f(SET_GRAPH_OPT_LEVEL);
            m.check(set_opt(opts, 99))?;
            #[cfg(windows)]
            let model_arg: Vec<u16> = {
                use std::os::windows::ffi::OsStrExt;
                model.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
            };
            #[cfg(unix)]
            let model_arg = CString::new(model.to_string_lossy().as_bytes()).map_err(|e| e.to_string())?;
            let create_session: extern "C" fn(*mut c_void, *const c_void, *mut c_void, *mut *mut c_void) -> Status = m.f(CREATE_SESSION);
            let mut sess: *mut c_void = std::ptr::null_mut();
            let st = create_session(m.env, model_arg.as_ptr() as *const c_void, opts, &mut sess);
            m.session = sess;
            m.check(st)?;

            let get_alloc: extern "C" fn(*mut *mut c_void) -> Status = m.f(GET_ALLOCATOR_DEFAULT);
            let mut alloc: *mut c_void = std::ptr::null_mut();
            m.check(get_alloc(&mut alloc))?;
            let free: extern "C" fn(*mut c_void, *mut c_void) -> Status = m.f(ALLOCATOR_FREE);
            let get_in: extern "C" fn(*mut c_void, usize, *mut c_void, *mut *mut c_char) -> Status = m.f(SESSION_GET_INPUT_NAME);
            let get_out: extern "C" fn(*mut c_void, usize, *mut c_void, *mut *mut c_char) -> Status = m.f(SESSION_GET_OUTPUT_NAME);
            let (mut pi, mut po): (*mut c_char, *mut c_char) = (std::ptr::null_mut(), std::ptr::null_mut());
            m.check(get_in(m.session, 0, alloc, &mut pi))?;
            m.check(get_out(m.session, 0, alloc, &mut po))?;
            m.in_name = CStr::from_ptr(pi).to_owned();
            m.out_name = CStr::from_ptr(po).to_owned();
            let _ = free(alloc, pi as *mut c_void);
            let _ = free(alloc, po as *mut c_void);

            let cpu_mem: extern "C" fn(c_int, c_int, *mut *mut c_void) -> Status = m.f(CREATE_CPU_MEMORY_INFO);
            let mut mem: *mut c_void = std::ptr::null_mut();
            let st = cpu_mem(1, 0, &mut mem);
            m.mem = mem;
            m.check(st)?;
            Ok(m)
        }
    }

    /// One picture in (SIDE x SIDE, RGB bytes), one matte out (SIDE x SIDE, 0 = background, 255 = subject).
    /// Mattes are blended with the previous one a little so the edge does not flicker.
    pub fn matte(&mut self, rgb: &[u8], out: &mut [u8]) -> Result<(), String> {
        let n = SIDE * SIDE;
        if rgb.len() < n * 3 || out.len() < n {
            return Err("bad picture size".into());
        }
        let mean = [0.485f32, 0.456, 0.406];
        let std = [0.229f32, 0.224, 0.225];
        let mut input = vec![0f32; n * 3];
        for i in 0..n {
            for c in 0..3 {
                input[c * n + i] = (rgb[i * 3 + c] as f32 / 255.0 - mean[c]) / std[c];
            }
        }
        unsafe {
            let make: extern "C" fn(*mut c_void, *mut c_void, usize, *const i64, usize, c_int, *mut *mut c_void) -> Status =
                self.f(CREATE_TENSOR_WITH_DATA);
            let shape: [i64; 4] = [1, 3, SIDE as i64, SIDE as i64];
            let mut inv: *mut c_void = std::ptr::null_mut();
            self.check(make(self.mem, input.as_mut_ptr() as *mut c_void, input.len() * 4, shape.as_ptr(), 4, 1, &mut inv))?;
            let run: extern "C" fn(*mut c_void, *mut c_void, *const *const c_char, *const *mut c_void, usize, *const *const c_char, usize, *mut *mut c_void) -> Status =
                self.f(RUN);
            let in_names = [self.in_name.as_ptr()];
            let out_names = [self.out_name.as_ptr()];
            let inputs = [inv];
            let mut outv: *mut c_void = std::ptr::null_mut();
            let st = run(self.session, std::ptr::null_mut(), in_names.as_ptr(), inputs.as_ptr(), 1, out_names.as_ptr(), 1, &mut outv);
            let rel_v: extern "C" fn(*mut c_void) = self.f(RELEASE_VALUE);
            let r = self.check(st);
            rel_v(inv);
            r?;
            let get_data: extern "C" fn(*mut c_void, *mut *mut c_void) -> Status = self.f(GET_TENSOR_MUTABLE_DATA);
            let mut data: *mut c_void = std::ptr::null_mut();
            let r = self.check(get_data(outv, &mut data));
            if r.is_err() || data.is_null() {
                rel_v(outv);
                return Err(r.err().unwrap_or_else(|| "no output".into()));
            }
            let pred = std::slice::from_raw_parts(data as *const f32, n);
            let (mut lo, mut hi) = (f32::MAX, f32::MIN);
            for &v in pred {
                lo = lo.min(v);
                hi = hi.max(v);
            }
            let range = (hi - lo).max(1e-6);
            if self.prev.len() != n {
                self.prev = vec![0.0; n];
                for i in 0..n {
                    self.prev[i] = (pred[i] - lo) / range;
                }
            } else {
                for i in 0..n {
                    self.prev[i] = 0.35 * self.prev[i] + 0.65 * ((pred[i] - lo) / range);
                }
            }
            rel_v(outv);
        }
        for i in 0..n {
            // push the edge: soft matte values become a cleaner cut
            let v = ((self.prev[i] - 0.5) * 1.6 + 0.5).clamp(0.0, 1.0);
            out[i] = (v * 255.0) as u8;
        }
        Ok(())
    }
}

impl Drop for Matter {
    fn drop(&mut self) {
        unsafe {
            if !self.mem.is_null() {
                let r: extern "C" fn(*mut c_void) = self.f(RELEASE_MEMORY_INFO);
                r(self.mem);
            }
            if !self.session.is_null() {
                let r: extern "C" fn(*mut c_void) = self.f(RELEASE_SESSION);
                r(self.session);
            }
            if !self.env.is_null() {
                let r: extern "C" fn(*mut c_void) = self.f(RELEASE_ENV);
                r(self.env);
            }
        }
    }
}
