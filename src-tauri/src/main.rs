#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

fn main() {
    // Configure VA-API on hybrid Linux graphics for smooth zero-copy video decode
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("GST_PLUGIN_FEATURE_RANK").is_none() && intel_display_with_nvidia() {
            std::env::set_var(
                "GST_PLUGIN_FEATURE_RANK",
                "nvh264dec:0,nvh265dec:0,vah264dec:MAX,vah265dec:MAX",
            );
        }
    }

    hghubx_lib::run()
}

/// Detects Intel display with NVIDIA discrete GPU topology
#[cfg(target_os = "linux")]
fn intel_display_with_nvidia() -> bool {
    use std::path::Path;
    if !Path::new("/sys/module/nvidia").exists() {
        return false;
    }
    std::fs::read_dir("/sys/class/drm")
        .map(|rd| {
            rd.flatten().any(|entry| {
                std::fs::read_to_string(entry.path().join("device/vendor"))
                    .map(|v| v.trim().eq_ignore_ascii_case("0x8086"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}
