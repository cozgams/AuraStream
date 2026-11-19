# Playback Diagnostic Logging

Settings → Playback Diagnostics → **Playback Diagnostic Logging**. Disabled by default, persists locally, and is available in release builds.

## Reproduction and Log Collection

1. Enable logging in Settings. If troubleshooting startup background playback, restart the app after enabling.
2. Reproduce the scenario: play a video in the feed, switch pages, tap the progress bar, or drag the seek handle. Wait for playback to resume (wait at least 10 seconds if stalled).
3. Return to Settings, disable logging, and tap **Copy Playback Diagnostic Log**. Existing logs are retained after disabling.

Log files are stored locally:
- `playback.log`: Current diagnostic journal (JSON Lines format).
- `playback.previous.log`: Previous rotated journal (if present).
- `playback-diagnostics.json`: Toggle configuration file.

The copy button exports both current and previous logs (up to 2 MiB each, ~4 MiB total with automatic rotation). Logs are stored strictly on-device; media URLs are replaced with consistent resource identifiers without logging direct stream URLs, query tokens, keys, account credentials, or response bodies.

## Event Specifications

Each line contains UTC `ts`, process `pid`, sequential `seq`, active `strict` mode, `event`, and `data`:

| Event | Description |
| --- | --- |
| `web.seek.input.down/change/up/cancel` | User input: click, drag, or keyboard seeking |
| `web.seek.request` | Seek dispatched with sequential seek identifier and target time |
| `web.seek.assigned` / `web.seek.rejected` | Applied `currentTime` assignment or failure |
| `web.media.seeking` / `web.media.seeked` | Media element seek lifecycle and elapsed duration |
| `web.seek.resumed` | First frame rendered after seek during playback |
| `web.seek.ready` | Seek completed while paused; player remains paused |
| `web.seek.superseded` | Prior seek superseded by a newer input gesture |
| `web.seek.noop` | Target matches current time; no waiting required |
| `web.seek.timeout` | Timeout after 8s with buffer state and readyState |

## Local Verification

Use test suite fixture at `http://127.0.0.1:1420/tests/player-seek.html?diagnostics=1` to verify seek state machines and diagnostic logging in memory.
