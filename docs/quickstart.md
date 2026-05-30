# Quickstart

Get the desktop app running in development against a `retold-remote` server.

## Prerequisites

- **Node.js 20+** and npm
- **Rust** (stable) and Cargo -- install via [rustup](https://rustup.rs/)
- **Tauri platform dependencies** -- see the [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/) for your OS
- **mpv** (optional) -- for native video playback (`brew install mpv` on macOS)
- A built [`retold-remote`](https://fable-retold.github.io/retold-remote/) checkout as a sibling directory (so its web assets can be synced into `web-app/`)

## 1. Clone the Repository

```bash
git clone https://github.com/fable-retold/retold-remote-desktop
cd retold-remote-desktop
```

## 2. Install Dependencies

```bash
npm install
```

This installs the Tauri CLI and the `@tauri-apps/*` JavaScript plugins. The first `tauri dev` or `tauri build` will additionally compile the Rust crate in `src-tauri/`, which can take a few minutes the first time.

## 3. Sync the Web App

The repository checks in a `web-app/` shell (`index.html`, `retold-native-bridge.js`, `retold-native-bridge.css`), but the actual `retold-remote` browser bundle is copied in from a sibling checkout:

```bash
npm run copy-web-app
```

This runs `scripts/copy-web-app.sh`, which expects a built `retold-remote` at `../retold-remote/web-application/`. If you don't have one yet:

```bash
cd ../retold-remote
npm install
npm run build
cd ../retold-remote-desktop
npm run copy-web-app
```

> The script copies only `retold-remote`'s generated assets (JS bundles, `js/`, `css/`, `docs/`). It does **not** overwrite `index.html`, `retold-native-bridge.js`, or `retold-native-bridge.css`.

## 4. Run in Development

```bash
npm run dev
```

`tauri dev` compiles the Rust shell and opens a native window loading `web-app/` with live reload. (The `dev` script passes a transparent-window override so the embedded video layer can show through.)

## 5. Connect to a Server

On first launch the native bridge shows a **connection screen**. Enter the URL of a running `retold-remote` server, for example:

```
http://nas.local:7500
```

The bridge verifies the server by fetching `/api/media/capabilities`, saves it to a recent-servers list, and loads the browser. From then on it remembers the last server and reconnects automatically.

### Or: open a local folder

Click **Open Local Folder** on the connection screen (or **File -> Open Local Folder...**). The app spawns a local `retold-remote` server pointed at the folder you pick (on a random port in the 7000-7999 range) and connects to it. This requires `retold-remote` to be available on your `PATH` (or installed such that `node` can resolve it).

## 6. Verify Native Playback

Open a video, then press **n** or click **Play with Native Player**. On macOS the video renders through embedded libmpv behind the WebView; elsewhere it opens in an external `mpv` window. Transport controls (space, arrows, `f`, `[` / `]`, `q`) are handled by the bridge. If mpv is not installed, playback falls back to the in-browser player.

## Next Steps

- Read the [Architecture](#/page/architecture.md) page to understand how the web app, bridge, and Rust shell fit together.
- When you are ready to ship, see [Desktop Build & Package](#/page/desktop-build-and-package.md).
