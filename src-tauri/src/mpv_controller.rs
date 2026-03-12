use std::io::{BufRead, BufReader, Write};
use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

/// Tracks the state of an external mpv player process.
pub struct MpvState
{
	pub playing: bool,
	pub current_url: String,
	pub current_title: String,
	/// PID of the mpv child process.
	pub child_pid: Option<u32>,
	/// Path to the mpv IPC Unix socket.
	pub socket_path: String,
}

impl Default for MpvState
{
	fn default() -> Self
	{
		MpvState {
			playing: false,
			current_url: String::new(),
			current_title: String::new(),
			child_pid: None,
			socket_path: String::new(),
		}
	}
}

/// Kill a process by PID.
#[cfg(unix)]
fn kill_process(pid: u32)
{
	let _ = std::process::Command::new("kill")
		.arg(pid.to_string())
		.output();
}

#[cfg(windows)]
fn kill_process(pid: u32)
{
	let _ = std::process::Command::new("taskkill")
		.args(["/PID", &pid.to_string(), "/F"])
		.output();
}

/// Remove a socket file if it exists (Unix only; named pipes clean up automatically on Windows).
fn remove_socket_file(path: &str)
{
	#[cfg(unix)]
	{
		let _ = std::fs::remove_file(path);
	}
	#[cfg(windows)]
	{
		let _ = path;
	}
}

/// Send a JSON command to mpv via its IPC socket and return the response.
///
/// mpv's JSON IPC protocol sends newline-terminated JSON objects.
/// Each command is `{ "command": [...] }\n` and mpv replies with
/// `{ "error": "success", "data": ... }\n`.
///
/// On Unix this connects via a Unix domain socket; on Windows via a named pipe.
fn send_mpv_ipc(socket_path: &str, command: &serde_json::Value) -> Result<serde_json::Value, String>
{
	use std::time::Duration;

	// Platform-specific connection
	#[cfg(unix)]
	let stream = {
		use std::os::unix::net::UnixStream;
		let timeout = Duration::from_secs(2);
		let s = UnixStream::connect(socket_path)
			.or_else(|_| {
				std::thread::sleep(Duration::from_millis(200));
				UnixStream::connect(socket_path)
			})
			.map_err(|e| format!("Failed to connect to mpv socket: {}", e))?;
		s.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
		s.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;
		s
	};

	#[cfg(windows)]
	let stream = {
		std::fs::OpenOptions::new()
			.read(true)
			.write(true)
			.open(socket_path)
			.or_else(|_| {
				std::thread::sleep(Duration::from_millis(200));
				std::fs::OpenOptions::new()
					.read(true)
					.write(true)
					.open(socket_path)
			})
			.map_err(|e| format!("Failed to connect to mpv pipe: {}", e))?
	};

	let mut writer = stream.try_clone().map_err(|e| e.to_string())?;

	// Write the command as JSON + newline
	let mut cmd_str = serde_json::to_string(command).map_err(|e| e.to_string())?;
	cmd_str.push('\n');
	writer.write_all(cmd_str.as_bytes()).map_err(|e| format!("Failed to write to mpv socket: {}", e))?;
	writer.flush().map_err(|e| e.to_string())?;

	// Read the response line
	let reader = BufReader::new(stream);
	for line in reader.lines()
	{
		let line = line.map_err(|e| format!("Failed to read from mpv socket: {}", e))?;
		if line.is_empty()
		{
			continue;
		}
		// mpv may send event lines; we want the one with "error" field (the command response)
		if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line)
		{
			if parsed.get("error").is_some()
			{
				return Ok(parsed);
			}
			// If it's an event, keep reading
			if parsed.get("event").is_some()
			{
				continue;
			}
			// Return whatever we got
			return Ok(parsed);
		}
	}

	Err("No response from mpv".to_string())
}

/// Get a property value from mpv via IPC.
fn get_mpv_property(socket_path: &str, property: &str) -> Result<serde_json::Value, String>
{
	let cmd = serde_json::json!({ "command": ["get_property", property] });
	let response = send_mpv_ipc(socket_path, &cmd)?;

	if response.get("error").and_then(|e| e.as_str()) == Some("success")
	{
		Ok(response.get("data").cloned().unwrap_or(serde_json::Value::Null))
	}
	else
	{
		let err_msg = response.get("error")
			.and_then(|e| e.as_str())
			.unwrap_or("unknown error");
		Err(format!("mpv property error: {}", err_msg))
	}
}

