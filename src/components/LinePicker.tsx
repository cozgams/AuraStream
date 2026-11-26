import { Button, Input, Surface } from "./ios/controls";
import { Loader } from "./ios/effects";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, hostOf, isMobile, type LineApply, type LineItem, type LineProbe, type LineState } from "../api";
import { tracePlayback } from "../playbackDiagnostics";
import { autoLineEnabled, setAutoLine } from "../autoLine";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { ICheck, IClose, IRefresh, ISettings } from "../icons";

type ProbeMap = Record<string, LineProbe>;

/* Single Line Item Row */
function Row({ item, current, probe, busy, disabled, onPick, onProbe }: {
  item: LineItem; current: boolean; probe?: LineProbe; busy: boolean; disabled: boolean;
  onPick: (url: string) => void; onProbe: (url: string) => void;
}) {
  return (
    <div className={`flex items-center gap-2 px-3.5 py-2.5 ${current ? "bg-s3/70" : ""}`}>
      <Button onClick={() => onPick(item.url)} disabled={disabled} className="flex-1 min-w-0 text-left pressable disabled:opacity-60">
        <div className="flex items-center gap-1.5 text-[14px] text-on">
          <span className="truncate">{item.name || item.host || hostOf(item.url)}</span>
          {current && <ICheck size={13} className="text-mint shrink-0" />}
        </div>
        <div className="text-[12px] text-mut truncate mt-0.5">{item.url}</div>
      </Button>
      <span
        title={probe ? (probe.error || (probe.status ? `HTTP ${probe.status}` : "")) : ""}
        className={`text-[12px] tabular-nums shrink-0 ${probe ? (probe.ok ? "text-mint" : "text-danger") : "text-dim"}`}>
        {busy ? "…" : probe ? (probe.ok ? `${probe.ms}ms` : probe.status ? `HTTP ${probe.status}` : "Failed") : "—"}
      </span>
      <Button onClick={() => onProbe(item.url)} disabled={busy || disabled}
        className="shrink-0 h-7 px-2.5 rounded-(--r-sm) bg-s4 text-[12px] text-on/80 pressable disabled:opacity-50">Test</Button>
    </div>
  );
}

function GroupHead({ title, hint, actions }: { title: string; hint: string; actions?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-1 mt-4 mb-1.5 first:mt-1">
      <span className="text-[12px] font-semibold text-dim tracking-wide shrink-0">{title}</span>
      <span className="text-[12px] text-dim truncate min-w-0 flex-1">{hint}</span>
      {actions && <div className="ml-auto shrink-0 flex items-center gap-2.5">{actions}</div>}
    </div>
  );
}

