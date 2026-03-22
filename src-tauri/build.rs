fn main() {
    let build_version = std::env::var("APP_VERSION")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    println!("cargo:rustc-env=GITMUN_BUILD_VERSION={build_version}");
    tauri_build::build()
}