/// Launch mpv to play a media URL.
///
/// Opens mpv in its own window with the given URL. If mpv is already playing,
/// the previous instance is killed first. Launches with `--input-ipc-server`
/// for JSON IPC control.
#[tauri::command]
pub async fn mpv_play(
	app: AppHandle,
	state: tauri::State<'_, Mutex<MpvState>>,
	url: String,
	title: Option<String>,
) -> Result<(), String>
{
	// Kill any existing mpv process
	{
		let mut mpv = state.lock().map_err(|e| e.to_string())?;
		if mpv.playing
		{
			// Try graceful quit via IPC first
			if !mpv.socket_path.is_empty()
			{
				let _ = send_mpv_ipc(&mpv.socket_path, &serde_json::json!({ "command": ["quit"] }));
				std::thread::sleep(std::time::Duration::from_millis(100));
			}
			if let Some(pid) = mpv.child_pid
			{
				kill_process(pid);
			}
			if !mpv.socket_path.is_empty()
			{
				remove_socket_file(&mpv.socket_path);
			}
			mpv.playing = false;
			mpv.child_pid = None;
			mpv.socket_path.clear();
		}
	}

	// Generate unique IPC path (Unix socket on Unix, named pipe on Windows)
	#[cfg(unix)]
	let socket_path = format!("/tmp/retold-mpv-{}.sock", rand::random::<u32>());
	#[cfg(windows)]
	let socket_path = format!(r"\\.\pipe\retold-mpv-{}", rand::random::<u32>());
	// Clean up any stale socket
	remove_socket_file(&socket_path);

	let display_title = title.unwrap_or_else(|| url.split('/').last().unwrap_or("video").to_string());

	let shell = app.shell();
	let ipc_arg = format!("--input-ipc-server={}", socket_path);
	let title_arg = format!("--title={}", display_title);
	let result = shell
		.command("mpv")
		.args([
			&url,
			"--force-window=yes",
			"--keep-open=yes",
			"--hwdec=auto-safe",
			&title_arg,
			"--osd-level=1",
			&ipc_arg,
		])
		.spawn();

	match result
	{
		Ok((_rx, child)) =>
		{
			let pid = child.pid();
			let mut mpv = state.lock().map_err(|e| e.to_string())?;
			mpv.playing = true;
			mpv.current_url = url;
			mpv.current_title = display_title;
			mpv.child_pid = Some(pid);
			mpv.socket_path = socket_path;
			Ok(())
		}
		Err(e) =>
		{
			remove_socket_file(&socket_path);
			Err(format!(
				"Could not launch mpv. Make sure mpv is installed (brew install mpv). Error: {}",
				e
			))
		}
	}
}

