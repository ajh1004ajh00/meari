// 메아리 desktop shell: a small native window + tray around the local web app (http://localhost:8020).
// The app server and the transcription engine still run in WSL; this only starts them and hosts the UI.
//   meari.exe          open (start the server in WSL if it is down)
//   meari.exe --rec    open and start recording right away (desktop hotkey Ctrl+Alt+M)
// A second launch never opens a second window: it focuses this one (and starts recording with --rec).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpStream;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const PORT_ADDR: &str = "127.0.0.1:8020";
const APP_URL: &str = "http://localhost:8020/";
const DEFAULT_DISTRO: &str = "Ubuntu-24.04"; // override with MEARI_WSL_DISTRO
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Runs inside the page. On the web app it calls the page's own functions, so its guards and dialogs apply.
const REC_JS: &str = "if (window.meariQuickRecord) meariQuickRecord(); \
    else if (location.port === '8020') location.assign('/?rec=1'); else window.__rec = 1;";
const ENGINE_OFF_JS: &str = "if (location.port === '8020') { \
    if (rec) toast('녹음 중에는 엔진을 끌 수 없어요', true); \
    else api('/engine/stop', { method: 'POST' }).then(() => { toast('엔진을 껐어요. GPU 메모리를 비웠어요'); checkEngine(); }).catch(fail); }";
const OFF_JS: &str = "if (location.port === '8020') document.getElementById('shutdownBtn').click(); \
    else location.href = 'http://localhost:8020/__meari_quit';";
// The page asks the app to exit by navigating here; on_navigation catches it (no IPC needed for the remote page).
const QUIT_PATH: &str = "/__meari_quit";

fn args_want_rec(argv: &[String]) -> bool {
    argv.iter().any(|a| a.eq_ignore_ascii_case("--rec") || a.eq_ignore_ascii_case("/rec"))
}

fn server_up() -> bool {
    TcpStream::connect_timeout(&PORT_ADDR.parse().unwrap(), Duration::from_millis(400)).is_ok()
}

// The project folder that holds scripts/run.sh: MEARI_DIR, else the exe's folder or one of its parents
// (Meari.exe copied to the repo root, or run from desktop/target/release).
fn project_dir() -> Option<String> {
    if let Ok(d) = std::env::var("MEARI_DIR") {
        return Some(d);
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors()
        .skip(1)
        .take(5)
        .find(|d| d.join("scripts").join("run.sh").exists())
        .map(|d| d.to_string_lossy().into_owned())
}

fn start_server(dir: &str) {
    let distro = std::env::var("MEARI_WSL_DISTRO").unwrap_or_else(|_| DEFAULT_DISTRO.to_string());
    let _ = Command::new("wsl.exe")
        .args(["-d", distro.as_str(), "-u", "root", "--cd", dir, "--", "bash", "-c",
               "bash scripts/run.sh >> data/run.log 2>&1"])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        set_background(&w, false);
    }
}

// Out of sight (tray or minimized): stop the page's canvas animations and ask WebView2 to trim memory.
// A recording keeps going; only drawing stops. Undone as soon as the window is shown again.
fn set_background(w: &tauri::WebviewWindow, bg: bool) {
    let _ = w.eval(&format!("window.meariSetHidden && meariSetHidden({bg});"));
    let _ = w.with_webview(move |wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use windows_core::Interface;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        if let Ok(c19) = core.cast::<ICoreWebView2_19>() {
            let _ = c19.SetMemoryUsageTargetLevel(if bg {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            });
        }
    });
}

fn eval(app: &AppHandle, js: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(js);
    }
}

// Small always-on-top window in the bottom-right corner; the web app switches to its phone layout.
fn set_mini(app: &AppHandle, on: bool) {
    let Some(w) = app.get_webview_window("main") else { return };
    show(app);
    let _ = w.set_always_on_top(on);
    if on {
        let _ = w.set_size(LogicalSize::new(400.0, 720.0));
        if let (Ok(Some(m)), Ok(size)) = (w.current_monitor(), w.outer_size()) {
            let (mp, ms) = (m.position(), m.size());
            let pad = (24.0 * m.scale_factor()) as i32;
            let taskbar = (56.0 * m.scale_factor()) as i32;
            let _ = w.set_position(PhysicalPosition::new(
                mp.x + ms.width as i32 - size.width as i32 - pad,
                mp.y + ms.height as i32 - size.height as i32 - taskbar,
            ));
        }
    } else {
        let _ = w.set_size(LogicalSize::new(1280.0, 860.0));
        let _ = w.center();
    }
}

fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "메아리 열기", true, None::<&str>)?;
    let rec = MenuItem::with_id(app, "rec", "바로 녹음   Ctrl+Alt+M", true, None::<&str>)?;
    let mini = CheckMenuItem::with_id(app, "mini", "작은 창 · 항상 위", true, false, None::<&str>)?;
    let engine = MenuItem::with_id(app, "engine", "엔진 끄기 (GPU 비우기)", true, None::<&str>)?;
    let off = MenuItem::with_id(app, "off", "모두 끄기", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &rec, &mini, &sep, &engine, &off])?;
    let mini_item = mini.clone();
    TrayIconBuilder::with_id("meari")
        .icon(app.default_window_icon().cloned().expect("icon"))
        .tooltip("메아리")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, e| match e.id.as_ref() {
            "open" => show(app),
            "rec" => { show(app); eval(app, REC_JS) }
            "mini" => set_mini(app, mini_item.is_checked().unwrap_or(false)),
            "engine" => { show(app); eval(app, ENGINE_OFF_JS) }
            "off" => { show(app); eval(app, OFF_JS) }
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// Grant the microphone to the local web app only, so WebView2 does not ask on every recording.
fn allow_local_mic(w: &tauri::WebviewWindow) {
    let _ = w.with_webview(|wv| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::PermissionRequestedEventHandler;
        let Ok(core) = wv.controller().CoreWebView2() else { return };
        let mut token = 0i64;
        let _ = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                let mut uri = windows_core::PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = webview2_com::take_pwstr(uri);
                let local = uri.starts_with("http://localhost:8020/") || uri.starts_with("http://127.0.0.1:8020/");
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE && local {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            })),
            &mut token,
        );
    });
}

fn main() {
    let rec = args_want_rec(&std::env::args().collect::<Vec<_>>());
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            show(app);
            if args_want_rec(&argv) {
                eval(app, REC_JS);
            }
        }))
        .setup(move |app| {
            let up = server_up();
            if !up {
                if let Some(dir) = project_dir() {
                    start_server(&dir);
                } // else the boot page times out and shows where to look
            }
            let url = if up {
                WebviewUrl::External(format!("{APP_URL}{}", if rec { "?rec=1" } else { "" }).parse().unwrap())
            } else {
                WebviewUrl::App("index.html".into()) // boot page: polls the server, then jumps into the app
            };
            WebviewWindowBuilder::new(app, "main", url)
                .title("메아리")
                .inner_size(1280.0, 860.0)
                .min_inner_size(360.0, 560.0)
                .center()
                // wry's defaults plus autoplay, so a recording started by the hotkey needs no extra click
                .additional_browser_args(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required",
                )
                .initialization_script(if rec { "window.meariDesktop = true; window.__rec = 1;" } else { "window.meariDesktop = true;" })
                .on_navigation({
                    let handle = app.handle().clone();
                    move |url| {
                        if url.path() != QUIT_PATH {
                            return true;
                        }
                        let h = handle.clone();
                        std::thread::spawn(move || h.exit(0));
                        false
                    }
                })
                .build()?;
            allow_local_mic(&app.get_webview_window("main").unwrap());
            build_tray(app)?;
            Ok(())
        })
        // closing the window keeps 메아리 in the tray (a recording keeps going); quit from the tray menu
        .on_window_event(|win, ev| {
            let Some(w) = win.app_handle().get_webview_window(win.label()) else { return };
            match ev {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = win.hide();
                    set_background(&w, true);
                }
                // minimize / restore (restore from the taskbar does not go through show())
                WindowEvent::Resized(_) => set_background(&w, win.is_minimized().unwrap_or(false)),
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("meari failed to start");
}
