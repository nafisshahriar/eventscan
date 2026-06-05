"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MemberData {
  id: string;
  name: string;
  dept: string;
  status: string | number;
  row: number;
  error?: string;
}

interface Config {
  url: string;
  column: string;
  sheet: string;
}

type Phase =
  | "boot"
  | "connecting"
  | "setup"
  | "idle"
  | "scanning"
  | "processing"
  | "result";

const STORAGE_KEY = "ewumunc_scanner_v2";

// ─── Retry queue for fire-and-forget POSTs ────────────────────────────────────

async function postWithRetry(
  url: string,
  body: object,
  attempts = 3
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify(body),
      });
      if (res.ok) return;
    } catch {
      if (i === attempts - 1) console.error("POST failed after retries");
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Scanner() {
  const [phase, setPhase] = useState<Phase>("boot");
  const [config, setConfig] = useState<Config | null>(null);
  const [member, setMember] = useState<MemberData | null>(null);
  const [flashMessage, setFlashMessage] = useState<{
    text: string;
    type: "error" | "warn";
  } | null>(null);

  const scannerRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lockRef = useRef(false); // scan gate: true = ignore frames
  const readerReady = useRef(false);

  // ── Boot: restore saved config ──────────────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setConfig(JSON.parse(saved));
        setPhase("connecting");
      } catch {
        setPhase("setup");
      }
    } else {
      setPhase("setup");
    }
  }, []);

  // ── Skip connection test — go straight to idle or setup if no config.
  useEffect(() => {
    if (phase !== "connecting") return;
    if (!config) { setPhase("setup"); return; }
    setPhase("idle");
  }, [phase, config]);

  // ── Cleanup camera on unmount ───────────────────────────────────────────────
  useEffect(() => {
    return () => { stopCamera(); };
  }, []);

  // ── Flash helper ────────────────────────────────────────────────────────────
  const flash = useCallback(
    (text: string, type: "error" | "warn" = "error") => {
      setFlashMessage({ text, type });
      setTimeout(() => setFlashMessage(null), 3500);
    },
    []
  );

  // ── Scan processor ──────────────────────────────────────────────────────────
  const processScan = useCallback(
    async (raw: string) => {
      if (!config) { flash("No configuration — please set up the scanner first.", "warn"); resumeScanning(); return; }
      setPhase("processing");

      try {
        const res = await fetch(
          `${config.url}?id=${encodeURIComponent(raw)}&col=${encodeURIComponent(config.column)}&sheet=${encodeURIComponent(config.sheet)}`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data: MemberData = await res.json();

        if (data.error) {
          flash("ID not found in database.", "warn");
          resumeScanning();
        } else {
          setMember(data);
          setPhase("result");
        }
      } catch {
        flash("Network error — check your connection.");
        resumeScanning();
      }
    },
    [config, flash]
  );

  // ── Camera: init & start ────────────────────────────────────────────────────
  // KEY FIX: #reader must exist in DOM before Html5Qrcode is created.
  // We always render it; visibility is toggled via CSS opacity/pointer-events,
  // NOT display:none which removes it from DOM and breaks the library.
  const startCamera = useCallback(async () => {
    lockRef.current = false;

    if (!scannerRef.current) {
      // Create instance against the always-rendered #reader div
      scannerRef.current = new Html5Qrcode("qr-reader", {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        verbose: false,
      });
      readerReady.current = false;
    }

    if (!readerReady.current) {
      try {
        await scannerRef.current.start(
          { facingMode: "environment" },
          { fps: 12, qrbox: { width: 240, height: 240 }, disableFlip: true },
          (decoded) => {
            if (!lockRef.current) {
              lockRef.current = true;
              try { scannerRef.current?.pause(true); } catch { }
              processScan(decoded);
            }
          },
          () => {} // suppress frame-level errors
        );
        readerReady.current = true;
      } catch (err) {
        flash("Camera access denied. Try uploading a QR image instead.", "warn");
        setPhase("idle");
        return;
      }
    } else {
      // Camera already running — just resume
      try { scannerRef.current?.resume(); } catch { }
    }

    setPhase("scanning");
  }, [processScan, flash]);

  const resumeScanning = useCallback(() => {
    setMember(null);
    if (readerReady.current && scannerRef.current) {
      try { scannerRef.current.resume(); } catch { }
      setTimeout(() => { lockRef.current = false; }, 500);
      setPhase("scanning");
    } else {
      setPhase("idle");
    }
  }, []);

  const stopCamera = useCallback(async () => {
    if (scannerRef.current && readerReady.current) {
      try { await scannerRef.current.stop(); } catch {}
      try { scannerRef.current.clear(); } catch {}
      readerReady.current = false;
    }
    scannerRef.current = null;
  }, []);

  // ── Confirm check-in ────────────────────────────────────────────────────────
  const confirmEntry = useCallback(() => {
    if (!member || !config) return;
    postWithRetry(config.url, { row: member.row, col: config.column, sheet: config.sheet, val: 1 });
    resumeScanning();
  }, [member, config, resumeScanning]);

  // ── File upload fallback ─────────────────────────────────────────────────────
  const handleFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (fileInputRef.current) fileInputRef.current.value = "";

      // Need a temporary scanner instance if camera isn't active
      let tempScanner: Html5Qrcode | null = null;
      setPhase("processing");

      try {
        if (!scannerRef.current) {
          tempScanner = new Html5Qrcode("qr-reader", { verbose: false });
        }
        const inst = scannerRef.current ?? tempScanner!;
        const result = await inst.scanFile(file, true);
        if (tempScanner) {
          try { tempScanner.clear(); } catch {}
          tempScanner = null;
        }
        lockRef.current = true;
        await processScan(result);
      } catch {
        if (tempScanner) { try { tempScanner.clear(); } catch {} }
        lockRef.current = false;
        flash("No QR code found in image. Try a clearer photo.", "warn");
        setPhase(readerReady.current ? "scanning" : "idle");
      }
    },
    [processScan, flash]
  );

  // ── Disconnect / reset ───────────────────────────────────────────────────────
  const disconnect = useCallback(async () => {
    await stopCamera();
    localStorage.removeItem(STORAGE_KEY);
    setConfig(null);
    setMember(null);
    setPhase("setup");
  }, [stopCamera]);

  // ── Setup form submit ────────────────────────────────────────────────────────
  const handleSetup = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const fd = new FormData(e.currentTarget);
      const next: Config = {
        url: (fd.get("url") as string).trim(),
        column: (fd.get("column") as string).trim(),
        sheet: ((fd.get("sheet") as string).trim()) || "Group Distrubution",
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setConfig(next);
        setPhase("connecting");
    },
    []
  );

  // ─── Status helpers ──────────────────────────────────────────────────────────
  const alreadyCheckedIn =
    member?.status == 1 ||
    member?.status === "1" ||
    String(member?.status).toLowerCase() === "present";

  const isLoading = phase === "boot" || phase === "connecting";

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono:wght@500&display=swap');

        .sc-root {
          font-family: 'DM Sans', system-ui, sans-serif;
          min-height: 100dvh;
          background: #0a0f1e;
          color: #e2e8f0;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 0 0 40px;
        }

        /* ── Header bar ── */
        .sc-header {
          width: 100%;
          max-width: 440px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 20px 20px 0;
        }
        .sc-logo { font-size: 15px; font-weight: 600; letter-spacing: 3px; color: #7dd3fc; }
        .sc-logo-sub { font-size: 10px; color: #475569; letter-spacing: 2px; margin-top: 2px; }

        /* ── Card shell ── */
        .sc-card {
          width: 100%;
          max-width: 440px;
          background: #111827;
          border: 1px solid #1e2d45;
          border-radius: 20px;
          overflow: hidden;
          margin: 16px 20px 0;
        }

        /* ── Camera viewport ── */
        .sc-viewport {
          position: relative;
          width: 100%;
          aspect-ratio: 1 / 1;
          background: #000;
          overflow: hidden;
        }

        /* Always rendered — visibility toggled so html5-qrcode can mount */
        #qr-reader {
          width: 100% !important;
          height: 100% !important;
          border: none !important;
        }
        #qr-reader video { object-fit: cover; width: 100%; height: 100%; }
        /* Hide the library's own UI chrome */
        #qr-reader img, #qr-reader button,
        #qr-reader select, #qr-reader span { display: none !important; }

        .sc-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: #0a0f1e;
          z-index: 10;
          gap: 16px;
        }
        .sc-overlay.transparent {
          background: transparent;
          pointer-events: none;
        }

        /* Scan frame */
        .sc-frame {
          width: 220px;
          height: 220px;
          position: relative;
        }
        .sc-frame::before, .sc-frame::after,
        .sc-corner-bl, .sc-corner-br {
          content: '';
          position: absolute;
          width: 32px;
          height: 32px;
          border-color: #7dd3fc;
          border-style: solid;
        }
        .sc-frame::before { top: 0; left: 0; border-width: 3px 0 0 3px; border-radius: 6px 0 0 0; }
        .sc-frame::after  { top: 0; right: 0; border-width: 3px 3px 0 0; border-radius: 0 6px 0 0; }
        .sc-corner-bl { bottom: 0; left: 0; border-width: 0 0 3px 3px; border-radius: 0 0 0 6px; }
        .sc-corner-br { bottom: 0; right: 0; border-width: 0 3px 3px 0; border-radius: 0 0 6px 0; }
        .sc-scan-line {
          position: absolute;
          left: 4px; right: 4px;
          height: 2px;
          background: linear-gradient(90deg, transparent, #7dd3fc, transparent);
          animation: scan-sweep 2s ease-in-out infinite;
        }
        @keyframes scan-sweep {
          0%   { top: 8px; opacity: 0; }
          10%  { opacity: 1; }
          90%  { opacity: 1; }
          100% { top: calc(100% - 8px); opacity: 0; }
        }

        /* Spinner */
        .sc-spinner {
          width: 36px; height: 36px;
          border: 3px solid #1e2d45;
          border-top-color: #7dd3fc;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Status dot */
        .sc-dot {
          width: 8px; height: 8px;
          border-radius: 50%;
          animation: pulse 2s ease-in-out infinite;
        }
        .sc-dot.green { background: #34d399; }
        @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

        /* ── Bottom panel ── */
        .sc-panel {
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        /* Buttons */
        .sc-btn {
          width: 100%;
          padding: 15px 20px;
          border-radius: 12px;
          border: none;
          font-family: inherit;
          font-size: 15px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.1s, opacity 0.1s;
          letter-spacing: 0.3px;
        }
        .sc-btn:active { transform: scale(0.97); }
        .sc-btn.primary { background: #0ea5e9; color: #fff; }
        .sc-btn.primary:hover { background: #38bdf8; }
        .sc-btn.success { background: #059669; color: #fff; }
        .sc-btn.success:hover { background: #10b981; }
        .sc-btn.ghost {
          background: transparent;
          color: #94a3b8;
          border: 1px solid #1e2d45;
        }
        .sc-btn.ghost:hover { background: #1e2d45; color: #cbd5e1; }
        .sc-btn.danger { background: #7f1d1d22; color: #fca5a5; border: 1px solid #7f1d1d55; }
        .sc-btn.danger:hover { background: #7f1d1d44; }

        /* Member result card */
        .sc-member {
          background: #0d1526;
          border-radius: 14px;
          border: 1px solid #1e2d45;
          padding: 18px;
        }
        .sc-member-id {
          font-family: 'DM Mono', monospace;
          font-size: 11px;
          color: #7dd3fc;
          letter-spacing: 2px;
          margin-bottom: 6px;
        }
        .sc-member-name { font-size: 22px; font-weight: 600; color: #f1f5f9; margin: 0 0 4px; }
        .sc-member-dept { font-size: 14px; color: #64748b; }

        .sc-already-in {
          background: #451a1a44;
          border: 1px solid #7f1d1d66;
          border-radius: 10px;
          padding: 12px 16px;
          color: #fca5a5;
          font-size: 14px;
          font-weight: 600;
          text-align: center;
          letter-spacing: 0.5px;
        }

        /* Flash message */
        .sc-flash {
          max-width: 440px;
          width: calc(100% - 40px);
          margin: 12px 20px 0;
          border-radius: 10px;
          padding: 12px 16px;
          font-size: 14px;
          font-weight: 500;
          text-align: center;
          animation: fadeIn 0.2s ease;
        }
        .sc-flash.error { background: #451a1a44; border: 1px solid #ef444444; color: #fca5a5; }
        .sc-flash.warn  { background: #451a0044; border: 1px solid #eab30844; color: #fcd34d; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; } }

        /* Setup form */
        .sc-setup {
          width: 100%;
          max-width: 440px;
          padding: 0 20px;
          margin-top: 12px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .sc-field label {
          display: block;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 1.5px;
          color: #475569;
          margin-bottom: 8px;
          text-transform: uppercase;
        }
        .sc-field input {
          width: 100%;
          box-sizing: border-box;
          background: #111827;
          border: 1px solid #1e2d45;
          border-radius: 10px;
          padding: 13px 16px;
          color: #e2e8f0;
          font-family: inherit;
          font-size: 15px;
          outline: none;
          transition: border-color 0.15s;
        }
        .sc-field input:focus { border-color: #0ea5e9; }
        .sc-field input::placeholder { color: #334155; }

        .sc-divider {
          height: 1px;
          background: #1e2d45;
          margin: 0;
        }

        .sc-status-row {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 13px;
          color: #34d399;
          font-weight: 500;
        }

        .sc-idle-icon {
          font-size: 40px;
          margin-bottom: 4px;
          opacity: 0.6;
        }
        .sc-idle-label {
          font-size: 13px;
          color: #475569;
          letter-spacing: 1px;
        }
      `}</style>

      <div className="sc-root">
        {/* ── Header ── */}
        <header className="sc-header">
          <div>
            <div className="sc-logo">EWUMUNC</div>
            <div className="sc-logo-sub">SECRETARIAT PORTAL</div>
          </div>
          {(phase !== "setup" && phase !== "boot" && phase !== "connecting") && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
              <div className="sc-status-row">
                <div className="sc-dot green" />
                <span>{config?.sheet} · {config?.column}</span>
              </div>
              <button
                className="sc-btn ghost"
                style={{ width: "auto", padding: "5px 12px", fontSize: 12 }}
                onClick={disconnect}
              >
                Disconnect
              </button>
            </div>
          )}
        </header>

        {/* ── Flash message ── */}
        {flashMessage && (
          <div className={`sc-flash ${flashMessage.type}`}>
            {flashMessage.text}
          </div>
        )}

        {/* ── Setup screen ── */}
        {(phase === "setup") && (
          <form className="sc-setup" onSubmit={handleSetup}>
            <div className="sc-field">
              <label>Google Script URL</label>
              <input
                name="url"
                type="text"
                required
                autoComplete="off"
                defaultValue={config?.url ?? ""}
                placeholder="https://script.google.com/…"
              />
            </div>
            <div className="sc-field">
              <label>Target Column</label>
              <input
                name="column"
                type="text"
                required
                defaultValue={config?.column ?? ""}
                placeholder="e.g. Day 1 Check-In"
              />
            </div>
            <div className="sc-field">
              <label>Sheet / Tab Name</label>
              <input
                name="sheet"
                type="text"
                defaultValue={config?.sheet ?? "Group Distrubution"}
                placeholder="Group Distrubution"
              />
            </div>
            <button type="submit" className="sc-btn primary">
              Connect to Database
            </button>
          </form>
        )}

        {/* ── Camera card (always rendered so #qr-reader stays in DOM) ── */}
        {(phase === "idle" || phase === "scanning" || phase === "processing" || phase === "result") && (
          <>
            <div
              className="sc-card"
              style={{
                // Collapse visually during boot/connecting
                opacity: isLoading ? 0.4 : 1,
                pointerEvents: isLoading ? "none" : "auto",
              }}
            >
              <div className="sc-viewport">
                {/* ALWAYS rendered — this is the critical fix */}
                <div
                  id="qr-reader"
                  style={{
                    // Visible only when camera is active
                    opacity: phase === "scanning" ? 1 : 0,
                    pointerEvents: "none",
                  }}
                />

                {/* Idle overlay */}
                {phase === "idle" && (
                  <div className="sc-overlay">
                    <div className="sc-idle-icon">⬡</div>
                    <div className="sc-idle-label">SCANNER READY</div>
                  </div>
                )}

                {/* Boot / connecting overlay */}
                {isLoading && (
                  <div className="sc-overlay">
                    <div className="sc-spinner" />
                    <span style={{ fontSize: 13, color: "#475569" }}>
                      {phase === "boot" ? "Loading…" : "Connecting…"}
                    </span>
                  </div>
                )}

                {/* Starting camera overlay */}
                {phase === "processing" && (
                  <div className="sc-overlay">
                    <div className="sc-spinner" />
                    <span style={{ fontSize: 13, color: "#7dd3fc" }}>Verifying…</span>
                  </div>
                )}

                {/* Active scan frame (shown on top of live feed) */}
                {phase === "scanning" && (
                  <div className="sc-overlay transparent">
                    <div className="sc-frame">
                      <div className="sc-corner-bl" />
                      <div className="sc-corner-br" />
                      <div className="sc-scan-line" />
                    </div>
                  </div>
                )}

                {/* Result card overlaid on frozen frame */}
                {phase === "result" && member && (
                  <div
                    className="sc-overlay"
                    style={{ background: "#0a0f1eee", padding: 20, justifyContent: "flex-start", paddingTop: 32 }}
                  >
                    <div className="sc-member" style={{ width: "100%", boxSizing: "border-box" }}>
                      <div className="sc-member-id" title={member.id} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {member.id || "—"}
                      </div>
                      <div className="sc-member-name">{member.name}</div>
                      <div className="sc-member-dept">{member.dept || "No department"}</div>
                    </div>

                    {alreadyCheckedIn ? (
                      <div className="sc-already-in" style={{ width: "100%", boxSizing: "border-box", marginTop: 12 }}>
                        ⚠ Already checked in
                      </div>
                    ) : null}

                    <div style={{ display: "flex", flexDirection: "column", gap: 10, width: "100%", marginTop: 16 }}>
                      {!alreadyCheckedIn && (
                        <button className="sc-btn success" onClick={confirmEntry}>
                          Confirm Entry
                        </button>
                      )}
                      <button className="sc-btn ghost" onClick={resumeScanning}>
                        {alreadyCheckedIn ? "Scan Next" : "Cancel"}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* ── Panel below camera ── */}
              {!isLoading && (
                <div className="sc-panel">
                  {phase === "idle" && (
                    <button className="sc-btn primary" onClick={startCamera}>
                      Start Camera
                    </button>
                  )}
                  {phase === "scanning" && (
                    <p style={{ margin: 0, fontSize: 13, color: "#334155", textAlign: "center" }}>
                      Point camera at a QR code
                    </p>
                  )}
                  <div className="sc-divider" />
                  <button
                    className="sc-btn ghost"
                    onClick={() => fileInputRef.current?.click()}
                    style={{ fontSize: 13 }}
                  >
                    Upload QR Image from Gallery
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* Hidden file input */}
        <input
          type="file"
          accept="image/*"
          ref={fileInputRef}
          onChange={handleFile}
          style={{ display: "none" }}
        />
      </div>
    </>
  );
}