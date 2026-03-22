/// Returns a base64 data URL using an email, or `None`.
pub trait AvatarProvider: Send + Sync {
    fn fetch(&self, email: &str) -> Option<String>;
}
