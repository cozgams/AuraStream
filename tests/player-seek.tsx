import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import Feed from "../src/components/Feed";
import { AppProvider } from "../src/store";
import { api } from "../src/api";
import "../src/index.css";
import { flushPlaybackLog, initPlaybackLog, playbackLogApi, setPlaybackLog } from "../src/playbackDiagnostics";
import Settings from "../src/pages/Settings";
import Player from "../src/components/Player";
import Hls from "hls.js";

// Maps custom media protocols to local test server; real implementations for player, HLS, and mouse.
const proxy = new URLSearchParams(location.search).get("proxy") || "http://127.0.0.1:17779";
const rewriteProxyUrl = (raw: string) => {
  const url = new URL(raw, location.href);
  if (url.hostname === "hg.localhost" || (url.hostname === "localhost" && url.protocol === "hg:")) {
    return `${proxy}${url.pathname}${url.search}`;
  }
  return raw;
};
const open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, target: string | URL, async: boolean = true, user?: string | null, credential?: string | null) {
  const rewritten = rewriteProxyUrl(String(target));
  return open.call(this, method, rewritten, async, user, credential);
};
const origFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === "string" || input instanceof URL) {
    return origFetch(rewriteProxyUrl(String(input)), init);
  }
  const rewritten = rewriteProxyUrl(input.url);
  if (rewritten !== input.url) {
    return origFetch(new Request(rewritten, input), init);
  }
  return origFetch(input, init);
};

const fixture = {
  rejectPlaybackApi: new URLSearchParams(location.search).has("api-failure"),
  seeks: [] as number[], errors: [] as string[],
  setActive: (_active: boolean) => {},
  logs: [] as { event: string; data: Record<string, unknown> }[],
  setLogging: setPlaybackLog,
  flushLogs: flushPlaybackLog,
  rejectLoggingSave: false,
  pauseBuffering: () => testHls?.pauseBuffering(),
  resumeBuffering: () => testHls?.resumeBuffering(),
  engineState: () => ({ loading: testHls?.loadingEnabled, buffering: testHls?.bufferingEnabled, levels: testHls?.levels.length }),
};
let testHls: Hls | undefined;
const diagnosticTest = new URLSearchParams(location.search).has("diagnostics");
const legacyTest = new URLSearchParams(location.search).has("legacy");
const initiallyInactive = new URLSearchParams(location.search).has("inactive");
if (diagnosticTest) {
  // Test-only handle: exercise the real engine's public API without rewriting production modules.
  const attach = Hls.prototype.attachMedia;
  Hls.prototype.attachMedia = function (...args) { testHls = this; return attach.apply(this, args); };
  let enabled = false;
  playbackLogApi.status = async () => ({ enabled, path: "playback.log", error: null });
  playbackLogApi.set = async (on) => {
    if (fixture.rejectLoggingSave) throw new Error("fixture: disk unavailable");
    return { enabled: enabled = on, path: "playback.log", error: null };
  };
  playbackLogApi.write = async entries => {
    if (!enabled) return;
    fixture.logs.push(...entries);
    const collect = (window as typeof window & { collectPlaybackLogs?: (entries: typeof fixture.logs) => Promise<void> }).collectPlaybackLogs;
    await collect?.(entries);
  };
  playbackLogApi.read = async () => fixture.logs.map(e => JSON.stringify(e)).join("\n");
  api.lineState = async () => ({ base: "https://fixture.invalid", default: "https://fixture.invalid", fixed: [] });
  void initPlaybackLog();
}
Object.assign(window, { playerSeekFixture: fixture });
document.addEventListener("seeking", (e) => {
  if (e.target instanceof HTMLVideoElement) fixture.seeks.push(e.target.currentTime);
}, true);
window.addEventListener("error", (e) => fixture.errors.push(e.message));
api.boot = async () => ({ user: null, logged_in: false, base: "https://fixture.invalid", strict_security: true });
api.play = async () => {
  if (fixture.rejectPlaybackApi) throw new Error("fixture playback API unavailable");
  return { id: 991, ep_num: 1, title: "Seek fixture", duration: 90, video_url: "https://media.fixture.invalid/list.m3u8" };
};
api.video = async () => ({
  id: 991, title: "Seek fixture", description: "", cover: "", tags: [], score: 0,
  episode_count: 1, total_episodes: 1,
  episodes: [{ ep_num: 1, title: "one", duration: 90, status: 1 }],
  counts: { like: 0, collect: 0, comment: 0, hot: 0 },
  author: { id: 1, name: "Fixture" }, is_finished: true, is_original: 0,
});
function Fixture() {
  const [active, setActive] = useState(!initiallyInactive);
  const [settings, setSettings] = useState(false);
  fixture.setActive = setActive;
  return <AppProvider>
    <div style={{ position: "relative", width: 900, height: 540 }}>
      {legacyTest
        ? <Player src="https://media.fixture.invalid/list.m3u8" autoPlay active={active} className="w-full h-full" diagnosticContext={{ video_id: 991, active }} />
        : <Feed videoIds={[991]} mode="home" active={active} bottomInset={0} />}
    </div>
    <button onClick={() => setActive((v) => !v)}>Toggle Playback Active State</button>
    {diagnosticTest && <button onClick={() => setSettings(v => !v)}>Diagnostic Settings</button>}
    {settings && <div style={{ position: "relative", width: 900, height: 700 }}><Settings onBack={() => setSettings(false)} wide /></div>}
  </AppProvider>;
}
createRoot(document.querySelector("#root")!).render(<Fixture />);

// Automatically checks real browser hit testing rather than CSS string matching.
async function checkIdleSeekTarget() {
  const deadline = performance.now() + 20000;
  while (performance.now() < deadline) {
    const video = document.querySelector("video");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Playback progress"], input[aria-label="Playback progress"]');
    if (video && input && video.currentTime > 0 && document.querySelector(".player-root.is-idle")) {
      const rect = input.getBoundingClientRect();
      if (document.elementFromPoint(rect.x + rect.width * .8, rect.y + rect.height / 2) !== input) {
        throw new Error("Idle progress bar click penetrated to video");
      }
      document.querySelector("#results")!.textContent = JSON.stringify({ passed: 1, failed: 0 });
      return;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error("Timeout waiting for playback or control bar hide");
}
if (!legacyTest && !initiallyInactive) void checkIdleSeekTarget().catch((error) => {
  fixture.errors.push(String(error));
  document.querySelector("#results")!.textContent = JSON.stringify({ passed: 0, failed: 1, error: String(error) });
});
