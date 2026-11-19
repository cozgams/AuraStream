import { Button, Form, Input, SegmentedControl } from "./ios/controls";
import { Loader } from "./ios/effects";
import { useId, useState } from "react";
import { api, isMobile } from "../api";
import type { User } from "../types";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { IClose, ILogin } from "../icons";
import { localizeError } from "../i18n";

export default function LoginModal() {
  const { loginOpen, setLoginOpen, setUser, toast } = useStore();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const errorId = useId();

  const title = mode === "login" ? "Sign In to AuraStream" : "Register for AuraStream";
  const submit = async () => {
    if (busy) return;
    if (!username.trim() || !password) { setErr("Please enter username and password"); return; }
    setBusy(true); setErr("");
    try {
      const result = mode === "login" ? await api.login(username.trim(), password) : await api.register(username.trim(), password, email.trim());
      setUser(result.user as User); setPassword(""); setLoginOpen(false);
      toast(mode === "login" ? `Welcome back, ${result.user?.nickname || username}` : "Registration successful", "ok");
    } catch (error) { setErr(localizeError(error)); }
    finally { setBusy(false); }
  };
  const content = <div className="ios-auth">
    <div className="ios-dialog-heading"><span className="ios-heading-icon"><ILogin size={21} /></span><h2>{title}</h2>
      <Button className="ios-icon-button" aria-label="Close" onClick={() => setLoginOpen(false)}><IClose size={19} /></Button>
    </div>
    <p className="ios-description">Sign in to sync likes, favorites, and history across devices.</p>
    <SegmentedControl className="ios-auth-tabs" aria-label="Account Action" activeIndex={mode === "login" ? 0 : 1}>
      {([ ["login", "Sign In"], ["register", "Register"] ] as const).map(([key, label]) => <Button key={key}
        aria-pressed={mode === key} onClick={() => { setMode(key); setErr(""); }}>{label}</Button>)}
    </SegmentedControl>
    <Form className="ios-auth-form" aria-busy={busy} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label className="ios-field"><span>Username</span><Input aria-label="Username" data-autofocus autoComplete="username" name="username" placeholder="Enter username" value={username}
        onChange={event => setUsername(event.target.value)} aria-invalid={!!err} aria-describedby={err ? errorId : undefined} /></label>
      <label className="ios-field"><span>Password</span><Input aria-label="Password" autoComplete={mode === "login" ? "current-password" : "new-password"} name="password" type="password"
        placeholder="Enter password" value={password} onChange={event => setPassword(event.target.value)} aria-invalid={!!err} aria-describedby={err ? errorId : undefined} /></label>
      {mode === "register" && <label className="ios-field"><span>Email <small>Optional</small></span><Input aria-label="Email" type="email" autoComplete="email" name="email"
        placeholder="For account recovery" value={email} onChange={event => setEmail(event.target.value)} /></label>}
      {err && <p id={errorId} role="alert" className="ios-field-error">{err}</p>}
      <Button variant="primary" className="ios-auth-submit" type="submit" disabled={busy}>
        {busy && <Loader className="size-5" />}{busy ? "Processing…" : mode === "login" ? "Sign In" : "Create Account"}
      </Button>
    </Form>
    <p className="ios-description ios-auth-note">Login sessions are bound to the current endpoint. When switching custom mirrors, sign-in is managed per endpoint.</p>
  </div>;
  return isMobile ? <Sheet open={loginOpen} onClose={() => setLoginOpen(false)} label={title}>{content}</Sheet>
    : <Modal open={loginOpen} onClose={() => setLoginOpen(false)} label={title} width={440}>{content}</Modal>;
}
