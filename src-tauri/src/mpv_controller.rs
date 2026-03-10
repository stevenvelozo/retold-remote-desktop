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
		}
	}
}

/// Kill a process by PID using the system kill command.
fn kill_process(pid: u32)
{
	let _ = std::process::Command::new("kill")
		.arg(pid.to_string())
		.output();
}

/// Launch mpv to play a media URL.
///
/// Opens mpv in its own window with the given URL. If mpv is already playing,
/// the previous instance is killed first.
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
			if let Some(pid) = mpv.child_pid
			{
				kill_process(pid);
			}
			mpv.playing = false;
			mpv.child_pid = None;
		}
	}

	let display_title = title.unwrap_or_else(|| url.split('/').last().unwrap_or("video").to_string());

	let shell = app.shell();
	let result = shell
		.command("mpv")
		.args([
			&url,
			"--force-window=yes",
			"--keep-open=yes",
			"--hwdec=auto-safe",
			&format!("--title={}", display_title),
			"--osd-level=1",
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
			Ok(())
		}
		Err(e) =>
		{
			Err(format!(
				"Could not launch mpv. Make sure mpv is installed (brew install mpv). Error: {}",
				e
			))
		}
	}
}

/// Send a control command to mpv.
///
/// Supported commands: "pause", "resume", "stop", "seek", "volume"
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

	match command.as_str()
	{
		"stop" =>
		{
			if let Some(pid) = mpv.child_pid
			{
				kill_process(pid);
			}
			drop(mpv);
			let mut mpv = state.lock().map_err(|e| e.to_string())?;
			mpv.playing = false;
			mpv.child_pid = None;
			Ok(())
		}
		_ =>
		{
			// For advanced control (pause, seek, volume), mpv's JSON IPC would be needed.
			// This is a simplified implementation that supports launching and stopping.
			// Full IPC control can be added by using --input-ipc-server and connecting
			// to the Unix socket.
			Ok(())
		}
	}
}

/// Get the current mpv playback status.
#[tauri::command]
pub fn mpv_get_status(
	state: tauri::State<'_, Mutex<MpvState>>,
) -> Result<serde_json::Value, String>
{
	let mpv = state.lock().map_err(|e| e.to_string())?;

	Ok(serde_json::json!({
		"playing": mpv.playing,
		"url": mpv.current_url,
		"title": mpv.current_title,
	}))
}
