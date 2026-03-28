fn main() {
    let build_version = std::env::var("APP_VERSION")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    println!("cargo:rustc-env=GITMUN_BUILD_VERSION={build_version}");

    let commit_hash = std::env::var("GITHUB_SHA")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(|sha| sha[..8.min(sha.len())].to_string())
        .or_else(|| {
            std::process::Command::new("git")
                .args(["rev-parse", "--short", "HEAD"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .unwrap_or_else(|| "dev".to_string());

    println!("cargo:rustc-env=GITMUN_COMMIT_HASH={commit_hash}");

    tauri_build::build()
}
