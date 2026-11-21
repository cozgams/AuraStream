fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        let arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
        if arch == "aarch64" || arch == "x86_64" {
            println!("cargo:rustc-link-arg-cdylib=-Wl,-z,max-page-size=16384");
            println!("cargo:rustc-link-arg-cdylib=-Wl,-z,common-page-size=16384");
        }
    }
    tauri_build::build()
}
