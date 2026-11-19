import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AppProvider } from "./store";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";
import { initPlaybackLog, installPlaybackPageEvents, tracePlayback } from "./playbackDiagnostics";
import { initAutoLine } from "./autoLine";
import { APP_VERSION, LOCAL, logLine, platform, webviewVersion } from "./api";
import Hls from "hls.js";
import { installLayoutDiagnostics } from "./layoutDiagnostics";
installPlaybackPageEvents();
void initPlaybackLog();
try {
  document.documentElement.classList.remove("theme-amoled");
  localStorage.removeItem("aurastream_amoled_mode_v1");
} catch {}
/* Auto line selection: probes mirror lines when main is unavailable */
initAutoLine();
/* Environment fingerprint logged to debug.log for diagnostic reports */
logLine(
  `[env] ver=${APP_VERSION} platform=${platform} webview=${webviewVersion} ` +
    `engine=${Hls.isSupported() ? "hls.js" : "native"} ` +
    `mss=${"MediaSource" in window ? "y" : "n"} media=${LOCAL} ` +
    `screen=${screen.width}x${screen.height} dpr=${devicePixelRatio} lang=${navigator.language}`,
);

/* Environment fingerprint included in structured diagnostics */
tracePlayback("app.env", {
  ver: APP_VERSION, platform, webview: webviewVersion,
  engine: Hls.isSupported() ? "hls.js" : "native",
  media_source: "MediaSource" in window, managed_media_source: "ManagedMediaSource" in window,
  media_scheme: LOCAL.split(":")[0], screen: `${screen.width}x${screen.height}`,
  dpr: devicePixelRatio, lang: navigator.language,
});
/* Runtime errors recorded into debug.log */
function report(kind: string, msg: string) {
  invoke("debug_log", { msg: `[${kind}] ${msg}` }).catch(() => {});
  tracePlayback(`app.${kind}`, { detail: msg });
}
const onError = (e: ErrorEvent) => {
  report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
};
const onUnhandledRejection = (e: PromiseRejectionEvent) => {
  report("reject", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
};
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onUnhandledRejection);
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onUnhandledRejection);
  });
}

/* iOS safe area: uses CSS 100dvh to track dynamic viewport height. */

class AppErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    report("react_error", `${error.message} \n ${error.stack} \n ComponentStack: ${errorInfo.componentStack}`);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ position: "fixed", inset: 0, background: "#121216", color: "#f4f1eb", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", fontFamily: "system-ui, sans-serif" }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: "rgba(239, 68, 68, 0.15)", color: "#ef4444", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 16 }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ fontSize: 13, color: "#9ca3af", maxWidth: 320, marginBottom: 20 }}>An unexpected UI error occurred. You can reload the app to continue.</p>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "10px 24px", borderRadius: 999, background: "#059669", color: "#fff", fontWeight: 600, border: "none", cursor: "pointer", fontSize: 14 }}
          >
            Reload AuraStream
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProvider>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </AppProvider>
  </React.StrictMode>,
);
installLayoutDiagnostics();
