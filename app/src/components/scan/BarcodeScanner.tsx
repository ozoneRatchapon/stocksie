"use client";

// BarcodeScanner — camera-powered barcode reader for the `/scan` route
// (plan 006, Phase C).
//
// Wraps `html5-qrcode`'s `Html5Qrcode` class. The library is heavy and
// client-only (it touches `navigator.mediaDevices`), so this whole component
// is dynamically imported with `ssr: false` by `app/src/app/scan/page.tsx` —
// that keeps the scanner dep out of the `/` and `/shelf` First Load bundles.
//
// Lifecycle is parent-driven: the parent mounts <BarcodeScanner onScan={...} />
// when it wants a fresh scan, and unmounts (or changes `key`) to reset. We do
// NOT autostart the camera — a user gesture is required by some browsers, and
// on a desktop without a webcam the user should see an explicit "no camera"
// state rather than have the page fail silently on load. The component
// exposes a "Start camera" button; clicking it requests the back camera
// (`facingMode: "environment"`), begins scanning, and surfaces any failure
// (no camera / permission denied / insecure context) as a calm, specific
// message with a retry.
//
// On a successful decode we lock immediately (so the success callback can't
// fire twice for the same code), stop the camera to release the stream, then
// hand the code up via `onScan`. The parent decides what to do with it
// (lookup → known product card, or prefill the onboarding form).

