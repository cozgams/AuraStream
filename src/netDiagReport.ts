const ms = (n: unknown) => typeof n === "number" ? `${n}ms` : "-";
const str = (v: unknown) => typeof v === "string" ? v : "";

/** Verdict -> Human readable summary */
export const VERDICT_TEXT: Record<string, string> = {
  ok: "Normal connectivity",
  ok_proxy: "Connected via proxy / TUN",
  fake_ip: "Intercepted by proxy / TUN (fake-ip)",
  dns_fail: "DNS resolution failed",
  dns_false_alarm: "DNS probe alert, connectivity verified",
  dns_hijack: "DNS hijacked to reserved IP",
  tcp_timeout: "Direct TCP probe timed out",
  tcp_refused: "Direct TCP probe refused",
  tls_intercept: "TLS certificate verification failed",
  tls_fail: "TLS handshake failed",
  proxy_fail: "Proxy request failed",
  http_fail: "HTTP request failed",
  http_status: "Server returned error status code",
  unknown: "Insufficient diagnostic data",
};

/** Formats net_diag JSON into clean text sections for bug reports and logs */
export function formatNetDiag(diag: unknown): string {
  if (!diag || typeof diag !== "object") return "Empty diagnostic data";
  const raw = diag as Record<string, unknown>;
  const lines: string[] = [];
  const pad = (label: string) => `${label}: `.padEnd(14);

  const verdict = str(raw.verdict) || "unknown";
  const summary = str(raw.summary);

  /* ── Header: Time + Verdict ── */
  lines.push("── AuraStream Network Diagnostics ──────────");
  if (str(raw.time)) lines.push(`${pad("Time")}${str(raw.time)}`);
  lines.push(`Verdict: ${summary || VERDICT_TEXT[verdict] || verdict}`);
  lines.push(`Code: ${verdict} (${VERDICT_TEXT[verdict] ?? "Uncategorized"})`);

  /* ── Environment ── */
  lines.push("── Environment ────────────────────────────");
  const rt = (raw.runtime ?? {}) as Record<string, unknown>;
  const os = [str(rt.platform), str(rt.os_version), str(rt.arch)].filter(Boolean).join(" ");
  if (os) lines.push(`${pad("Platform")}${os}`);
  if (str(rt.ver)) lines.push(`${pad("Version")}${str(rt.ver)}`);
  lines.push(`${pad("Endpoint")}${str(raw.base) || "-"}`);
  lines.push(`${pad("Host")}${str(raw.host) || "-"}`);

  /* ── DNS ── */
  const dns = (raw.dns ?? {}) as Record<string, unknown>;
  lines.push("── DNS Probe ──────────────────────────────");
  if (dns.ok === false) {
    const detail = str(dns.kind) || str(dns.raw_kind);
    lines.push(`${pad("Status")}Failed · ${str(dns.error)}${dns.timeout ? " (Timed out 6s)" : ` · ${ms(dns.ms)}`}`);
    if (detail) lines.push(`${pad("Cause")}${detail}`);
  } else {
    const kinds = ((dns.kinds as string[]) || []).filter(Boolean);
    const count = typeof dns.count === "number" ? dns.count : undefined;
    lines.push(`${pad("Status")}${ms(dns.ms)} · ${count ?? 0} records`);
    lines.push(`${pad("Type")}${kinds.length ? kinds.join(", ") : "-"}`);
    const suspicious = (dns.suspicious_ips as string[]) || [];
    if (suspicious.length) lines.push(`${pad("Suspicious")}${suspicious.join(", ")}`);
    if (dns.has_fake_ip) lines.push(`${pad("Judgment")}fake-ip: DNS routed through TUN/Clash/Surge`);
  }

  /* ── TCP ── */
  const tcp = (raw.tcp ?? {}) as Record<string, unknown>;
  lines.push("── TCP Probe ──────────────────────────────");
  if (tcp.skipped === true) {
    lines.push(`${pad("Status")}Skipped · ${str(tcp.reason) || "No DNS resolution"}`);
  } else {
    const ok = tcp.ok === true;
    const family = tcp.family ? `[${tcp.family}] ` : "";
    const state = ok ? "Connected" : tcp.timeout ? "Timed out (No response)" : "Failed";
    const path = tcp.proxy_bypassed === true ? "Direct socket probe (bypassing app proxy)" : "Independent TCP socket probe";
    lines.push(`${pad("Status")}${path} · ${family}${state} · ${ms(tcp.ms)}`);
    if (str(tcp.addr)) lines.push(`${pad("Target")}${str(tcp.addr)}`);
    if (str(tcp.error)) lines.push(`${pad("Error")}${str(tcp.error)}`);
  }

  /* ── HTTP / TLS ── */
  const http = (raw.http ?? {}) as Record<string, unknown>;
  lines.push("── HTTP / TLS Probe ───────────────────────");
  const status = typeof http.status === "number" ? http.status : undefined;
  if (status != null) lines.push(`${pad("Status")}${status} · ${ms(http.ms)}`);
  else lines.push(`${pad("Status")}Failed · ${ms(http.ms)}`);
  lines.push(`${pad("Proxy Path")}${http.proxy_configured === true ? "Matched application HTTP proxy configuration" : http.proxy_configured === false ? "No app proxy configured (VPN/TUN may still intercept)" : "Not recorded"}`);
  if (str(http.kind)) lines.push(`${pad("Error Type")}${str(http.kind)}`);
  if (str(http.error)) lines.push(`${pad("Error")}${str(http.error)}`);

  /* ── App Proxy ── */
  const env = (raw.env ?? {}) as Record<string, unknown>;
  if (env.app_proxy_mode != null) {
    const labels: Record<string, string> = { system: "System", custom: "Custom", off: "Direct" };
    lines.push("── App Proxy ──────────────────────────────");
    lines.push(`${pad("Mode")}${labels[str(env.app_proxy_mode)] || str(env.app_proxy_mode)}`);
    if (str(env.app_proxy)) lines.push(`${pad("Egress")}${str(env.app_proxy)}`);
  }

  /* ── System Proxy Env ── */
  const envLines: string[] = [];
  for (const k of ["http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
    if (str(env[k])) envLines.push(`${k}=${str(env[k])}`);
  }
  lines.push("── System Proxy ───────────────────────────");
  lines.push(envLines.length ? envLines.join("  |  ") : "No proxy environment variables set");

  /* ── Suggestions ── */
  const suggestions = (raw.suggestions as string[]) || [];
  if (suggestions.length) {
    lines.push("── Recommendations ────────────────────────");
    suggestions.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }

  /* ── Raw JSON ── */
  lines.push("── Raw JSON Data ──────────────────────────");
  try {
    lines.push(JSON.stringify(raw, null, 2));
  } catch {
    lines.push("(Failed to format JSON)");
  }

  return lines.join("\n");
}

/** One-line summary for toast / brief logs */
export function shortVerdict(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "No diagnostic result";
  const d = raw as Record<string, unknown>;
  const verdict = str(d.verdict) || "unknown";
  return `${verdict} · ${str(d.summary) || VERDICT_TEXT[verdict] || "Unknown"}`;
}
