import { Button, Form, Input, SegmentedControl } from "./ios/controls";
import { Loader } from "./ios/effects";
import { useEffect, useId, useState } from "react";
import { isMobile } from "../api";
import type { User } from "../types";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { IClose, ILogin } from "../icons";
import {
  isUsingPlaceholderFirebaseConfig,
  signInWithEmail,
  signUpWithEmail,
  sendPasswordReset,
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
  if (
    code === "auth/invalid-api-key" ||
    code.startsWith("auth/api-key-not-valid") ||
    msg.includes("api-key-not-valid")
  ) {
    return "Firebase project not configured. Tap 'Save as Local Profile' to use your account offline.";
  }
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
  const errorId = useId();
  const placeholderFirebase = isUsingPlaceholderFirebaseConfig();

  useEffect(() => {
    if (!loginOpen) {
      setErr("");
      setPassword("");
    }
  }, [loginOpen]);

  const title =
    mode === "login"
      ? "Sign In with Email"
      : mode === "register"
      ? "Create Account"
      : "Reset Password";

  const handleSaveLocalProfile = () => {
    const cleanEmail = email.trim();
    if (!cleanEmail || !cleanEmail.includes("@")) {
      setErr("Please enter a valid email address to save your profile.");
      return;
    }
    const localUser: User = {
      id: hashUid(cleanEmail),
      username: cleanEmail.split("@")[0] || "User",
      nickname: nickname.trim() || cleanEmail.split("@")[0] || "User",
      avatar: "",
      avatar_color: "#1a73e8",
      sign: "Local Offline Profile",
      desc: cleanEmail,
      user_type: "offline",
    };
    setUser(localUser);
    setPassword("");
    setLoginOpen(false);
    toast(`Active profile: ${localUser.nickname} (Local Storage)`, "ok");
  };

  const submit = async () => {
    if (busy) return;
    setErr("");

    if (mode === "reset") {
      if (!email.trim() || !email.includes("@")) {
        setErr("Please enter a valid email address.");
        return;
      }
      setBusy(true);
      try {
        await sendPasswordReset(email.trim());
        toast("Password reset email sent to your inbox", "ok");
        setMode("login");
      } catch (error) {
        setErr(localizeFirebaseError(error));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!email.trim() || !email.includes("@")) {
      setErr("Please enter a valid email address.");
      return;
    }
    if (!password || password.length < 6) {
      setErr("Password must be at least 6 characters long.");
      return;
    }

    setBusy(true);
    try {
      const fbUser =
        mode === "login"
          ? await signInWithEmail(email.trim(), password)
          : await signUpWithEmail(email.trim(), password, nickname.trim() || email.split("@")[0]);

      if (fbUser) {
        const userObj: User = {
          id: hashUid(fbUser.uid || email),
          username: fbUser.email?.split("@")[0] || "User",
          nickname: fbUser.displayName || nickname.trim() || fbUser.email?.split("@")[0] || "User",
          avatar: fbUser.photoURL || "",
          avatar_color: "#1a73e8",
          sign: "Firebase Cloud Sync Active",
          desc: fbUser.email || "",
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
            : "Account registered and synced with Firebase",
          "ok"
        );
      }
    } catch (error) {
      setErr(localizeFirebaseError(error));
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <div className="ios-auth max-h-[82dvh] overflow-y-auto overscroll-contain px-5 py-6 sm:px-7 sm:py-7">
      <div className="ios-dialog-heading">
        <span className="ios-heading-icon">
          <ILogin size={21} />
        </span>
        <h2>{title}</h2>
        <Button className="ios-icon-button" aria-label="Close" onClick={() => setLoginOpen(false)}>
          <IClose size={19} />
        </Button>
      </div>

      <p className="ios-description">
        {mode === "reset"
          ? "Enter your registered email address to receive password reset instructions."
          : "Sign in with your email to sync your favorites and watch history across all your devices."}
      </p>

      {placeholderFirebase && (
        <p className="text-[12px] text-mut leading-relaxed mb-3">
          Cloud sync is not configured for this build. Enter an email to save a local offline profile or continue with your device library.
        </p>
      )}

      {/* Action Tabs: Sign In / Register / Reset */}
      <SegmentedControl
        className="ios-auth-tabs mb-4"
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
          }}
        >
          Reset
        </Button>
      </SegmentedControl>

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
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!err}
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
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!err}
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

        {email.trim() && (err || placeholderFirebase) && (
          <Button
            variant="secondary"
            type="button"
            disabled={busy}
            onClick={() => { if (!busy) handleSaveLocalProfile(); }}
            className="text-xs h-8 rounded-lg"
          >
            Save as Local Profile
          </Button>
        )}

        <Button variant="primary" className="ios-auth-submit mt-2" type="submit" disabled={busy}>
          {busy && <Loader className="size-5" />}
          {busy
            ? "Processing..."
            : mode === "login"
            ? "Sign In"
            : mode === "register"
            ? "Create Account"
            : "Send Password Reset"}
        </Button>

        <Button
          variant="secondary"
          className="ios-auth-submit mt-2"
          type="button"
          disabled={busy}
          onClick={() => {
            if (busy) return;
            setLoginOpen(false);
            toast("Using Local Library. Favorites and history are saved privately on this device.", "ok");
          }}
        >
          Continue with Local Library (Offline)
        </Button>
      </Form>

      <p className="ios-description ios-auth-note">
        AuraStream operates 100% locally by default. Account sign-in is optional and used for cross-device cloud sync.
      </p>
    </div>
  );

  return isMobile ? (
    <Sheet open={loginOpen} onClose={() => setLoginOpen(false)} label={title}>
      {content}
    </Sheet>
  ) : (
    <Modal open={loginOpen} onClose={() => setLoginOpen(false)} label={title} width={440}>
      {content}
    </Modal>
  );
}
