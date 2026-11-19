//! AuraStream environment variables: Modern names take precedence. Created by AAA.

pub fn var(suffix: &str) -> Option<String> {
    read_with(suffix, |key| std::env::var(key).ok())
}

fn read_with(suffix: &str, mut read: impl FnMut(&str) -> Option<String>) -> Option<String> {
    read(&format!("AURASTREAM_{suffix}"))
        .or_else(|| read(&format!("HGHUBX_{suffix}")))
        .or_else(|| read(&format!("HGHUB_{suffix}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_names_take_precedence_and_legacy_names_remain_supported() {
        for suffix in [
            "PROXY",
            "STRICT",
            "TEST_COVER_URL",
            "TEST_MEDIA_URL",
            "TEST_MEDIA_OUTPUT",
        ] {
            let modern = format!("AURASTREAM_{suffix}");
            let current = format!("HGHUBX_{suffix}");
            let legacy = format!("HGHUB_{suffix}");
            let resolve = |m: Option<&str>, new: Option<&str>, old: Option<&str>| {
                read_with(suffix, |key| {
                    if key == modern {
                        m.map(str::to_owned)
                    } else if key == current {
                        new.map(str::to_owned)
                    } else if key == legacy {
                        old.map(str::to_owned)
                    } else {
                        panic!("unexpected environment variable: {key}")
                    }
                })
            };
            assert_eq!(resolve(None, None, None), None);
            assert_eq!(resolve(None, None, Some("old")), Some("old".to_owned()));
            assert_eq!(resolve(None, Some("new"), None), Some("new".to_owned()));
            assert_eq!(resolve(None, Some("new"), Some("old")), Some("new".to_owned()));
            assert_eq!(resolve(Some("modern"), Some("new"), Some("old")), Some("modern".to_owned()));
            // Explicitly set modern variable cannot be overridden by legacy configuration
            assert_eq!(resolve(Some(""), Some("new"), Some("old")), Some(String::new()));
        }
    }
}
