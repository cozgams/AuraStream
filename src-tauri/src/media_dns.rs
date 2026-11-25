use crate::network_policy;
use serde_json::Value;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

pub(crate) const HOST: &str = "dns.alidns.com";
pub(crate) const BOOTSTRAP: [SocketAddr; 2] = [
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(223, 5, 5, 5)), 443),
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(223, 6, 6, 6)), 443),
];
const CLOUDFLARE_BOOTSTRAP: [SocketAddr; 2] = [
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1)), 443),
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(1, 0, 0, 1)), 443),
];
const GOOGLE_BOOTSTRAP: [SocketAddr; 2] = [
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8)), 443),
    SocketAddr::new(IpAddr::V4(Ipv4Addr::new(8, 8, 4, 4)), 443),
];

pub(crate) struct DohProvider {
    pub(crate) host: &'static str,
    pub(crate) path: &'static str,
    pub(crate) bootstrap: &'static [SocketAddr],
}

const PROVIDERS: [DohProvider; 3] = [
    DohProvider { host: "cloudflare-dns.com", path: "/dns-query", bootstrap: &CLOUDFLARE_BOOTSTRAP },
    DohProvider { host: "dns.google", path: "/resolve", bootstrap: &GOOGLE_BOOTSTRAP },
    DohProvider { host: HOST, path: "/resolve", bootstrap: &BOOTSTRAP },
];

pub(crate) fn providers() -> &'static [DohProvider] {
    &PROVIDERS
}

const MAX_RESPONSE_BYTES: usize = 16 * 1024;

#[derive(Default)]
pub(crate) struct Routes(HashMap<String, Instant>);

impl Routes {
    pub(crate) fn prefers_public(&self, host: &str, now: Instant) -> bool {
        self.0.get(host).is_some_and(|expires| now < *expires)
    }

    pub(crate) fn remember(&mut self, host: &str, now: Instant) {
        self.0.retain(|_, expires| now < *expires);
        if self.0.len() >= 64 {
            self.0.clear();
        }
        self.0
            .insert(host.to_string(), now + Duration::from_secs(30));
    }

    pub(crate) fn forget(&mut self, host: &str) {
        self.0.remove(host);
    }
}

pub(crate) fn eligible(target: &url::Url, error: &str) -> bool {
    target.scheme() == "https"
        && matches!(target.host(), Some(url::Host::Domain(_)))
        && matches!(
            crate::playback_log::error_kind(error),
            "dns_error" | "timeout" | "transport_error"
        )
}

pub(crate) struct Resolution {
    pub(crate) addresses: Vec<SocketAddr>,
    pub(crate) ttl: Duration,
}

fn answers(value: &Value, port: u16) -> Result<Resolution, String> {
    if value["Status"].as_u64() != Some(0) {
        return Err("Fallback DNS resolution failed".into());
    }
    let records = value["Answer"].as_array().ok_or("Fallback DNS returned no available addresses")?;
    let mut addresses = Vec::new();
    let mut ttl = 30;
    for record in records {
        ttl = ttl.min(record["TTL"].as_u64().unwrap_or(0));
        if record["type"].as_u64() != Some(1) {
            continue;
        }
        let ip: Ipv4Addr = record["data"]
            .as_str()
            .ok_or("Fallback DNS address invalid")?
            .parse()
            .map_err(|_| "Fallback DNS address invalid")?;
        let [first, second, _, _] = ip.octets();
        if !network_policy::allowed_ip(ip.into())
            || (first == 198 && (second == 18 || second == 19))
        {
            return Err("Fallback DNS returned private or reserved address".into());
        }
        addresses.push(SocketAddr::new(ip.into(), port));
    }
    addresses.sort_unstable();
    addresses.dedup();
    if addresses.is_empty() || addresses.len() > 32 {
        return Err("Fallback DNS returned no available addresses".into());
    }
    Ok(Resolution {
        addresses,
        ttl: Duration::from_secs(ttl),
    })
}

pub(crate) async fn resolve_with_path(
    http: &reqwest::Client,
    endpoint_host: &str,
    endpoint_path: &str,
    host: &str,
    port: u16,
) -> Result<Resolution, String> {
    let mut response = http
        .get(format!("https://{endpoint_host}{endpoint_path}"))
        .header(reqwest::header::ACCEPT, "application/dns-json")
        .query(&[("name", host), ("type", "A")])
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .map_err(|_| "Fallback DNS request failed")?
        .error_for_status()
        .map_err(|_| "Fallback DNS service unavailable")?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Fallback DNS response failed")? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err("Fallback DNS response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "Fallback DNS response invalid")?;
    answers(&value, port)
}

#[allow(dead_code)]
pub(crate) async fn resolve(
    http: &reqwest::Client,
    host: &str,
    port: u16,
) -> Result<Resolution, String> {
    resolve_with_path(http, HOST, "/resolve", host, port).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn public_answers_keep_the_target_port_and_shortest_dns_ttl() {
        let result = answers(
            &json!({"Status":0,"Answer":[
                {"type":5,"data":"edge.example.","TTL":5},
                {"type":1,"data":"1.1.1.1","TTL":60},
                {"type":1,"data":"1.1.1.1","TTL":60}
            ]}),
            8443,
        )
        .unwrap();
        assert_eq!(result.addresses, vec!["1.1.1.1:8443".parse().unwrap()]);
        assert_eq!(result.ttl, Duration::from_secs(5));
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "198.18.0.1",
            "198.19.0.1",
            "not-an-ip",
        ] {
            assert!(
                answers(
                    &json!({"Status":0,"Answer":[
                        {"type":1,"data":"1.1.1.1","TTL":60},
                        {"type":1,"data":ip,"TTL":60}
                    ]}),
                    443
                )
                .is_err(),
                "{ip}"
            );
        }
        for response in [json!({"Status":3}), json!({"Status":0,"Answer":[]})] {
            assert!(answers(&response, 443).is_err());
        }
    }

    #[test]
    fn recovery_only_applies_to_https_domains_and_connection_failures() {
        let url = url::Url::parse("https://media.example/list.m3u8?auth_key=secret").unwrap();
        for error in [
            "DNS resolution failed",
            "Request timed out",
            "client error (Connect) ← operation timed out",
            "tls handshake eof",
        ] {
            assert!(eligible(&url, error));
        }
        for error in [
            "HTTP 403 Forbidden",
            "HTTP 404 Not Found",
            "HTTP 503 Service Unavailable",
            "Private network access denied",
            "HTTPS downgrade redirect denied",
        ] {
            assert!(!eligible(&url, error), "{error}");
        }
        for raw in [
            "http://media.example/video",
            "https://127.0.0.1/video",
            "https://[::1]/video",
        ] {
            assert!(!eligible(&url::Url::parse(raw).unwrap(), "Request timed out"));
        }
    }

    #[test]
    fn recovered_hosts_expire_and_do_not_change_other_hosts() {
        let now = Instant::now();
        let mut routes = Routes::default();
        assert!(!routes.prefers_public("media.example", now));
        routes.remember("media.example", now);
        assert!(routes.prefers_public("media.example", now + Duration::from_secs(29)));
        assert!(!routes.prefers_public("other.example", now));
        assert!(!routes.prefers_public("media.example", now + Duration::from_secs(30)));
    }
}
