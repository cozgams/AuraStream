use dom_query::{Document, Selection};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_ITEMS: usize = 20;
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

static CACHE_BUST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Serialize, PartialEq, Eq)]
struct HotVideo {
    video_id: i64,
    title: String,
    plays: String,
}

fn normalized_text(selection: Selection<'_>) -> String {
    normalized_string(&selection.text())
}

fn normalized_string(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn video_id_from_href(href: &str) -> Option<i64> {
    let id = href.strip_prefix("/video/")?.strip_suffix('/')?;
    if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let id = id.parse::<i64>().ok()?;
    (id > 0 && id <= JS_MAX_SAFE_INTEGER).then_some(id)
}

fn parse_items(html: &str) -> Result<Vec<HotVideo>, String> {
    let document = Document::from(html);
    let mut seen = HashSet::new();
    let mut items = Vec::new();

    // 1. Modern selector: .hg-search-suggest__hot-item
    let modern_items = document.select(".hg-search-suggest__hot-item");
    if !modern_items.is_empty() {
        for node in modern_items.iter() {
            let anchor = node.select("a.hg-search-suggest__hot-title, a[href^='/video/']");
            let href = anchor.attr("href");
            let Some(video_id) = href.and_then(|h| video_id_from_href(&h)) else {
                continue;
            };
            if seen.contains(&video_id) {
                continue;
            }

            let mut title = normalized_text(anchor);
            if title.is_empty() {
                title = node
                    .attr("data-search-hot")
                    .map(|t| normalized_string(&t))
                    .unwrap_or_default();
            }
            let mut plays = normalized_text(node.select(".hg-search-suggest__heat, .hg-search-suggest__plays"));
            if plays.is_empty() {
                plays = "Hot".to_string();
            }
            if title.is_empty() {
                continue;
            }

            seen.insert(video_id);
            items.push(HotVideo {
                video_id,
                title,
                plays,
            });
            if items.len() == MAX_ITEMS {
                return Ok(items);
            }
        }
        if !items.is_empty() {
            return Ok(items);
        }
    }

    // 2. Legacy fallback selector: section.hg-search-hot
    let sections = document.select("section.hg-search-hot");
    if sections.is_empty() && modern_items.is_empty() {
        return Err("Trending section not found on search page".into());
    }

    for section in sections.iter() {
        for anchor in section.select("a.hg-search-hot__item").iter() {
            let Some(video_id) = anchor
                .attr("href")
                .and_then(|href| video_id_from_href(&href))
            else {
                continue;
            };
            if seen.contains(&video_id) {
                continue;
            }

            let title = normalized_text(anchor.select(".hg-search-hot__name"));
            let title = if title.is_empty() {
                anchor
                    .attr("data-search-hot")
                    .map(|title| normalized_string(&title))
                    .unwrap_or_default()
            } else {
                title
            };
            let plays = normalized_text(anchor.select(".hg-search-hot__plays"));
            if title.is_empty() || plays.is_empty() {
                continue;
            }

            seen.insert(video_id);
            items.push(HotVideo {
                video_id,
                title,
                plays,
            });
            if items.len() == MAX_ITEMS {
                return Ok(items);
            }
        }
    }

    if items.is_empty() {
        Err("No available entries on trending ranking".into())
    } else {
        Ok(items)
    }
}

fn cache_bust_value() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let sequence = CACHE_BUST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{timestamp}-{sequence}")
}

