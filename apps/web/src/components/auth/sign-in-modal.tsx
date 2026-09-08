"use client";

import { useEffect, useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { motion, type Transition } from "motion/react";
import { X, Loader2, Check, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const MIN_PASSWORD_LENGTH = 8;

const BACKDROP_TRANSITION: Transition = { duration: 0.2, ease: "easeOut" };
const PANEL_TRANSITION: Transition = {
  duration: 0.25,
  ease: [0.16, 1, 0.3, 1],
};

const GoogleIcon = () => (
  <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true">
    <path
      fill="#4285F4"
      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
    />
    <path
      fill="#34A853"
      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
    />
    <path
      fill="#FBBC05"
      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
    />
    <path
      fill="#EA4335"
      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
    />
  </svg>
);

type SignInModalProps = {
  signedInEmail: string | null;
  onSignedIn: (email: string) => void;
  onSignedOut: () => void;
  onClose: () => void;
};

type SubmitMode = "google" | "email" | null;

export function SignInModal({
  signedInEmail,
  onSignedIn,
  onSignedOut,
  onClose,
}: SignInModalProps) {
  const [submitMode, setSubmitMode] = useState<SubmitMode>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !success && !submitMode) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, success, submitMode]);

  const handleGoogle = async () => {
    if (submitMode) return;
    setSubmitMode("google");
    setError(null);
    try {
      const res = await signIn("google", { redirect: false });
      // with redirect:false, signIn never navigates: it returns the provider
      // authorization url and the app must send the browser there itself.
      // failing to do so was the old "mock": the modal claimed success while
      // Google was never contacted.
      if (res?.error || !res?.url) {
        setSubmitMode(null);
        setError("couldn't sign you in — try again");
        return;
      }
      window.location.assign(res.url);
    } catch {
      setSubmitMode(null);
      setError("couldn't sign you in — try again");
    }
  };

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitMode) return;
    setError(null);
    const trimmedEmail = email.trim();
    if (!EMAIL_RE.test(trimmedEmail)) {
      setError("enter a valid email address");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    setSubmitMode("email");
    try {
      const res = await signIn("credentials", {
        redirect: false,
        email: trimmedEmail,
        password,
      });
      if (res?.error) {
        setSubmitMode(null);
        setError("invalid email or password");
        return;
      }
      onSignedIn(trimmedEmail);
      setSuccess(true);
      setTimeout(onClose, 900);
    } catch {
      setSubmitMode(null);
      setError("couldn't sign you in — try again");
    }
  };

  const handleSignOut = async () => {
    if (submitMode) return;
    setSubmitMode("email");
    try {
      await signOut({ redirect: false });
      onSignedOut();
      onClose();
    } catch {
      setSubmitMode(null);
      setError("couldn't sign you out — try again");
    }
  };

  if (signedInEmail) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <motion.div
          className="absolute inset-0 bg-neutral-900/25 backdrop-blur-sm dark:bg-black/50"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={BACKDROP_TRANSITION}
          onClick={onClose}
        />
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label="Account"
          className="relative w-full max-w-sm bg-white rounded-2xl border border-neutral-200 shadow-sm p-6 flex flex-col gap-4 dark:bg-neutral-900 dark:border-neutral-800"
          initial={{ opacity: 0, scale: 0.96, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 10 }}
          transition={PANEL_TRANSITION}
        >
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-3 right-3 p-1.5 rounded-full text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-all duration-200 dark:hover:text-neutral-200 dark:hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </button>
          <div className="flex flex-col items-center gap-1 pt-2">
            <motion.div
              className="size-12 rounded-full bg-emerald-50 flex items-center justify-center dark:bg-emerald-500/10"
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 18 }}
            >
              <Check className="w-6 h-6 text-emerald-600" />
            </motion.div>
            <p className="mt-2 text-sm font-medium tracking-tight text-neutral-900 dark:text-neutral-50">
              signed in as {signedInEmail}
            </p>
            <p className="text-xs text-neutral-500 text-center dark:text-neutral-400">
              your agents are saved to this account
            </p>
          </div>
          <button
            onClick={handleSignOut}
            disabled={submitMode !== null}
            className="mt-2 flex items-center w-full justify-center gap-2 min-h-8 tracking-[-0.022em] min-w-fit py-2 px-5 text-black bg-black/10 rounded-full hover:scale-102 active:scale-98 transition-all dark:text-white dark:bg-white/10"
          >
            {submitMode === "email" ? (
              <Loader2 className="w-4 h-4 animate-spin mx-auto" />
            ) : (
              "sign out"
            )}
          </button>
        </motion.div>
      </div>
    );
  }

  const emailLoading = submitMode === "email";
  const googleLoading = submitMode === "google";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        className="absolute inset-0 bg-neutral-900/25 backdrop-blur-sm dark:bg-black/50"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={BACKDROP_TRANSITION}
        onClick={() => !submitMode && onClose()}
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label="Sign in"
        className="relative w-full max-w-sm bg-white rounded-2xl border border-neutral-200 shadow-lg shadow-black/5 p-6 flex flex-col gap-4 dark:bg-neutral-900 dark:border-neutral-800"
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        transition={PANEL_TRANSITION}
      >
        <button
          onClick={() => !submitMode && onClose()}
          aria-label="Close"
          className="absolute top-3 right-3 p-1.5 rounded-full text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 transition-all duration-200 dark:hover:text-neutral-200 dark:hover:bg-white/10"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-medium tracking-tight text-neutral-900 dark:text-neutral-50">
            sign in
          </h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            your agents are saved to this account
          </p>
        </div>

        <button
          onClick={handleGoogle}
          disabled={submitMode !== null}
          className={cn(
            "w-full flex items-center justify-center gap-2 rounded-full border border-neutral-200 bg-white px-4 py-2.5 text-sm font-medium tracking-tight text-neutral-800 transition-all duration-200 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100",
            submitMode === null &&
              "hover:bg-neutral-50 hover:scale-102 active:scale-98 dark:hover:bg-white/5",
            submitMode === "email" && "opacity-50 cursor-not-allowed",
          )}
        >
          {googleLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <GoogleIcon />
          )}
          {googleLoading ? "signing in…" : "continue with google"}
        </button>

        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
          <span className="text-xs text-neutral-400">or</span>
          <div className="h-px flex-1 bg-neutral-200 dark:bg-neutral-800" />
        </div>

        <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="signin-email"
              className="text-xs font-medium text-neutral-600 dark:text-neutral-400"
            >
              email
            </label>
            <input
              id="signin-email"
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitMode !== null}
              placeholder="you@example.com"
              className="w-full font-medium rounded-2xl border border-neutral-200 px-3.5 py-2.5 text-sm tracking-[-0.01em] placeholder-neutral-400 outline-none focus:border-neutral-400 transition-colors disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50 dark:placeholder-neutral-500 dark:focus:border-neutral-500"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="signin-password"
              className="text-xs font-medium text-neutral-600 dark:text-neutral-400"
            >
              password
            </label>
            <input
              id="signin-password"
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitMode !== null}
              placeholder="••••••••"
              className="w-full font-medium rounded-2xl border border-neutral-200 px-3.5 py-2.5 text-sm tracking-[-0.01em] placeholder-neutral-400 outline-none focus:border-neutral-400 transition-colors disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-50 dark:placeholder-neutral-500 dark:focus:border-neutral-500"
            />
          </div>

          {error && (
            <p className="text-xs text-rose-600 font-medium dark:text-rose-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitMode !== null}
            className={cn(
              "w-full flex items-center justify-center gap-2 rounded-full bg-neutral-900 px-4 py-2.5 text-sm font-medium tracking-tight text-white transition-all duration-200 dark:bg-white dark:text-black",
              submitMode === null && "hover:scale-102 active:scale-98",
              submitMode === "google" && "opacity-50 cursor-not-allowed",
            )}
          >
            {emailLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <>
                continue
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <p className="text-[11px] text-neutral-400 text-center">
          signing in saves your existing agents to your account
        </p>
      </motion.div>
    </div>
  );
}
