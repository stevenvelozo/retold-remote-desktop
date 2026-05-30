# retold-remote-desktop

> A native desktop application for the Retold Remote media browser.

A [Tauri 2.0](https://v2.tauri.app/) application that wraps the `retold-remote` web media browser in a native shell for macOS, Windows, and Linux -- connecting to a `retold-remote` server, or serving a local folder, with native playback and a CORS-free proxy.

- **Native Tauri shell** -- macOS, Windows, and Linux
- **Wraps the web app** -- the `retold-remote` browser bundle, unmodified
- **CORS-free networking** -- API and content requests proxied through Rust
- **Native video** -- embedded libmpv on macOS, external mpv elsewhere

[Get Started](#/page/quickstart.md)
[Architecture](#/page/architecture.md)
[Build & Ship](#/page/desktop-build-and-package.md)
[GitHub](https://github.com/fable-retold/retold-remote-desktop)