async fn fetch_html() -> Result<String, String> {
    let base = crate::net::base();
    tokio::time::timeout(REQUEST_TIMEOUT, async {
        let referer = format!("{base}/");
        let url = format!(
            "{}/search/?_aurastream_hot={}",
            base,
            cache_bust_value()
        );
        let mut response = crate::net::get(
            &url,
            REQUEST_TIMEOUT,
            Some("text/html,application/xhtml+xml"),
            Some(&referer),
        )
        .await?;

        if !response.status().is_success() {
            return Err(format!("Search page request failed (HTTP {})", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|length| length > MAX_HTML_BYTES as u64)
        {
            return Err("Search page exceeds 2 MiB limit".into());
        }

        let mut html = Vec::with_capacity(response.content_length().unwrap_or(0) as usize);
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            if html.len().saturating_add(chunk.len()) > MAX_HTML_BYTES {
                return Err("Search page exceeds 2 MiB limit".into());
            }
            html.extend_from_slice(&chunk);
        }
        String::from_utf8(html).map_err(|_| "Search page is not valid UTF-8 HTML".into())
    })
    .await
    .map_err(|_| "Fetching trending search timed out (12s)".to_string())?
}

pub async fn fetch() -> Result<Value, String> {
    let html = fetch_html()
        .await
        .map_err(|error| format!("Failed to fetch trending search: {error}"))?;
    let items =
        parse_items(&html).map_err(|error| format!("Failed to fetch trending search: {error}"))?;
    Ok(json!({ "items": items }))
}

const MAX_HOT_TAGS: usize = 50;

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct HotTag {
    pub name: String,
    pub slug: String,
}

fn tag_slug_from_href(href: &str) -> Option<String> {
    let rest = href.strip_prefix("/tag/")?;
    let slug = rest.strip_suffix('/').unwrap_or(rest);
    if slug.is_empty()
        || slug == "."
        || slug == ".."
        || slug
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '/' | '?' | '#' | '\\'))
    {
        return None;
    }
    Some(slug.to_owned())
}

pub fn parse_hot_tags(html: &str) -> Result<Vec<HotTag>, String> {
    let document = Document::from(html);
    let sections = document.select("section.hg-home-popular-tags");
    if sections.is_empty() {
        return Err("Homepage popular tags section not found".into());
    }

    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for section in sections.iter() {
        for anchor in section.select("a.hg-tagrow__item").iter() {
            let Some(slug) = anchor
                .attr("href")
                .and_then(|href| tag_slug_from_href(&href))
            else {
                continue;
            };
            let name = normalized_text(anchor);
            if name.is_empty() || !seen.insert(slug.clone()) {
                continue;
            }
            items.push(HotTag { name, slug });
            if items.len() == MAX_HOT_TAGS {
                return Ok(items);
            }
        }
    }

    if items.is_empty() {
        Err("No popular tags available".into())
    } else {
        Ok(items)
    }
}

pub async fn fetch_hot_tags() -> Result<Value, String> {
    let base = crate::net::base();
    let url = format!("{}/", base.trim_end_matches('/'));
    let html = tokio::time::timeout(REQUEST_TIMEOUT, async {
        let referer = format!("{base}/");
        let response = crate::net::get(
            &url,
            REQUEST_TIMEOUT,
            Some("text/html,application/xhtml+xml"),
            Some(&referer),
        )
        .await?;
        if !response.status().is_success() {
            return Err(format!("Homepage request failed (HTTP {})", response.status()));
        }
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        String::from_utf8(bytes.to_vec()).map_err(|_| "Homepage is not valid UTF-8 HTML".into())
    })
    .await
    .map_err(|_| "Fetching popular tags timed out (12s)".to_string())??;

    let items = parse_hot_tags(&html).map_err(|error| format!("Failed to parse popular tags: {error}"))?;
    Ok(json!({ "items": items }))
}

#[cfg(test)]
mod tests {
    use super::{parse_hot_tags, parse_items, video_id_from_href, JS_MAX_SAFE_INTEGER};

    #[test]
    fn parses_hot_section_in_dom_order_and_decodes_entities() {
        let html = r#"
            <section class="hg-search-hot">
              <a class="hg-search-hot__item" href="/video/3483/" data-search-hot="fallback">
                <span class="hg-search-hot__name">Jade&nbsp;Goddess &amp; Special Edition</span>
                <span class="hg-search-hot__plays"><img alt="play">1185.1w plays</span>
              </a>
              <a class="hg-search-hot__item" href="/video/11571/">
                <span class="hg-search-hot__name">Season Two</span>
                <span class="hg-search-hot__plays">267.3w plays</span>
              </a>
            </section>
        "#;

        let items = parse_items(html).unwrap();
        assert_eq!(items[0].video_id, 3483);
        assert_eq!(items[0].title, "Jade Goddess & Special Edition");
        assert_eq!(items[0].plays, "1185.1w plays");
        assert_eq!(items[1].video_id, 11571);
    }

