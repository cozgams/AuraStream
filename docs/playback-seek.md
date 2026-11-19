# Desktop Progress Bar Click & Seek Behavior

Issue: Sequential playback and dragging seek worked as expected, but clicking directly on the progress bar while the control bar was idle/hidden could occasionally pause the video instead of seeking.

Cause: The hidden control bar state applied `pointer-events: none` to the entire controls wrapper. If a click occurred before the controls wake transition completed, the click fell through to the underlying video surface, triggering video play/pause toggle.

Resolution: Retained the hit target area for the progress bar slider even during idle transition while keeping non-essential buttons inactive.

## Local Testing

Automated and manual seek regression verification is available via `tests/player-seek.html` and headless Chromium/WebKit test scripts.
