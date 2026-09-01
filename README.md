# Resonate

Terminal YouTube Music player. Synced lyrics, visualizers, album art.

![We Don't Talk Anymore playing in Resonate](assets/screenshot.svg)

## Install

Linux and macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/aman-senpai/resonate/master/install.sh | bash
```

The script installs `resonate`, `yt-dlp`, and an audio engine (`ffplay` / `mpv` / `ffmpeg`). If `~/.local/bin` is new on your PATH, open a new terminal.

```bash
resonate
resonate play "We Don't Talk Anymore"
```

## Commands

| | |
| :--- | :--- |
| `resonate` | Open the player |
| `resonate play <query\|url>` | Search and play |
| `resonate search [query]` | Search |
| `resonate library` | Liked songs |
| `resonate charts` | Trending |
| `resonate playlist list` | Playlists |
| `resonate auth login --browser chrome` | Sign in |
| `resonate themes` | List themes |

## Keys

| | |
| :--- | :--- |
| <kbd>Space</kbd> | Play / pause |
| <kbd>←</kbd> <kbd>→</kbd> | Seek 5s · <kbd>Shift</kbd> 15s |
| <kbd>↑</kbd> <kbd>↓</kbd> | Volume |
| <kbd>N</kbd> <kbd>B</kbd> | Next / previous |
| <kbd>/</kbd> | Search |
| <kbd>Q</kbd> | Queue |
| <kbd>V</kbd> | Visualizer |
| <kbd>T</kbd> | Theme |
| <kbd>?</kbd> | Help |

## License

[MIT](LICENSE)