import { useEffect, useId, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { Button } from "@/components/ui/Button";

export type BarcodeScannerProps = {
  /**
   * Fired exactly once per successful scan with the decoded barcode string.
   * The component stops the camera and resets to "idle" before calling this,
   * so the parent can safely unmount or remount it without leaking a stream.
   */
  onScan: (code: string) => void;
};

/** Coarse state machine for the scanner's camera lifecycle. */
type Status =
  // Initial — no camera requested yet. The "Start camera" button is shown.
  | { kind: "idle" }
  // `start()` is in flight. Spinner; no buttons.
  | { kind: "starting" }
  // Camera is live and scanning. Stop button shown.
  | { kind: "scanning" }
  // A terminal failure (no camera, permission denied, insecure context).
  // Retry button shown.
  | { kind: "error"; message: string };

/**
 * Camera-only barcode scanner. See {@link BarcodeScannerProps} and the file
 * header for the lifecycle contract.
 */
export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  // Stable, unique DOM id for the div `html5-qrcode` mounts its <video> into.
  // `useId` keeps multiple scanners on one page from colliding (defensive —
  // the UI only ever shows one at a time).
  const reactId = useId();
  const elementId = `stocksie-scanner-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const [status, setStatus] = useState<Status>({ kind: "idle" });

  // The live `Html5Qrcode` instance, held in a ref so the cleanup effect and
  // the stop handler can both reach it without re-rendering on assignment.
  const scannerRef = useRef<Html5Qrcode | null>(null);
  // True once we've already handled a successful decode for this mount —
  // guards against `html5-qrcode` firing the success callback repeatedly.
  const scannedRef = useRef(false);

  // -------------------------------------------------------------------------
  // Cleanup on unmount: stop the camera and clear the DOM. `stop()` returns a
  // Promise (it has to await track.stop()); swallow errors here because we're
  // tearing down anyway and a rejected stop shouldn't surface as an unhandled
  // rejection. This runs whenever the parent unmounts us (e.g. after onScan).
  // -------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (!scanner) return;
      // The library throws if you stop a scanner that's already stopped or
      // not started — both are fine during teardown.
      scanner
        .stop()
        .then(() => scanner.clear())
        .catch(() => {
          /* already stopped / clearing — fine during unmount */
        });
    };
  }, []);

  // -------------------------------------------------------------------------
  // Start the camera. Wrapped in a function (not an effect) so it's tied to
  // the user's "Start camera" gesture. On any failure we surface a specific
  // message: insecure context, no camera, permission denied, or unknown.
  // -------------------------------------------------------------------------
  const handleStart = async () => {
    if (scannerRef.current || status.kind === "starting") return;
    setStatus({ kind: "starting" });
    scannedRef.current = false;

    // Insecure context (HTTP, except localhost) → getUserMedia is unavailable.
    // Surfacing this distinctly saves the user a confusing "permission denied"
    // when the real problem is the page isn't HTTPS.
    if (typeof window !== "undefined" && !window.isSecureContext) {
      setStatus({
        kind: "error",
        message:
          "Camera access needs a secure (HTTPS) page. Open Stocksie over https:// or on localhost.",
      });
      return;
    }

    try {
      // Probe cameras before starting so we can give a specific "no camera"
      // message instead of letting `start()` reject with a generic error.
      const cameras = await Html5Qrcode.getCameras();
      if (!cameras || cameras.length === 0) {
        setStatus({
          kind: "error",
          message:
            "No camera found on this device. You can still type a barcode by hand below.",
        });
        return;
      }

      const scanner = new Html5Qrcode(elementId, {
        verbose: false,
        // Disable the experimental BarcodeDetector path — it isn't available
        // everywhere and the default ZXing-based decoder is reliable for
        // EAN/UPC, which is what household essentials carry.
        useBarCodeDetectorIfSupported: false,
      });
      scannerRef.current = scanner;

      await scanner.start(
        // Prefer the back camera (household goods are scanned from the back
        // camera on a phone). On a laptop with only a front webcam, the
        // constraint resolves to whatever's available.
        { facingMode: "environment" },
        { fps: 10 },
        (decodedText) => {
          // Lock against the library firing success repeatedly for the same
          // code in view. After the first decode, stop the camera and hand
          // the code up.
          if (scannedRef.current) return;
          scannedRef.current = true;
          // Stop first (releases the stream promptly), THEN call onScan so
          // the parent's state update doesn't race the camera teardown.
          scanner
            .stop()
            .then(() => scanner.clear())
            .catch(() => {
              /* tear-down errors are non-fatal */
            })
            .finally(() => {
              scannerRef.current = null;
              setStatus({ kind: "idle" });
              onScan(decodedText);
            });
        },
        // Per-frame decode failures are normal (most frames have no code in
        // view); ignore them so the console stays quiet.
        () => {
          /* per-frame non-decode — ignored */
        },
      );
      setStatus({ kind: "scanning" });
    } catch (err) {
      // Most likely permission denied or hardware error. Map a few known
      // shapes to friendlier copy; otherwise surface the raw message.
      scannerRef.current = null;
      const message = describeStartError(err);
      setStatus({ kind: "error", message });
    }
  };

  // -------------------------------------------------------------------------
  // Manual stop (the Stop button). Mirrors the cleanup path: stop, clear,
  // null the ref, reset state.
  // -------------------------------------------------------------------------
  const handleStop = async () => {
    const scanner = scannerRef.current;
    if (!scanner) {
      setStatus({ kind: "idle" });
      return;
    }
    try {
      await scanner.stop();
      scanner.clear();
    } catch {
      /* already stopped */
    } finally {
      scannerRef.current = null;
      setStatus({ kind: "idle" });
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {/* The mount point for html5-qrcode's <video>. Hidden until scanning so
          the empty div doesn't take layout space in the idle/error states. */}
      <div
        id={elementId}
        className={
          "overflow-hidden rounded-lg border border-stone-200 dark:border-slate-800 bg-white dark:bg-slate-950 " +
          (status.kind === "scanning" ? "block" : "hidden")
        }
        aria-hidden={status.kind !== "scanning"}
      />

      <ScannerControls
        status={status}
        onStart={handleStart}
        onStop={handleStop}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls — varies by status
// ---------------------------------------------------------------------------

type ScannerControlsProps = {
  status: Status;
  onStart: () => void;
  onStop: () => void;
};

function ScannerControls({ status, onStart, onStop }: ScannerControlsProps) {
  if (status.kind === "idle") {
    return (
      <Button onClick={onStart}>
        <span aria-hidden="true">📷</span>
        Start camera
      </Button>
    );
  }

  if (status.kind === "starting") {
    return (
      <Button loading disabled>
        Starting camera…
      </Button>
    );
  }

  if (status.kind === "scanning") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs text-stone-500 dark:text-slate-400">
          Point at a product barcode. It scans automatically.
        </p>
        <Button variant="ghost" onClick={onStop}>
          Stop camera
        </Button>
      </div>
    );
  }

  // error
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-50 dark:bg-amber-500/5 px-4 py-3">
      <p className="text-xs leading-relaxed text-amber-700/90 dark:text-amber-200/90">
        {status.message}
      </p>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onStart}>
          Try again
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/**
 * Translate an `html5-qrcode` start failure into a friendly message. The
 * library (and the underlying getUserMedia) throws a variety of shapes; we
 * match on substrings of the message rather than relying on a stable type.
 */
function describeStartError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (
    lower.includes("permission") ||
    lower.includes("notallowederror") ||
    lower.includes("denied")
  ) {
    return "Camera permission was blocked. Allow camera access in your browser, then try again — or type the barcode by hand below.";
  }
  if (
    lower.includes("notfound") ||
    lower.includes("notreadableerror") ||
    lower.includes("trackstart")
  ) {
    return "Couldn't open the camera (it may be in use by another app). Close other apps using the camera, then try again — or type the barcode by hand below.";
  }
  if (lower.includes("notsupported") || lower.includes("mediaDevices")) {
    return "This browser doesn't expose a camera API. Type the barcode by hand below.";
  }
  return `Couldn't start the camera: ${raw}. You can still type a barcode by hand below.`;
}
