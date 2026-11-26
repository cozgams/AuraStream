import { Button, Input, SegmentedControl } from "./ios/controls";
import { useEffect, useRef, useState } from "react";
import { api, isMobile, type ProxyMode, type ProxyProbe, type ProxyState } from "../api";
import { useStore } from "../store";
import { IChevR, IClose, ILink } from "../icons";
import { Modal, Sheet } from "./ui";

const MODES: ProxyMode[] = ["system", "custom", "off"];
const LABELS: Record<ProxyMode, string> = { system: "System", custom: "Custom", off: "Direct" };
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : typeof error === "string" ? error : fallback;

function summary(state: ProxyState | null, failed: boolean): string {
  if (!state) return failed ? "Failed to read, tap to retry" : "Loading…";
  if (state.mode === "off") return "Direct · Bypasses system proxy & env";
  if (state.effective) return `${LABELS[state.mode]} · ${state.effective}`;
  return state.mode === "custom" ? "Custom Proxy" : state.system_proxy || state.env_proxy ? "System · Proxy Detected" : "System · No Proxy Detected";
}

export default function ProxySettings() {
  const { toast } = useStore();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ProxyState | null>(null);
  const [mode, setMode] = useState<ProxyMode>("system");
  const [url, setUrl] = useState("");
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<"test" | "save" | "">("");
  const [error, setError] = useState("");
  const [probe, setProbe] = useState<ProxyProbe | null>(null);
  const [ready, setReady] = useState(false);
  const request = useRef(0);
  const pending = useRef(false);
  const probeGeneration = useRef(0);

  const read = async (syncDraft = false) => {
    const generation = ++request.current;
    if (syncDraft) {
      setLoading(true);
      setReady(false);
    }
    setLoadError("");
    try {
      const next = await api.proxyState();
      if (generation !== request.current) return;
      setState(next);
      if (syncDraft) {
        setMode(next.mode);
        setUrl(next.url || "");
        setProbe(null);
        setError("");
        setVisible(false);
        setReady(true);
      }
    } catch (failure) {
      if (generation === request.current) setLoadError(message(failure, "Failed to load proxy settings"));
    } finally {
      if (generation === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    void read(false);
    const sync = () => { void read(false); };
    const invalidateProbe = () => { probeGeneration.current++; setProbe(null); };
    window.addEventListener("hg:proxy-changed", sync);
    window.addEventListener("hg:line-changed", invalidateProbe);
    return () => {
      request.current++;
      probeGeneration.current++;
      window.removeEventListener("hg:proxy-changed", sync);
      window.removeEventListener("hg:line-changed", invalidateProbe);
    };
  }, []);

  const openForm = () => {
    setOpen(true);
    void read(true);
  };
  const close = () => {
    if (busy) return;
    setOpen(false);
    setVisible(false);
  };
  const change = () => {
    probeGeneration.current++;
    setProbe(null);
    setError("");
  };

  const run = async (action: "test" | "save") => {
    if (pending.current || !ready) return;
    if (mode === "custom" && !url.trim()) {
      setError("Please enter a proxy URL");
      return;
    }
    pending.current = true;
    setBusy(action);
    setError("");
    const generation = ++probeGeneration.current;
    try {
      if (action === "test") {
        const result = await api.proxyTest(mode, mode === "custom" ? url.trim() : "");
        if (generation === probeGeneration.current) setProbe(result);
        else setError("Route updated, please re-test");
      } else {
        const next = await api.proxySet(mode, mode === "custom" ? url.trim() : "");
        setState(next);
        setMode(next.mode);
        setUrl(next.url || "");
        setProbe(null);
        setOpen(false);
        setVisible(false);
        window.dispatchEvent(new Event("hg:proxy-changed"));
        toast(`Proxy settings saved · ${LABELS[next.mode]}`, "ok");
      }
    } catch (failure) {
      setError(message(failure, action === "test" ? "Proxy test failed" : "Failed to save proxy settings"));
    } finally {
      pending.current = false;
      setBusy("");
    }
  };

  const disabled = !ready || !!busy || loading;
  const body = <div className="flex flex-col min-h-0" style={{ maxHeight: isMobile ? "min(76dvh, calc(100dvh - 24px))" : "min(78dvh, 640px)" }}>
    <div className="shrink-0 flex items-center gap-3 px-4 pt-3 pb-2">
      <span className="ios-setting-icon" aria-hidden="true"><ILink size={16} /></span>
      <h2 className="flex-1 text-[16px] font-bold text-on">Proxy Access</h2>
      <Button aria-label="Close" disabled={!!busy} onClick={close} className="min-h-12 min-w-12 flex items-center justify-center"><IClose size={18} /></Button>
    </div>
    <form className="scroll-y px-4 pb-5 space-y-4" onSubmit={(event) => { event.preventDefault(); void run("save"); }}>
      <p className="text-[13px] text-mut leading-relaxed">Configures proxy routing for AuraStream. Test connection before saving.</p>
      {loadError && <div role="alert" className="text-[13px] text-danger">
        {loadError}
        <Button onClick={() => { void read(true); }} disabled={loading} className="min-h-12 px-3 ml-1 text-primary">Retry</Button>
      </div>}
      {loading && <p role="status" className="text-[13px] text-mut">Loading proxy settings…</p>}
      <SegmentedControl aria-label="Proxy Mode" activeIndex={MODES.indexOf(mode)}>
        {MODES.map(value => <Button key={value} disabled={disabled} aria-pressed={mode === value}
          className="min-h-12" onClick={() => { setMode(value); change(); }}>{LABELS[value]}</Button>)}
      </SegmentedControl>
      {mode === "custom" && <div>
        <label htmlFor="proxy-address" className="block text-[14px] text-on mb-2">Proxy Address</label>
        <Input id="proxy-address" aria-label="Proxy Address" type={visible ? "text" : "password"} value={url}
          disabled={disabled} autoComplete="off" autoCapitalize="none" spellCheck={false}
          placeholder="http://127.0.0.1:7890" aria-invalid={!!error} aria-describedby={`proxy-address-hint${error ? " proxy-form-error" : ""}`}
          className="w-full min-h-12 min-w-0 text-[16px]" onChange={event => { setUrl(event.target.value); change(); }} />
        <div className="flex items-start gap-2 mt-1">
          <p id="proxy-address-hint" className="flex-1 text-[12px] text-mut leading-relaxed pt-2">Supports HTTP, HTTPS, and SOCKS. For Android emulator / phone, 127.0.0.1 refers to device itself.</p>
          <Button onClick={() => setVisible(value => !value)} aria-pressed={visible} className="min-h-12 shrink-0 px-2 text-[12px] text-primary">{visible ? "Hide" : "Show"}</Button>
        </div>
      </div>}
      {mode !== "custom" && <p className="text-[13px] text-mut leading-relaxed">{mode === "system" ? "Uses system proxy and environment variables. Saved custom addresses are preserved." : "Direct connection to endpoints, bypassing system proxy. Saved addresses are preserved."}</p>}
      {error && <p id="proxy-form-error" role="alert" className="text-[13px] text-danger break-words">{error}</p>}
      <div role="status" aria-live="polite" className={`text-[13px] break-words ${probe && !probe.ok ? "text-danger" : "text-mut"}`}>
        {busy === "test" ? "Testing proxy connection…" : probe ? probe.ok ? `Available · ${probe.ms}ms` : `Connection failed · ${probe.error || (probe.status ? `HTTP ${probe.status}` : "Check address & network")}` : "Testing verifies current draft; changes apply after saving."}
      </div>
      <div className="flex gap-3">
        <Button variant="secondary" disabled={disabled} onClick={() => { void run("test"); }} className="min-h-12 flex-1 px-3">{busy === "test" ? "Testing…" : "Test Connection"}</Button>
        <Button variant="primary" type="submit" disabled={disabled} className="min-h-12 flex-1 px-3">{busy === "save" ? "Saving…" : "Save Proxy"}</Button>
      </div>
    </form>
  </div>;

  return <>
    <Button onClick={openForm} className="w-full flex items-center gap-3 px-3.5 py-3 text-left pressable">
      <span className="ios-setting-icon" aria-hidden="true"><ILink size={16} /></span>
      <div className="flex-1 min-w-0"><div className="text-[14px] text-on">Proxy Access</div><div className="text-[12px] text-mut truncate">{summary(state, !!loadError)}</div></div>
      <IChevR size={15} className="text-mut" />
    </Button>
    {isMobile ? <Sheet open={open} onClose={close} label="Proxy Access">{body}</Sheet> : <Modal open={open} onClose={close} label="Proxy Access" width={460}>{body}</Modal>}
  </>;
}
