use std::sync::Mutex;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

/// Tracks the state of an embedded retold-remote server process.
pub struct ServerState
{
	pub running: bool,
	pub port: u16,
	pub content_path: String,
	/// PID of the child process (so we can kill it later).
	pub child_pid: Option<u32>,
}

impl Default for ServerState
{
	fn default() -> Self
	{
		ServerState {
			running: false,
			port: 0,
			content_path: String::new(),
			child_pid: None,
		}
	}
}

/// Pick a random port in the 7000-7999 range (same as retold-remote CLI).
fn random_port() -> u16
{
	use rand::Rng;
	let mut rng = rand::thread_rng();
	rng.gen_range(7000..8000)
}

/// Start the embedded retold-remote server as a child process.
///
/// Spawns `retold-remote serve <content_path> -p <port> --no-hash` and
/// returns the port number once the process is launched.
#[tauri::command]
pub async fn start_server(
	app: AppHandle,
	state: tauri::State<'_, Mutex<ServerState>>,
	content_path: String,
) -> Result<serde_json::Value, String>
{
	// If a server is already running, stop it first
	{
		let mut server = state.lock().map_err(|e| e.to_string())?;
		if server.running
		{
			// We'll let the old process die by dropping the reference;
			// the OS will clean it up when the new one starts.
			server.running = false;
			server.child_pid = None;
		}
	}

	let port = random_port();

	let shell = app.shell();
	let output = shell
		.command("retold-remote")
		.args([
			"serve",
			&content_path,
			"-p",
			&port.to_string(),
			"--no-hash",
		])
		.spawn();

	match output
	{
		Ok((_rx, child)) =>
		{
			let pid = child.pid();
			let mut server = state.lock().map_err(|e| e.to_string())?;
			server.running = true;
			server.port = port;
			server.content_path = content_path;
			server.child_pid = Some(pid);

			Ok(serde_json::json!({
				"port": port,
				"contentPath": server.content_path,
			}))
		}
		Err(e) =>
		{
			// Try falling back to `node` with the retold-remote module
			let node_output = shell
				.command("node")
				.args([
					"-e",
					&format!(
						"require('retold-remote/source/cli/RetoldRemote-CLI-Run.js'); \
						 process.argv = ['node', 'retold-remote', 'serve', '{}', '-p', '{}', '--no-hash'];",
						content_path.replace('\\', "\\\\").replace('\'', "\\'"),
						port
					),
				])
				.spawn();

			match node_output
			{
				Ok((_rx, child)) =>
				{
					let pid = child.pid();
					let mut server = state.lock().map_err(|e| e.to_string())?;
					server.running = true;
					server.port = port;
					server.content_path = content_path;
					server.child_pid = Some(pid);

					Ok(serde_json::json!({
						"port": port,
						"contentPath": server.content_path,
					}))
				}
				Err(_) =>
				{
					Err(format!(
						"Could not start retold-remote server. \
						 Make sure retold-remote is installed (npm install -g retold-remote). \
						 Original error: {}",
						e
					))
				}
			}
		}
	}
}

/// Stop the embedded retold-remote server.
#[tauri::command]
pub async fn stop_server(
	state: tauri::State<'_, Mutex<ServerState>>,
) -> Result<(), String>
{
	let mut server = state.lock().map_err(|e| e.to_string())?;

	if server.running
	{
		// Kill the child process if we have a PID
		if let Some(pid) = server.child_pid
		{
			let _ = std::process::Command::new("kill")
				.arg(pid.to_string())
				.output();
		}

		server.running = false;
		server.port = 0;
		server.content_path.clear();
		server.child_pid = None;
	}

	Ok(())
}

/// Get the current server status.
#[tauri::command]
pub fn get_server_status(
	state: tauri::State<'_, Mutex<ServerState>>,
) -> Result<serde_json::Value, String>
{
	let server = state.lock().map_err(|e| e.to_string())?;

	Ok(serde_json::json!({
		"running": server.running,
		"port": server.port,
		"contentPath": server.content_path,
	}))
}