    #[test]
    fn falls_back_to_data_title_and_deduplicates_by_video_id() {
        let html = r#"
            <section class="hg-search-hot">
              <a class="hg-search-hot__item" href="/video/7/" data-search-hot="First &amp; Entity">
                <span class="hg-search-hot__plays">1.2B plays</span>
              </a>
              <a class="hg-search-hot__item" href="/video/7/" data-search-hot="Duplicate Entry">
                <span class="hg-search-hot__plays">999 plays</span>
              </a>
            </section>
        "#;

        let items = parse_items(html).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "First & Entity");
        assert_eq!(items[0].plays, "1.2B plays");
    }

    #[test]
    fn rejects_external_malformed_and_unsafe_ids() {
        assert_eq!(video_id_from_href("https://huangguoai.com/video/1/"), None);
        assert_eq!(video_id_from_href("//huangguoai.com/video/1/"), None);
        assert_eq!(video_id_from_href("/video/0/"), None);
        assert_eq!(video_id_from_href("/video/1/extra/"), None);
        assert_eq!(video_id_from_href("/video/9007199254740992/"), None);
        assert_eq!(video_id_from_href("/video/9007199254740991/"), Some(JS_MAX_SAFE_INTEGER));
    }

    #[test]
    fn ignores_links_outside_hot_section_and_reports_missing_or_empty_sections() {
        let outside = r#"<a class="hg-search-hot__item" href="/video/1/">
            <span class="hg-search-hot__name">External</span><span class="hg-search-hot__plays">2w</span>
        </a>"#;
        assert_eq!(parse_items(outside).unwrap_err(), "Trending section not found on search page");

        let invalid = r#"<section class="hg-search-hot">
            <a class="hg-search-hot__item" href="https://evil.example/video/1/" data-search-hot="Remote">
              <span class="hg-search-hot__plays">2w</span>
            </a>
        </section>"#;
        assert_eq!(parse_items(invalid).unwrap_err(), "No available entries on trending ranking");
        assert_eq!(
            parse_items("<section class=\"hg-search-hot\"></section>").unwrap_err(),
            "No available entries on trending ranking"
        );
    }

    #[test]
    fn parses_modern_upstream_suggest_hot_format() {
        let html = r#"
            <div class="hg-search-suggest__hot">
              <div class="hg-search-suggest__hot-item" data-search-hot="First Drama" data-rank-hot="1">
                <span class="hg-search-suggest__rank is-top">1</span>
                <a class="hg-search-suggest__hot-title" href="/video/15341/">First Drama</a>
                <span class="hg-search-suggest__heat">91.3w</span>
              </div>
              <div class="hg-search-suggest__hot-item" data-search-hot="Second Drama" data-rank-hot="2">
                <span class="hg-search-suggest__rank is-top">2</span>
                <a class="hg-search-suggest__hot-title" href="/video/15342/">Second Drama</a>
                <span class="hg-search-suggest__heat">85.0w</span>
              </div>
            </div>
        "#;
        let items = parse_items(html).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].video_id, 15341);
        assert_eq!(items[0].title, "First Drama");
        assert_eq!(items[0].plays, "91.3w");
        assert_eq!(items[1].video_id, 15342);
        assert_eq!(items[1].title, "Second Drama");
        assert_eq!(items[1].plays, "85.0w");
    }

    #[test]
    fn parses_homepage_popular_tags() {
        let html = r#"
            <section class="hg-home-popular-tags">
              <a class="hg-tagrow__item" href="/tag/romance/">Romance</a>
              <a class="hg-tagrow__item" href="/tag/ceo/">CEO</a>
              <a class="hg-tagrow__item" href="/tag/romance/">Romance Duplicate</a>
              <a class="hg-tagrow__item" href="/other/invalid/">Invalid</a>
            </section>
        "#;
        let tags = parse_hot_tags(html).unwrap();
        assert_eq!(tags.len(), 2);
        assert_eq!(tags[0].name, "Romance");
        assert_eq!(tags[0].slug, "romance");
        assert_eq!(tags[1].name, "CEO");
        assert_eq!(tags[1].slug, "ceo");
    }
}
