//! macOS titlebar: computes traffic light centering based on system metrics. Created by AAA.

use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSBackingStoreType, NSWindow, NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::{LogicalPosition, WebviewWindowBuilder};

const MAIN_WINDOW: &str = "main";

/// Frontend titlebar height in logical points (must match .win-titlebar height in CSS)
const TITLEBAR_HEIGHT: f64 = 44.0;

/// System traffic light button metrics
#[derive(Debug, Clone, Copy, PartialEq)]
struct ButtonMetrics {
    height: f64,
    bottom: f64,
}

/// Measures system traffic light dimensions using an off-screen probe window
fn measure_buttons(mtm: MainThreadMarker) -> Option<ButtonMetrics> {
    let style = NSWindowStyleMask::Titled
        | NSWindowStyleMask::Closable
        | NSWindowStyleMask::Miniaturizable
        | NSWindowStyleMask::Resizable
        | NSWindowStyleMask::FullSizeContentView;
    let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(400.0, 300.0));
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            rect,
            style,
            NSBackingStoreType::Buffered,
            true,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    window.setTitlebarAppearsTransparent(true);
    window.setTitleVisibility(NSWindowTitleVisibility::Hidden);

    let close = window.standardWindowButton(NSWindowButton::CloseButton)?;
    let parent = unsafe { close.superview() }?;
    if parent.isFlipped() {
        return None;
    }
    let frame = close.frame();
    Some(ButtonMetrics {
        height: frame.size.height,
        bottom: frame.origin.y,
    })
}

/// Calculates centered traffic light position
fn centered_y(metrics: ButtonMetrics, titlebar_height: f64) -> f64 {
    (titlebar_height / 2.0 - metrics.height / 2.0 + metrics.bottom).round()
}

/// Creates the main window with dynamically centered traffic lights on macOS
pub fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
    else {
        return Ok(());
    };

    let mut builder = WebviewWindowBuilder::from_config(app.handle(), &config)?;
    let metrics = MainThreadMarker::new().and_then(measure_buttons);
    if let Some(metrics) = metrics {
        let x = config.traffic_light_position.as_ref().map_or(14.0, |p| p.x);
        builder = builder
            .traffic_light_position(LogicalPosition::new(x, centered_y(metrics, TITLEBAR_HEIGHT)));
    }
    builder.build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centers_buttons_in_titlebar() {
        let measured = ButtonMetrics { height: 14.0, bottom: 9.0 };
        let y = centered_y(measured, 44.0);
        assert_eq!(y, 24.0);
        assert_eq!(y - measured.bottom + measured.height / 2.0, 22.0);
        assert_eq!(centered_y(measured, 52.0), 28.0);
        let other = ButtonMetrics { height: 16.0, bottom: 6.0 };
        assert_eq!(centered_y(other, 44.0), 20.0);
        assert_eq!(centered_y(ButtonMetrics { height: 13.0, bottom: 9.0 }, 44.0), 25.0);
    }
}
