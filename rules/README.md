# Routing Rules Reference

Date: November 18, 2026. Contains domain suffix and exact domain rules for streaming proxies. These rules specify network routing without altering account security or content sanitization policies.

## Domain Sources

| Match Type | Domain / Suffix | Purpose |
| --- | --- | --- |
| Suffix | `huangguoai.com` | API endpoint line 1, relative URL base; `src-tauri/src/net.rs`, `src/html.ts` |
| Suffix | `huangguoai.ai` | API endpoint line 2; `src-tauri/src/lines.rs` |
| Exact | `huangguoai.pages.dev` | Mirror publisher page and `publish.js`; `src-tauri/src/lines.rs` |
| Suffix | `drleao.cn` | Image CDN sample `pic.drleao.cn`; `src-tauri/src/media.rs` |
| Suffix | `hzjvlo.cn` | Video CDN sample `yd-lphu-hls.hzjvlo.cn`; `src-tauri/src/media.rs` |
| Suffix | `xxbgwypx.cc` | Mirror sample `thu.xxbgwypx.cc` and subdomains; `src-tauri/src/lines.rs` |
| Exact | `api.github.com` | Release update metadata; `src-tauri/src/api.rs` |
| Exact | `github.com` | Release page opened in external browser; `src-tauri/src/api.rs` |

## Mihomo Configuration

Using `classical` behavior text rule collection:

```yaml
rule-providers:
  aurastream:
    type: file
    behavior: classical
    format: text
    path: ./rules/hghubx.list

rules:
  - RULE-SET,aurastream,PROXY
```

## Sing-box Configuration

Using ruleset source format (compatible with sing-box 1.10+):

```json
{
  "route": {
    "rule_set": [
      {
        "type": "local",
        "tag": "aurastream",
        "format": "source",
        "path": "./rules/hghubx.json"
      }
    ],
    "rules": [
      {
        "rule_set": ["aurastream"],
        "action": "route",
        "outbound": "proxy"
      }
    ]
  }
}
```
