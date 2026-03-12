mod server_manager;
mod mpv_controller;

use std::sync::Mutex;
use std::collections::HashMap;
use tauri::{
	menu::{MenuItem, MenuBuilder, SubmenuBuilder},
	tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
	Manager,
};

/// HTTP proxy command — bypasses CORS by making requests from Rust.
/// The webview can't make cross-origin requests to the retold-remote server
/// because it doesn't send CORS headers. This command proxies those requests.
#[tauri::command]
async fn proxy_fetch(
	url: String,
	method: Option<String>,
	body: Option<String>,
	headers: Option<HashMap<String, String>>,
) -> Result<serde_json::Value, String>
{
	let client = reqwest::Client::new();
	let http_method = match method.as_deref().unwrap_or("GET")
	{
		"POST" => reqwest::Method::POST,
		"PUT" => reqwest::Method::PUT,
		"DELETE" => reqwest::Method::DELETE,
		"PATCH" => reqwest::Method::PATCH,
		"HEAD" => reqwest::Method::HEAD,
		"OPTIONS" => reqwest::Method::OPTIONS,
		_ => reqwest::Method::GET,
	};

	let mut request = client.request(http_method, &url);

	if let Some(hdrs) = headers
	{
		for (key, value) in hdrs
		{
			request = request.header(&key, &value);
		}
	}

	if let Some(body_str) = body
	{
		request = request.body(body_str);
	}

	let response = request.send().await.map_err(|e| e.to_string())?;
	let status = response.status().as_u16();
	let response_headers: HashMap<String, String> = response.headers()
		.iter()
		.map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
		.collect();
	let response_body = response.text().await.map_err(|e| e.to_string())?;

	Ok(serde_json::json!({
		"status": status,
		"headers": response_headers,
		"body": response_body
	}))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run()
{
	let builder = tauri::Builder::default()
		// ---- Plugins ----
		.plugin(tauri_plugin_window_state::Builder::default().build())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_shell::init())
		.plugin(tauri_plugin_store::Builder::default().build());

	// libmpv plugin is macOS-only (renders video behind transparent webview).
	// On Windows, initializing it interferes with WebView2 input handling.
	#[cfg(target_os = "macos")]
	let builder = builder.plugin(tauri_plugin_libmpv::init());

	builder
		// ---- Managed state ----
		.manage(Mutex::new(server_manager::ServerState::default()))
		.manage(Mutex::new(mpv_controller::MpvState::default()))
		// ---- IPC command handlers ----
		.invoke_handler(tauri::generate_handler![
			proxy_fetch,
			server_manager::start_server,
			server_manager::stop_server,
			server_manager::get_server_status,
			mpv_controller::mpv_play,
			mpv_controller::mpv_control,
			mpv_controller::mpv_get_status,
		])
		// ---- App setup ----
		.setup(|app| {
			// Build system tray
			let quit_item = MenuItem::with_id(app, "quit", "Quit Retold Remote", true, None::<&str>)?;
			let show_item = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;

			let tray_menu = MenuBuilder::new(app)
				.items(&[&show_item, &quit_item])
				.build()?;

			let _tray = TrayIconBuilder::with_id("retold-tray")
				.tooltip("Retold Remote")
				.menu(&tray_menu)
				.on_menu_event(move |app, event| {
					match event.id().as_ref()
					{
						"quit" => app.exit(0),
						"show" =>
						{
							if let Some(window) = app.get_webview_window("main")
							{
								let _ = window.show();
								let _ = window.set_focus();
							}
						}
						_ => {}
					}
				})
				.on_tray_icon_event(|tray, event| {
					if let TrayIconEvent::Click {
						button: MouseButton::Left,
						button_state: MouseButtonState::Up,
						..
					} = event
					{
						let app = tray.app_handle();
						if let Some(window) = app.get_webview_window("main")
						{
							let _ = window.show();
							let _ = window.set_focus();
						}
					}
				})
				.build(app)?;

			// Build application menu
			let file_menu = SubmenuBuilder::new(app, "File")
				.item(&MenuItem::with_id(app, "open-folder", "Open Local Folder...", true, Some("CmdOrCtrl+O"))?)
				.item(&MenuItem::with_id(app, "connect-server", "Connect to Server...", true, Some("CmdOrCtrl+K"))?)
				.separator()
				.item(&MenuItem::with_id(app, "disconnect", "Disconnect", true, None::<&str>)?)
				.separator()
				.close_window()
				.build()?;

			let view_menu = SubmenuBuilder::new(app, "View")
				.fullscreen()
				.separator()
				.item(&MenuItem::with_id(app, "dev-tools", "Developer Tools", true, Some("CmdOrCtrl+Shift+I"))?)
				.build()?;

			let playback_menu = SubmenuBuilder::new(app, "Playback")
				.item(&MenuItem::with_id(app, "play-native", "Play with mpv", true, Some("CmdOrCtrl+M"))?)
				.build()?;

			let menu = MenuBuilder::new(app)
				.item(&file_menu)
				.item(&view_menu)
				.item(&playback_menu)
				.build()?;

			app.set_menu(menu)?;

			app.on_menu_event(move |app, event| {
				match event.id().as_ref()
				{
					"open-folder" =>
					{
						if let Some(window) = app.get_webview_window("main")
						{
							let _ = window.eval("window.__retoldBridge_openLocalFolder && window.__retoldBridge_openLocalFolder()");
						}
					}
					"connect-server" =>
					{
						if let Some(window) = app.get_webview_window("main")
						{
							let _ = window.eval("window.__retoldBridge_disconnect && window.__retoldBridge_disconnect()");
						}
					}
					"disconnect" =>
					{
						if let Some(window) = app.get_webview_window("main")
						{
							let _ = window.eval("window.__retoldBridge_disconnect && window.__retoldBridge_disconnect()");
						}
					}
					"play-native" =>
					{
						if let Some(window) = app.get_webview_window("main")
						{
							let _ = window.eval("window.__retoldBridge_playNativeVideo && window.__retoldBridge_playNativeVideo()");
						}
					}
					"dev-tools" =>
					{
						if let Some(window) = app.get_webview_window("main")
						{
							window.open_devtools();
						}
					}
					_ => {}
				}
			});

			Ok(())
		})
		.run(tauri::generate_context!())
		.expect("error while running retold-remote-desktop");
}
