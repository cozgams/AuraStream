//! Linux desktop media channel: serves [`crate::media::handle`] via loopback HTTP on 127.0.0.1. Created by AAA.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};

/// Local loopback port
pub const PORT: u16 = 17650;

/// Local media origin shared between frontend and backend
pub const ORIGIN: &str = "http://127.0.0.1:17650";

/// Starts the loopback media streaming service
pub fn start() {
    std::thread::spawn(|| {
        let listener = match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("[media] Port {PORT} bind failed: {err}");
                return;
            }
        };
        eprintln!("[media] Proxy ready: {ORIGIN}");
        for stream in listener.incoming().flatten() {
            std::thread::spawn(move || {
                if let Err(err) = serve(stream) {
                    eprintln!("[media] Stream error: {err}");
                }
            });
        }
    });
}

fn serve(mut stream: TcpStream) -> std::io::Result<()> {
    let timeout = Some(std::time::Duration::from_secs(30));
    stream.set_read_timeout(timeout)?;
    stream.set_write_timeout(timeout)?;

    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line)? == 0 {
        return Ok(());
    }
    let mut range = None;
    let mut range_count = 0;
    let mut if_range = false;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim_end().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("Range") {
                range_count += 1;
                range = Some(value.trim().to_owned());
            } else if name.eq_ignore_ascii_case("If-Range") {
                if_range = true;
            }
        }
    }

    let mut request = request_line.split_whitespace();
    let method = request.next().unwrap_or_default();
    let target = request.next().unwrap_or("/");
    if method != "GET" && method != "HEAD" {
        return write_plain(&mut stream, 405, "method not allowed");
    }

    let (path, query) = match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    };

    let range = if method == "GET" && range_count == 1 && !if_range {
        range.as_deref()
    } else {
        None
    };
    let response = tauri::async_runtime::block_on(crate::media::handle_with_method(
        path,
        query,
        ORIGIN,
        range,
        method == "HEAD",
    ));
    let (parts, body) = response.into_parts();

    write_response(&mut stream, method, parts, &body)
}

fn write_response(
    stream: &mut impl Write,
    method: &str,
    parts: tauri::http::response::Parts,
    body: &[u8],
) -> std::io::Result<()> {
    let mut head = String::with_capacity(320);
    head.push_str(&format!(
        "HTTP/1.1 {} {}\r\n",
        parts.status.as_u16(),
        parts.status.canonical_reason().unwrap_or("OK")
    ));
    let content_len = if method == "HEAD" && body.is_empty() {
        parts
            .headers
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0)
    } else {
        body.len()
    };
    head.push_str(&format!("Content-Length: {content_len}\r\n"));
    for (name, value) in parts.headers.iter() {
        // This server sends a complete body and closes the connection. Do not
        // duplicate media::handle's length/CORS headers or forward framing for
        // an upstream connection (WebKit rejects ambiguous HTTP framing).
        if matches!(
            name.as_str(),
            "content-length" | "transfer-encoding" | "connection" | "access-control-allow-origin"
        ) {
            continue;
        }
        if let Ok(value) = value.to_str() {
            head.push_str(&format!("{}: {}\r\n", name.as_str(), value));
        }
    }
    head.push_str("Access-Control-Allow-Origin: *\r\n");
    head.push_str("Connection: close\r\n\r\n");
    stream.write_all(head.as_bytes())?;
    if method != "HEAD" {
        stream.write_all(body)?;
    }
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::write_response;
    use tauri::http::Response;

    #[test]
    fn get_has_one_authoritative_length_and_cors_header() {
        let (parts, body) = Response::builder()
            .header("Content-Length", "999")
            .header("Transfer-Encoding", "chunked")
            .header("Connection", "keep-alive")
            .header("Access-Control-Allow-Origin", "*")
            .header("Content-Type", "application/vnd.apple.mpegurl")
            .body(b"#EXTM3U\n".to_vec())
            .unwrap()
            .into_parts();
        let mut wire = Vec::new();
        write_response(&mut wire, "GET", parts, &body).unwrap();
        let wire = String::from_utf8(wire).unwrap();
        let (head, data) = wire.split_once("\r\n\r\n").unwrap();
        let headers = head.to_ascii_lowercase();
        assert_eq!(headers.matches("content-length:").count(), 1);
        assert!(headers.contains("content-length: 8\r\n"));
        assert_eq!(headers.matches("access-control-allow-origin:").count(), 1);
        assert_eq!(headers.matches("connection:").count(), 1);
        assert!(headers.ends_with("connection: close"));
        assert!(!headers.contains("transfer-encoding:"));
        assert!(headers.contains("content-type: application/vnd.apple.mpegurl"));
        assert_eq!(data, "#EXTM3U\n");
    }

    #[test]
    fn head_keeps_representation_length_without_sending_body() {
        let (parts, body) = Response::builder()
            .status(206)
            .header("Content-Range", "bytes 0-3/20")
            .body(b"data".to_vec())
            .unwrap()
            .into_parts();
        let mut wire = Vec::new();
        write_response(&mut wire, "HEAD", parts, &body).unwrap();
        let wire = String::from_utf8(wire).unwrap();
        assert!(wire.starts_with("HTTP/1.1 206 Partial Content\r\n"));
        assert!(wire.contains("Content-Length: 4\r\n"));
        assert!(wire.contains("content-range: bytes 0-3/20\r\n"));
        assert!(wire.ends_with("\r\n\r\n"));
    }
}

fn write_plain(stream: &mut TcpStream, status: u16, message: &str) -> std::io::Result<()> {
    let reason = tauri::http::StatusCode::from_u16(status)
        .ok()
        .and_then(|code| code.canonical_reason())
        .unwrap_or("Error");
    let body = message.as_bytes();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}