export default function LinePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast, user, setUser } = useStore();
  const [state, setState] = useState<LineState | null>(null);
  const [mirrors, setMirrors] = useState<LineItem[] | null>(null);
  const [recommended, setRecommended] = useState<LineItem[] | null>(null);
  const [mirrorErr, setMirrorErr] = useState("");
  const [loadingMirrors, setLoadingMirrors] = useState(false);
  const [probes, setProbes] = useState<ProbeMap>({});
  const [probing, setProbing] = useState("");
  const [switching, setSwitching] = useState("");
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState("");
  const [stateError, setStateError] = useState("");
  const [ready, setReady] = useState(false);
  const stateRequest = useRef(0);
  const applying = useRef(false);

  const readState = (fillDraft = false) => {
    const request = ++stateRequest.current;
    setStateError("");
    if (fillDraft) setReady(false);
    api.lineState().then(next => {
      if (request !== stateRequest.current || applying.current) return;
      setState(next);
      setReady(true);
      if (fillDraft) setCustom(next.custom ? next.base : "");
    }).catch((e) => {
      if (request === stateRequest.current) {
        setReady(false);
        setStateError(errorMessage(e, "Failed to load endpoint state"));
      }
    });
  };

  const readMirrors = async () => {
    setLoadingMirrors(true);
    setMirrorErr("");
    try {
      const res = await api.lineMirrors();
      setMirrors(res?.items || []);
      setRecommended(res?.recommended || []);
    } catch (e) {
      setMirrors([]);
      setRecommended([]);
      setMirrorErr(errorMessage(e, "Failed to retrieve mirror endpoints"));
    } finally {
      setLoadingMirrors(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    readState(true);
    setCustomError("");
    if (mirrors === null) void readMirrors();
    return () => { stateRequest.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const sync = () => readState();
    window.addEventListener("hg:line-changed", sync);
    return () => window.removeEventListener("hg:line-changed", sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const probe = async (list: LineItem[], key: string) => {
    if (!list.length) return;
    setProbing(key);
    try {
      const res = await api.lineProbe(list.map((x) => x.url));
      setProbes((p) => {
        const next = { ...p };
        for (const r of res) next[r.url] = r;
        return next;
      });
    } catch (e) {
      toast(errorMessage(e, "Probe failed"), "info");
    } finally {
      setProbing("");
    }
  };

  const applyLine = async (key: string, apply: () => Promise<LineApply>) => {
    if (applying.current || !ready) return;
    const wasAuto = autoLineEnabled();
    applying.current = true;
    stateRequest.current++;
    setSwitching(key);
    setCustomError("");
    try {
      await setAutoLine(false);
      const next = await apply();
      tracePlayback("line.manual", { line: hostOf(next.base), prev: hostOf(state?.base ?? ""), custom: next.custom, ok: true });
      if (next.base !== state?.base && (!user || (user.user_type !== "firebase" && user.user_type !== "offline"))) {
        setUser(null);
      }
      setState((s) => (s ? { ...s, ...next } : s));
      if (key === "custom" || key === "reset") setCustom(next.custom ? next.base : "");
      toast(`Endpoint switched to ${hostOf(next.base)}`, "ok");
      window.dispatchEvent(new Event("hg:line-changed"));
    } catch (e) {
      if (wasAuto) void setAutoLine(true);
      const error = errorMessage(e, "Failed to switch endpoint");
      tracePlayback("line.manual", { ok: false, err: error });
      if (key === "custom" || key === "reset") setCustomError(error);
      else toast(error, "info");
    } finally {
      applying.current = false;
      setSwitching("");
    }
  };

  const pick = (url: string) => {
    if (state?.base === url) return;
    void applyLine(url, async () => ({ base: await api.lineSet(url), custom: false }));
  };
  const saveCustom = () => {
    const raw = custom.trim();
    try {
      const url = new URL(raw);
      if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error();
    } catch {
      setCustomError("Please enter a valid HTTPS origin URL (e.g. https://mirror.example.com)");
      return;
    }
    void applyLine("custom", () => api.lineCustomSet(raw));
  };

  const fixed = state?.fixed || [];
  const busyAll = !!probing || !!switching || !ready;
  const close = () => { if (!applying.current) onClose(); };

  const body = (
    <div className="flex flex-col min-h-0" style={{ maxHeight: isMobile ? "min(76dvh, calc(100dvh - 24px))" : "min(72dvh, 620px)" }}>
      <div className="shrink-0 flex items-center gap-2 px-4 pt-3 pb-2">
        <span className="w-8 h-8 rounded-full bg-s3 flex items-center justify-center text-primary"><ISettings size={16} /></span>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-bold text-on leading-tight">Streaming Endpoints</div>
          <div className="text-[12px] text-mut mt-0.5 truncate">Current: {state ? hostOf(state.base) : "Loading…"}</div>
        </div>
        <Button onClick={close} disabled={!!switching} aria-label="Close" className="min-w-12 min-h-12 rounded-full bg-s3/80 flex items-center justify-center text-mut pressable"><IClose size={16} /></Button>
      </div>

      <div className="flex-1 scroll-y px-3 pb-4">
        {stateError && <div role="alert" className="text-[13px] text-danger px-1">
          {stateError}<Button className="min-h-12 px-3 text-primary" onClick={() => readState(true)}>Reload</Button>
        </div>}
        <GroupHead title="Custom Mirror" hint="Manual endpoint configuration" />
        <Surface className="rounded-(--r-md) bg-s2 px-3.5 py-3">
          <form onSubmit={event => { event.preventDefault(); saveCustom(); }}>
            <label htmlFor="custom-line-address" className="block text-[14px] text-on mb-2">Endpoint URL</label>
            <Input id="custom-line-address" aria-label="Endpoint URL" value={custom} disabled={busyAll}
              className="min-h-12 w-full min-w-0 text-[16px]" type="url" inputMode="url" autoCapitalize="none" autoComplete="off" spellCheck={false}
              placeholder="https://mirror.example.com" aria-invalid={!!customError}
              aria-describedby={`custom-line-hint${customError ? " custom-line-error" : ""}`}
              onChange={event => { setCustom(event.target.value); setCustomError(""); }} />
            <p id="custom-line-hint" className="text-[12px] text-mut leading-relaxed mt-2">Enter a trusted HTTPS endpoint. Streaming requests will route through this host.</p>
            {customError && <p id="custom-line-error" role="alert" className="text-[13px] text-danger break-words mt-2">{customError}</p>}
            <div className="flex gap-2 mt-3">
              <Button variant="secondary" disabled={busyAll} onClick={() => { void applyLine("reset", api.lineReset); }} className="min-h-12 px-3 flex-1">{switching === "reset" ? "Resetting…" : "Reset to Official"}</Button>
              <Button variant="primary" disabled={busyAll} type="submit" className="min-h-12 px-3 flex-1">{switching === "custom" ? "Saving…" : "Save Mirror"}</Button>
            </div>
          </form>
        </Surface>
        <GroupHead
          title="Direct Endpoints"
          hint="Global & CDN routes"
          actions={
            <Button onClick={() => probe(fixed, "fixed")} disabled={busyAll || !fixed.length}
              className="ios-compact text-[12px] text-primary pressable disabled:opacity-50">
              {probing === "fixed" ? "Testing…" : "Test All"}
            </Button>
          }
        />
        <Surface className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {fixed.map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} disabled={busyAll} onPick={pick} onProbe={(u) => probe([{ url: u }], u)} />
          ))}
          {!fixed.length && <div className="px-3.5 py-3 text-[12px] text-mut">Loading…</div>}
        </Surface>

        <GroupHead
          title="Recommended Mirrors"
          hint="Verified active servers"
          actions={
            recommended?.length ? (
              <Button onClick={() => probe(recommended, "recommended")} disabled={busyAll}
                className="ios-compact text-[12px] text-primary pressable disabled:opacity-50">
                {probing === "recommended" ? "Testing…" : `Test All (${recommended.length})`}
              </Button>
            ) : undefined
          }
        />
        <Surface className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {loadingMirrors && <div className="flex justify-center py-6"><Loader className="w-6 h-6 spinner" /></div>}
          {!loadingMirrors && !recommended?.length && (
            <div className="px-3.5 py-3 text-[12px] text-mut">No recommended mirrors found</div>
          )}
          {!loadingMirrors && (recommended || []).map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} disabled={busyAll} onPick={pick} onProbe={(u) => probe([{ url: u }], u)} />
          ))}
        </Surface>

        <GroupHead
          title="Community Mirrors"
          hint="Alternate networks"
          actions={
            <>
              <Button onClick={() => { void readMirrors(); }} disabled={loadingMirrors}
                className="ios-compact inline-flex items-center gap-1 text-[12px] text-primary pressable disabled:opacity-50">
                <IRefresh size={12} />{loadingMirrors ? "Fetching…" : "Refresh"}
              </Button>
              {!!mirrors?.length && (
                <Button onClick={() => probe(mirrors, "mirrors")} disabled={busyAll}
                  className="ios-compact text-[12px] text-primary pressable disabled:opacity-50">
                  {probing === "mirrors" ? "Testing…" : `Test All (${mirrors.length})`}
                </Button>
              )}
            </>
          }
        />
        <Surface className="rounded-(--r-md) bg-s2 divide-y divide-s3 overflow-hidden">
          {loadingMirrors && <div className="flex justify-center py-6"><Loader className="w-6 h-6 spinner" /></div>}
          {!loadingMirrors && mirrorErr && (
            <div className="px-3.5 py-3">
              <div className="text-[12px] text-danger">Failed to retrieve mirrors</div>
              <div className="text-[12px] text-mut mt-1 break-all">{mirrorErr}</div>
            </div>
          )}
          {!loadingMirrors && !mirrorErr && mirrors?.length === 0 && (
            <div className="px-3.5 py-3 text-[12px] text-mut">No community mirrors available</div>
          )}
          {!loadingMirrors && (mirrors || []).map((it) => (
            <Row key={it.url} item={it} current={state?.base === it.url} probe={probes[it.url]}
              busy={probing === it.url} disabled={busyAll} onPick={pick} onProbe={(u) => probe([{ url: u }], u)} />
          ))}
        </Surface>

        <div className="text-[12px] text-dim leading-relaxed px-1 mt-4">
          Endpoint switching updates immediately. To configure automatic health routing, visit Settings → Network → Auto-select Endpoint.
        </div>
      </div>
    </div>
  );

  return isMobile
    ? <Sheet open={open} onClose={close} label="Select Streaming Source">{body}</Sheet>
    : <Modal open={open} onClose={close} label="Select Streaming Source" width={460}>{body}</Modal>;
}