/// Send a control command to mpv via JSON IPC.
///
/// Supported commands:
/// - "toggle-pause" — Pause/resume playback
/// - "seek-forward" — Seek forward 5 seconds
/// - "seek-backward" — Seek backward 5 seconds
/// - "seek-forward-large" — Seek forward 30 seconds
/// - "seek-backward-large" — Seek backward 30 seconds
/// - "volume-up" — Increase volume by 5
/// - "volume-down" — Decrease volume by 5
/// - "toggle-mute" — Toggle mute
/// - "toggle-fullscreen" — Toggle fullscreen
/// - "speed-up" — Increase playback speed by 10%
/// - "speed-down" — Decrease playback speed by 10%
/// - "speed-reset" — Reset playback speed to 1.0
/// - "stop" — Quit mpv
#[tauri::command]
pub async fn mpv_control(
	state: tauri::State<'_, Mutex<MpvState>>,
	command: String,
	_args: Option<Vec<String>>,
) -> Result<(), String>
{
	let mpv = state.lock().map_err(|e| e.to_string())?;

	if !mpv.playing
	{
		return Err("mpv is not playing".to_string());
	}

	let socket_path = mpv.socket_path.clone();
	if socket_path.is_empty()
	{
		return Err("mpv IPC socket not available".to_string());
	}

	match command.as_str()
	{
		"toggle-pause" =>
		{
			let cmd = serde_json::json!({ "command": ["cycle", "pause"] });
			drop(mpv);
			send_mpv_ipc(&socket_path, &cmd)?;
			Ok(())
		}
		"seek-forward" =>
		{
			let cmd = serde_json::json!({ "command": ["seek", 5] });
			drop(mpv);
			send_mpv_ipc(&socket_path, &cmd)?;
			Ok(())
		}
		"seek-backward" =>
		{
			let cmd = serde_json::json!({ "command": ["seek", -5] });
			drop(mpv);
			send_mpv_ipc(&socket_path, &cmd)?;
			Ok(())
		}
		"seek-forward-large" =>
		{
			let cmd = serde_json::json!({ "command": ["seek", 30] });
			drop(mpv);
			send_mpv_ipc(&socket_path, &cmd)?;
			Ok(())
		}
		"seek-backward-large" =>
		{
			let cmd = serde_json::json!({ "command": ["seek", -30] });
			drop(mpv);
			send_mpv_ipc(&socket_path, &cmd)?;
			Ok(())
		}
		"volume-up" =>
		{
			let cmd = serde_json::json!({ "command": ["add", "volume", 5] });
			drop(mpv);
			send_mpv_ipc(&socket_path, &cmd)?;
			Ok(())
		}
		"volume-down" =>
		{
			let cmd = serde_json::json!({ "command": ["add", "volume", -5] });
			drop(mpv);
			send_mpv_ipc(&socket_path, &cmd)?;
			Ok(())
		}
		"toggle-mute" =>
		{
			let cmd = serde_json::json!({ "command": ["cycle", "mute"] });
			drop(mpv);
			send_mpv_ipc(&socket_path, &cmd)?;
			Ok(())
		}
		"toggle-fullscreen" =>
		{
			let cmd = serde_json::json!({ "command": ["cycle", "fullscreen"] });
			drop(mpv);
			send_mpv_ipc(&socket_path, &cmd)?;
			Ok(())
		}
		"speed-up" =>
		{
			let cmd = serde_json::json!({ "command": ["multiply", "speed", 1.1] });
			drop(mpv);
			send_mpv_ipc(&socket_path, &cmd)?;
			Ok(())
		}
		"speed-down" =>
		{
			let cmd = serde_json::json!({ "command": ["multiply", "speed", 0.9] });
			drop(mpv);
			send_mpv_ipc(&socket_path, &cmd)?;
			Ok(())
		}
		"speed-reset" =>
		{
			let cmd = serde_json::json!({ "command": ["set_property", "speed", 1.0] });
			drop(mpv);
			send_mpv_ipc(&socket_path, &cmd)?;
			Ok(())
		}
		"stop" =>
		{
			// Try graceful quit via IPC
			let quit_cmd = serde_json::json!({ "command": ["quit"] });
			let _ = send_mpv_ipc(&socket_path, &quit_cmd);

			// Fall back to kill if needed
			let pid = mpv.child_pid;
			drop(mpv);

			std::thread::sleep(std::time::Duration::from_millis(100));

			if let Some(pid) = pid
			{
				kill_process(pid);
			}
			remove_socket_file(&socket_path);

			let mut mpv = state.lock().map_err(|e| e.to_string())?;
			mpv.playing = false;
			mpv.child_pid = None;
			mpv.current_url.clear();
			mpv.current_title.clear();
			mpv.socket_path.clear();
			Ok(())
		}
		_ =>
		{
			Err(format!("Unknown mpv command: {}", command))
		}
	}
}

/// Get the current mpv playback status with live data from IPC.
///
/// Returns position, duration, pause state, volume, and speed
/// when the IPC socket is available. Falls back to stored state otherwise.
#[tauri::command]
pub fn mpv_get_status(
	state: tauri::State<'_, Mutex<MpvState>>,
) -> Result<serde_json::Value, String>
{
	let mpv = state.lock().map_err(|e| e.to_string())?;

	if !mpv.playing || mpv.socket_path.is_empty()
	{
		return Ok(serde_json::json!({
			"playing": mpv.playing,
			"url": mpv.current_url,
			"title": mpv.current_title,
		}));
	}

	let socket_path = mpv.socket_path.clone();
	let url = mpv.current_url.clone();
	let title = mpv.current_title.clone();
	drop(mpv);

	// Query live properties from mpv — each one may fail independently
	let time_pos = get_mpv_property(&socket_path, "time-pos")
		.unwrap_or(serde_json::Value::Null);
	let duration = get_mpv_property(&socket_path, "duration")
		.unwrap_or(serde_json::Value::Null);
	let paused = get_mpv_property(&socket_path, "pause")
		.unwrap_or(serde_json::Value::Null);
	let volume = get_mpv_property(&socket_path, "volume")
		.unwrap_or(serde_json::Value::Null);
	let speed = get_mpv_property(&socket_path, "speed")
		.unwrap_or(serde_json::Value::Null);

	// If we couldn't even get pause state, mpv may have exited
	let is_alive = !paused.is_null();

	if !is_alive
	{
		// mpv is probably gone — update state
		// (We can't update state here since we dropped the lock, but the frontend
		// will handle it by calling stop when it detects mpv is gone)
		return Ok(serde_json::json!({
			"playing": false,
			"url": url,
			"title": title,
		}));
	}

	Ok(serde_json::json!({
		"playing": true,
		"url": url,
		"title": title,
		"position": time_pos,
		"duration": duration,
		"paused": paused,
		"volume": volume,
		"speed": speed,
	}))
}
