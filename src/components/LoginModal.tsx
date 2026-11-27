import { Button, Form, Input, SegmentedControl, TextArea } from "./ios/controls";
import { Loader } from "./ios/effects";
import { useEffect, useId, useState } from "react";
import { isMobile } from "../api";
import type { User } from "../types";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { ICheck, IClose, ILogin } from "../icons";
import {
  clearFirebaseConfig,
  getStoredConfig,
  isUsingPlaceholderFirebaseConfig,
  saveFirebaseConfig,
  signInWithEmail,
  signUpWithEmail,
  sendPasswordReset,
  type FirebaseConfig,
} from "../firebase";

function hashUid(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash) || 10001;
}

function localizeFirebaseError(err: unknown): string {
  const code = (err as { code?: string })?.code || "";
  const msg = (err as Error)?.message || String(err || "");
  switch (code) {
    case "auth/user-not-found":
      return "No account found with this email.";
    case "auth/wrong-password":
    case "auth/invalid-credential":
      return "Incorrect email or password.";
    case "auth/email-already-in-use":
      return "An account with this email already exists.";
    case "auth/weak-password":
      return "Password should be at least 6 characters long.";
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/network-request-failed":
      return "Network connection failed. Please check your internet connection.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a few moments and try again.";
    default:
      return msg.replace(/^Firebase:\s*/i, "") || "Authentication failed. Please retry.";
  }
}

