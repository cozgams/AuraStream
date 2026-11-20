import { Button, Form, Input, SegmentedControl } from "./ios/controls";
import { Loader } from "./ios/effects";
import { useId, useState } from "react";
import { api, isMobile } from "../api";
import type { User } from "../types";
import { useStore } from "../store";
import { Modal, Sheet } from "./ui";
import { IClose, ILogin } from "../icons";
import { localizeError } from "../i18n";
import {
  signInWithEmail,
  signUpWithEmail,
  sendPasswordReset,
  saveUserDataToCloud,
  loadUserDataFromCloud,
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
  const { loginOpen, setLoginOpen, setUser, toast, mergeCloudUserData, favs, watchLater, history } = useStore();
  const [provider, setProvider] = useState<"firebase" | "custom">("firebase");
  const [mode, setMode] = useState<"login" | "register" | "reset">("login");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const errorId = useId();

  const title =
    provider === "firebase"
      ? mode === "login"
        ? "Sign In with Email"
        : mode === "register"
        ? "Create Firebase Account"
        : "Reset Password"
      : mode === "login"
      ? "Sign In to Custom Mirror"
      : "Register on Custom Mirror";

  const submit = async () => {
    if (busy) return;
    setErr("");

    if (provider === "firebase") {
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

          // Restore and merge Cloud Firestore data
          try {
            const cloud = await loadUserDataFromCloud(fbUser.uid);
            if (cloud) {
              mergeCloudUserData(cloud);
            }
            await saveUserDataToCloud(fbUser.uid, {
              favorites: favs,
              watchLater: watchLater,
              history: history.map((h) => ({
                id: h.id,
                ep: h.ep,
                t: h.t,
                dur: h.dur,
                updatedAt: h.at,
                title: h.title,
                cover: h.cover,
              })),
            });
          } catch {
            // cloud sync non-fatal
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
    } else {
      // Custom server mirror auth
      if (!username.trim() || !password) {
        setErr("Please enter username and password.");
        return;
      }
      setBusy(true);
      try {
        const result =
          mode === "login"
            ? await api.login(username.trim(), password)
            : await api.register(username.trim(), password, email.trim());
        setUser(result.user as User);
        setPassword("");
        setLoginOpen(false);
        toast(
          mode === "login"
            ? `Welcome back, ${result.user?.nickname || username}`
            : "Registration successful",
          "ok"
        );
      } catch (error) {
        setErr(localizeError(error));
      } finally {
        setBusy(false);
      }
    }
  };

  const content = (
    <div className="ios-auth">
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
        {provider === "firebase"
          ? "Sign in with Email and Firebase to sync your favorites and history across all your devices."
          : "Sign in to custom server mirror endpoint."}
      </p>

      {/* Provider Selector: Firebase Email vs Custom Mirror */}
      <SegmentedControl
        className="ios-auth-tabs mb-3"
        aria-label="Authentication Provider"
        activeIndex={provider === "firebase" ? 0 : 1}
      >
        <Button
          aria-pressed={provider === "firebase"}
          onClick={() => {
            setProvider("firebase");
            setErr("");
          }}
        >
          Email & Firebase
        </Button>
        <Button
          aria-pressed={provider === "custom"}
          onClick={() => {
            setProvider("custom");
            setErr("");
            if (mode === "reset") setMode("login");
          }}
        >
          Custom Mirror
        </Button>
      </SegmentedControl>

      {/* Action Tabs: Sign In / Register / Reset */}
      <SegmentedControl
        className="ios-auth-tabs"
        aria-label="Account Action"
        activeIndex={mode === "login" ? 0 : mode === "register" ? 1 : 2}
      >
        <Button
          aria-pressed={mode === "login"}
          onClick={() => {
            setMode("login");
            setErr("");
          }}
        >
          Sign In
        </Button>
        <Button
          aria-pressed={mode === "register"}
          onClick={() => {
            setMode("register");
            setErr("");
          }}
        >
          Register
        </Button>
        {provider === "firebase" && (
          <Button
            aria-pressed={mode === "reset"}
            onClick={() => {
              setMode("reset");
              setErr("");
            }}
          >
            Reset
          </Button>
        )}
      </SegmentedControl>

      <Form
        className="ios-auth-form"
        aria-busy={busy}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {provider === "firebase" ? (
          <>
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
          </>
        ) : (
          <>
            <label className="ios-field">
              <span>Username</span>
              <Input
                aria-label="Username"
                autoComplete="username"
                name="username"
                placeholder="Enter username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                aria-invalid={!!err}
                aria-describedby={err ? errorId : undefined}
              />
            </label>
            <label className="ios-field">
              <span>Password</span>
              <Input
                aria-label="Password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                name="password"
                type="password"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!err}
                aria-describedby={err ? errorId : undefined}
              />
            </label>
            {mode === "register" && (
              <label className="ios-field">
                <span>Email <small>Optional</small></span>
                <Input
                  aria-label="Email"
                  type="email"
                  autoComplete="email"
                  name="email"
                  placeholder="For account recovery"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
            )}
          </>
        )}

        {err && (
          <p id={errorId} role="alert" className="ios-field-error">
            {err}
          </p>
        )}

        <Button variant="primary" className="ios-auth-submit" type="submit" disabled={busy}>
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
          onClick={() => {
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