export default function LoginModal() {
  const { loginOpen, setLoginOpen, setUser, toast, hydrateCloudForUid } = useStore();
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [errField, setErrField] = useState<"email" | "password" | "general" | null>(null);
  const [showCustomConfig, setShowCustomConfig] = useState(false);
  const [customConfigJson, setCustomConfigJson] = useState("");
  const [customConnected, setCustomConnected] = useState(() => !isUsingPlaceholderFirebaseConfig());
  const errorId = useId();

  useEffect(() => {
    if (!loginOpen) {
      setMode("login");
      setErr("");
      setErrField(null);
      setPassword("");
      setShowCustomConfig(false);
    } else {
      setCustomConnected(!isUsingPlaceholderFirebaseConfig());
    }
  }, [loginOpen]);

  const title =
    mode === "login"
      ? "Sign In with Email"
      : mode === "register"
      ? "Create Account"
      : "Reset Password";

  const handleApplyCustomFirebase = () => {
    const trimmed = customConfigJson.trim();
    if (!trimmed) {
      setErr("Paste your Firebase Web Config JSON (with apiKey, projectId, appId).");
      setErrField("general");
      return;
    }
    try {
      // Allow either strict JSON or JS object snippet pasted from Firebase console
      const rawBlock = trimmed.replace(/^[^{]*(\{[\s\S]*\})[^}]*$/, "$1");
      const jsonReady = rawBlock
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner: string) =>
          JSON.stringify(inner.replace(/\\'/g, "'"))
        )
        .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
        .replace(/,\s*([}\]])/g, "$1");
      const parsed = JSON.parse(jsonReady) as Partial<FirebaseConfig>;
      if (!parsed.apiKey || !parsed.projectId) {
        setErr("Config must include at least apiKey and projectId.");
        setErrField("general");
        return;
      }
      const cfg: FirebaseConfig = {
        apiKey: String(parsed.apiKey).trim(),
        authDomain: String(parsed.authDomain || `${parsed.projectId}.firebaseapp.com`).trim(),
        projectId: String(parsed.projectId).trim(),
        storageBucket: parsed.storageBucket ? String(parsed.storageBucket).trim() : `${parsed.projectId}.appspot.com`,
        messagingSenderId: parsed.messagingSenderId ? String(parsed.messagingSenderId).trim() : "",
        appId: String(parsed.appId || "1:000000000000:web:aurastream").trim(),
      };
      const res = saveFirebaseConfig(cfg);
      if (res?.auth) {
        setCustomConnected(true);
        setShowCustomConfig(false);
        setErr("");
        setErrField(null);
        toast(`Connected to Firebase project: ${cfg.projectId}`, "ok");
      } else {
        setErr("Could not initialize Firebase with the provided config.");
        setErrField("general");
      }
    } catch {
      setErr("Invalid JSON format. Copy the firebaseConfig object from Firebase Console.");
      setErrField("general");
    }
  };

  const submit = async () => {
    if (busy) return;
    setErr("");
    setErrField(null);

    const cleanEmail = email.trim();

    if (mode === "reset") {
      if (!cleanEmail || !cleanEmail.includes("@")) {
        setErr("Please enter a valid email address.");
        setErrField("email");
        return;
      }
      setBusy(true);
      try {
        await sendPasswordReset(cleanEmail);
        toast("Password reset complete. You can now sign in with a new password.", "ok");
        setMode("login");
      } catch (error) {
        setErr(localizeFirebaseError(error));
        setErrField("general");
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!cleanEmail || !cleanEmail.includes("@")) {
      setErr("Please enter a valid email address.");
      setErrField("email");
      return;
    }
    if (!password || password.length < 6) {
      setErr("Password must be at least 6 characters long.");
      setErrField("password");
      return;
    }

    setBusy(true);
    try {
      const fbUser =
        mode === "login"
          ? await signInWithEmail(cleanEmail, password)
          : await signUpWithEmail(cleanEmail, password, nickname.trim() || cleanEmail.split("@")[0]);

      if (fbUser) {
        const resolvedNick =
          (mode === "register" ? nickname.trim() : "") ||
          fbUser.displayName ||
          fbUser.email?.split("@")[0] ||
          cleanEmail.split("@")[0] ||
          "User";
        const userObj: User = {
          id: hashUid(fbUser.uid || cleanEmail),
          username: fbUser.email?.split("@")[0] || cleanEmail.split("@")[0] || "User",
          nickname: resolvedNick,
          avatar: fbUser.photoURL || "",
          avatar_color: "#1a73e8",
          sign: customConnected ? "Firebase Cloud Sync Active" : "Account Synced",
          desc: fbUser.email || cleanEmail,
          user_type: "firebase",
        };
        setUser(userObj);
        setPassword("");
        setLoginOpen(false);

        if (fbUser.uid) {
          void hydrateCloudForUid(fbUser.uid);
        }

        toast(
          mode === "login"
            ? `Welcome back, ${userObj.nickname}`
            : `Account created. Welcome, ${userObj.nickname}`,
          "ok"
        );
      }
    } catch (error) {
      const message = localizeFirebaseError(error);
      setErr(message);
      setErrField(message.toLowerCase().includes("password") ? "password" : "general");
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <div className="ios-auth flex flex-col max-h-[84dvh] overflow-hidden">
      {/* Fixed Header & Tabs so top input is never clipped under sheet drag bar */}
      <div className="shrink-0 px-5 pt-5 pb-3 sm:px-7 sm:pt-6 border-b border-edge/30 bg-s1/95 backdrop-blur-md z-10">
        <div className="ios-dialog-heading">
          <span className="ios-heading-icon">
            <ILogin size={21} />
          </span>
          <h2>{title}</h2>
          <Button className="ios-icon-button" aria-label="Close" disabled={busy} onClick={() => { if (!busy) setLoginOpen(false); }}>
            <IClose size={19} />
          </Button>
        </div>

        <p className="ios-description mt-1.5">
          {mode === "reset"
            ? "Enter your email address to reset your account password."
            : "Sign in or create an account to save and sync your favorites, playlists, and watch history."}
        </p>

        {/* Action Tabs: Sign In / Register / Reset */}
        <SegmentedControl
          className="ios-auth-tabs mt-3"
          aria-label="Account Action"
          activeIndex={mode === "login" ? 0 : mode === "register" ? 1 : 2}
        >
          <Button
            disabled={busy}
            aria-pressed={mode === "login"}
            onClick={() => {
              if (busy) return;
              setMode("login");
              setErr("");
              setErrField(null);
            }}
          >
            Sign In
          </Button>
          <Button
            disabled={busy}
            aria-pressed={mode === "register"}
            onClick={() => {
              if (busy) return;
              setMode("register");
              setErr("");
              setErrField(null);
            }}
          >
            Register
          </Button>
          <Button
            disabled={busy}
            aria-pressed={mode === "reset"}
            onClick={() => {
              if (busy) return;
              setMode("reset");
              setErr("");
              setErrField(null);
            }}
          >
            Reset
          </Button>
        </SegmentedControl>
      </div>

      {/* Scrollable Form Body */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-7 sm:py-5">
        <Form
          className="ios-auth-form"
          aria-busy={busy}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="ios-field">
            <span>Email Address</span>
            <Input
              aria-label="Email"
              type="email"
              autoComplete="email"
              name="email"
              placeholder="name@example.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (errField === "email" || errField === "general") {
                  setErr("");
                  setErrField(null);
                }
              }}
              aria-invalid={errField === "email" || undefined}
              aria-describedby={err ? errorId : undefined}
            />
          </label>

          {mode !== "reset" && (
            <label className="ios-field">
              <span>Password</span>
              <Input
                aria-label="Password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                name="password"
                type="password"
                placeholder="Enter password (min 6 characters)"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (errField === "password" || errField === "general") {
                    setErr("");
                    setErrField(null);
                  }
                }}
                aria-invalid={errField === "password" || undefined}
                aria-describedby={err ? errorId : undefined}
              />
            </label>
          )}

          {mode === "register" && (
            <label className="ios-field">
              <span>Display Name <small>Optional</small></span>
              <Input
                aria-label="Display Name"
                type="text"
                autoComplete="nickname"
                name="nickname"
                placeholder="Your nickname"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
              />
            </label>
          )}

          {err && (
            <div className="flex flex-col gap-2 my-1">
              <p id={errorId} role="alert" className="ios-field-error">
                {err}
              </p>
            </div>
          )}

          <Button variant="primary" className="ios-auth-submit mt-2" type="submit" disabled={busy}>
            {busy && <Loader className="size-5" />}
            {busy
              ? "Processing..."
              : mode === "login"
              ? "Sign In"
              : mode === "register"
              ? "Create Account"
              : "Reset Password"}
          </Button>

          <Button
            variant="secondary"
            className="ios-auth-submit mt-2"
            type="button"
            disabled={busy}
            onClick={() => {
              if (busy) return;
              setLoginOpen(false);
            }}
          >
            Continue Without Account
          </Button>
        </Form>

        {/* Optional Custom Firebase Cloud Config Section */}
        <div className="mt-4 pt-3 border-t border-edge/25">
          <div className="flex items-center justify-between gap-2 flex-wrap text-[11.5px] text-mut">
            <span className="flex items-center gap-1.5 min-w-0 truncate">
              {customConnected ? (
                <>
                  <ICheck size={12} className="text-emerald-500 shrink-0" />
                  <span className="truncate">Custom Firebase Cloud: {getStoredConfig()?.projectId}</span>
                </>
              ) : (
                <span className="truncate">Built-in Account Vault Active</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => setShowCustomConfig((v) => !v)}
              className="text-primary font-semibold hover:underline pressable shrink-0 whitespace-nowrap"
            >
              {showCustomConfig ? "Hide Cloud Setup" : customConnected ? "Edit Firebase" : "Custom Firebase (Optional)"}
            </button>
          </div>

          {showCustomConfig && (
            <div className="mt-2.5 p-3 rounded-xl bg-s2 border border-edge/30 flex flex-col gap-2">
              <div className="text-[11.5px] text-mut leading-relaxed">
                Optional: Paste your own Firebase Web Config JSON from Firebase Console to sync across external devices via Firestore.
              </div>
              <TextArea
                rows={4}
                value={customConfigJson}
                onChange={(e) => setCustomConfigJson(e.target.value)}
                placeholder={'{"apiKey":"...","authDomain":"...","projectId":"...","appId":"..."}'}
                className="w-full p-2.5 rounded-lg bg-s3 text-[11.5px] font-mono text-on resize-none"
              />
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  onClick={handleApplyCustomFirebase}
                  className="flex-1 h-8 rounded-lg bg-primary text-on-primary text-[12px] font-semibold pressable"
                >
                  Connect Firebase Project
                </Button>
                {customConnected && (
                  <Button
                    type="button"
                    onClick={() => {
                      clearFirebaseConfig();
                      setCustomConnected(false);
                      setCustomConfigJson("");
                      toast("Reverted to built-in Account Vault", "info");
                    }}
                    className="px-3 h-8 rounded-lg bg-s3 text-[12px] text-mut pressable"
                  >
                    Reset
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        <p className="ios-description ios-auth-note mt-3">
          AuraStream saves your profile, favorites, and watch history immediately.
        </p>
      </div>
    </div>
  );

  return isMobile ? (
    <Sheet open={loginOpen} onClose={() => { if (!busy) setLoginOpen(false); }} label={title}>
      {content}
    </Sheet>
  ) : (
    <Modal open={loginOpen} onClose={() => { if (!busy) setLoginOpen(false); }} label={title} width={440}>
      {content}
    </Modal>
  );
}
