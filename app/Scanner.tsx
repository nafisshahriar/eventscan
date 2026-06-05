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
}

interface Config {
  url: string;
  column: string;
}

type Phase =
  | "boot"
  | "connecting"
  | "setup"
  | "idle"
  | "scanning"
  | "processing"
  | "result";

const STORAGE_KEY = "ewumunc_scanner_v3";

// ─── POST with retry (no-cors for GAS write) ─────────────────────────────────
// GAS POST via fetch requires mode:no-cors (GAS doesn't send CORS headers on POST).
// We can't read the response in no-cors, so we fire-and-forget with retries.

async function postAttendance(url: string, body: object, attempts = 4): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await fetch(url, {
        method: "POST",
        mode: "no-cors",                       // required for GAS
        headers: { "Content-Type": "text/plain" }, // text/plain avoids preflight
        body: JSON.stringify(body),
      });
      return; // no-cors always "succeeds" (opaque response) — trust the GAS doPost
    } catch {
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 700 * (i + 1)));
    }
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Scanner() {
  const [phase, setPhase]           = useState<Phase>("boot");
  const [config, setConfig]         = useState<Config | null>(null);
  const [member, setMember]         = useState<MemberData | null>(null);
  const [connError, setConnError]   = useState<string | null>(null);
  const [columns, setColumns]       = useState<string[]>([]);
  const [urlDraft, setUrlDraft]     = useState("");
  const [colDraft, setColDraft]     = useState("");
  const [fetchingCols, setFetchingCols] = useState(false);
  const [flash, setFlashMsg]        = useState<{ text: string; type: "error" | "warn" } | null>(null);

  const scannerRef   = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lockRef      = useRef(false);
  const readerReady  = useRef(false);

  // ── Boot ────────────────────────────────────────────────────────────────────
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

  // ── Test saved connection ───────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "connecting" || !config) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${config.url}?ping=1`, { signal: AbortSignal.timeout(9000) });
        if (cancelled) return;
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setColumns(data.columns || []);
        setPhase("idle");
      } catch (err: unknown) {
        if (!cancelled) {
          setConnError(err instanceof Error ? err.message : "Connection failed");
          setPhase("setup");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [phase, config]);

  // ── Cleanup camera ──────────────────────────────────────────────────────────
  useEffect(() => { return () => { stopCamera(); }; }, []);

  // ── Flash helper ────────────────────────────────────────────────────────────
  const showFlash = useCallback((text: string, type: "error" | "warn" = "error") => {
    setFlashMsg({ text, type });
    setTimeout(() => setFlashMsg(null), 3800);
  }, []);

  // ── Fetch columns from GAS (called when URL is entered in setup) ────────────
  const fetchColumns = useCallback(async (url: string) => {
    setFetchingCols(true);
    setConnError(null);
    try {
      const res = await fetch(`${url}?ping=1`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.columns?.length) throw new Error("No columns returned from sheet.");
      setColumns(data.columns);
      setColDraft(data.columns[0]);
      setConnError(null);
    } catch (err: unknown) {
      setColumns([]);
      setConnError(err instanceof Error ? err.message : "Could not fetch columns");
    } finally {
      setFetchingCols(false);
    }
  }, []);

  // ── Scan processor ──────────────────────────────────────────────────────────
  const processScan = useCallback(async (raw: string) => {
    if (!config) return;
    setPhase("processing");
    try {
      const res = await fetch(
        `${config.url}?id=${encodeURIComponent(raw)}&col=${encodeURIComponent(config.column)}`,
        { signal: AbortSignal.timeout(12000) }
      );
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      if (data.error) {
        showFlash("Not found: " + data.error, "warn");
        resumeScanning();
      } else {
        setMember(data as MemberData);
        setPhase("result");
      }
    } catch (err: unknown) {
      showFlash("Network error — " + (err instanceof Error ? err.message : "check connection"));
      resumeScanning();
    }
  }, [config, showFlash]);

  // ── Camera start/stop ───────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    lockRef.current = false;
    if (!scannerRef.current) {
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
              try { scannerRef.current?.pause(true); } catch {}
              processScan(decoded);
            }
          },
          () => {}
        );
        readerReady.current = true;
      } catch {
        showFlash("Camera access denied — try uploading a QR image.", "warn");
        setPhase("idle");
        return;
      }
    } else {
      try { scannerRef.current?.resume(); } catch {}
    }
    setPhase("scanning");
  }, [processScan, showFlash]);

  const resumeScanning = useCallback(() => {
    setMember(null);
    if (readerReady.current && scannerRef.current) {
      try { scannerRef.current.resume(); } catch {}
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

  // ── Confirm entry ───────────────────────────────────────────────────────────
  const confirmEntry = useCallback(() => {
    if (!member || !config) return;
    postAttendance(config.url, { row: member.row, col: config.column, val: 1 });
    resumeScanning();
  }, [member, config, resumeScanning]);

  // ── File upload fallback ────────────────────────────────────────────────────
  const handleFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (fileInputRef.current) fileInputRef.current.value = "";
    let tempScanner: Html5Qrcode | null = null;
    setPhase("processing");
    try {
      if (!scannerRef.current) {
        tempScanner = new Html5Qrcode("qr-reader", { verbose: false });
      }
      const inst = scannerRef.current ?? tempScanner!;
      const result = await inst.scanFile(file, true);
      if (tempScanner) { try { tempScanner.clear(); } catch {} tempScanner = null; }
      lockRef.current = true;
      await processScan(result);
    } catch {
      if (tempScanner) { try { tempScanner.clear(); } catch {} }
      lockRef.current = false;
      showFlash("No QR code found in image.", "warn");
      setPhase(readerReady.current ? "scanning" : "idle");
    }
  }, [processScan, showFlash]);

  // ── Disconnect ──────────────────────────────────────────────────────────────
  const disconnect = useCallback(async () => {
    await stopCamera();
    localStorage.removeItem(STORAGE_KEY);
    setConfig(null);
    setMember(null);
    setConnError(null);
    setColumns([]);
    setUrlDraft("");
    setColDraft("");
    setPhase("setup");
  }, [stopCamera]);

  // ── Setup submit ────────────────────────────────────────────────────────────
  const handleSetup = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!urlDraft || !colDraft) return;
    const next: Config = { url: urlDraft.trim(), column: colDraft };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setConfig(next);
    setConnError(null);
    setPhase("connecting");
  }, [urlDraft, colDraft]);

  // ── Derived state ───────────────────────────────────────────────────────────
  const alreadyIn = member?.status == 1 || member?.status === "1" ||
    String(member?.status).toLowerCase() === "present";
  const isLoading = phase === "boot" || phase === "connecting";

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        .sc-root {
          font-family: 'Space Grotesk', system-ui, sans-serif;
          min-height: 100dvh;
          background: #080c18;
          color: #e2e8f0;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding-bottom: 48px;
          
        }

        /* ── Header ── */
        .sc-header {
          width: 100%;
          max-width: 440px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 22px 20px 0;
        }
        .sc-brand { display: flex; flex-direction: column; gap: 3px; align-items: center; }
        .sc-logo {
          font-size: 16px;
          font-weight: 700;
          letter-spacing: 3.5px;
          color: #60a5fa;
          line-height: 1;
        }
        .sc-logo-sub {
          font-size: 9.5px;
          color: #bb9004;
          letter-spacing: 2.5px;
          font-weight: 500;
        }

        /* ── Status pill ── */
        .sc-status-pill {
          display: flex;
          align-items: center;
          gap: 7px;
          background: #0f172a;
          border: 1px solid #1e3a5f;
          border-radius: 20px;
          padding: 6px 12px 6px 8px;
          font-size: 12px;
          color: #7dd3fc;
          font-weight: 600;
        }
        .sc-dot {
          width: 7px; height: 7px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .sc-dot.green {
          background: #34d399;
          box-shadow: 0 0 6px #34d39988;
          animation: pulse 2.5s ease-in-out infinite;
        }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

        /* ── Flash ── */
        .sc-flash {
          max-width: 440px;
          width: calc(100% - 40px);
          margin: 14px 20px 0;
          border-radius: 10px;
          padding: 11px 15px;
          font-size: 13.5px;
          font-weight: 500;
          text-align: center;
          animation: slideDown 0.2s ease;
        }
        .sc-flash.error { background: #1f0a0a; border: 1px solid #ef444455; color: #fca5a5; }
        .sc-flash.warn  { background: #1a1200; border: 1px solid #eab30855; color: #fcd34d; }
        @keyframes slideDown { from{opacity:0;transform:translateY(-6px)} to{opacity:1;transform:translateY(0)} }

        /* ── Setup ── */
        .sc-setup {
          width: 100%;
          max-width: 440px;
          padding: 0 20px;
          margin-top: 20px;
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .sc-setup-title {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 2px;
          color: #bb9004;
          text-transform: uppercase;
          margin-bottom: 2px;
        }
        .sc-field { display: flex; flex-direction: column; gap: 7px; }
        .sc-field label {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 1.5px;
          color: #cbd2dd;
          text-transform: uppercase;
        }
        .sc-field input, .sc-field select {
          width: 100%;
          background: #0d1526;
          border: 1px solid #1e2d45;
          border-radius: 10px;
          padding: 13px 15px;
          color: #e2e8f0;
          font-family: inherit;
          font-size: 14.5px;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
          appearance: none;
          -webkit-appearance: none;
        }
        .sc-field input:focus, .sc-field select:focus {
          border-color: #3b82f6;
          box-shadow: 0 0 0 3px #3b82f622;
        }
        .sc-field input::placeholder { color: #1e3a5f; }
        .sc-field input:disabled, .sc-field select:disabled {
          opacity: 0.5; cursor: not-allowed;
        }
        .sc-select-wrap { position: relative; }
        .sc-select-wrap::after {
          content: '▾';
          position: absolute;
          right: 14px;
          top: 50%;
          transform: translateY(-50%);
          color: #bb9004;
          pointer-events: none;
          font-size: 13px;
        }
        .sc-field select option { background: #0d1526; }
        .sc-col-hint {
          font-size: 11.5px;
          color: #bb9004;
          padding: 0 2px;
        }

        /* ── Card ── */
        .sc-card {
          width: calc(100% - 40px);
          max-width: 440px;
          background: #0d1526;
          border: 1px solid #1e2d45;
          border-radius: 20px;
          overflow: hidden;
          margin-top: 18px;
          transition: opacity 0.2s;
        }

        /* ── Camera viewport ── */
        .sc-viewport {
          position: relative;
          width: 100%;
          aspect-ratio: 1 / 1;
          background: #000;
          overflow: hidden;
        }
        #qr-reader {
          width: 100% !important;
          height: 100% !important;
          border: none !important;
        }
        #qr-reader video { object-fit: cover; width: 100%; height: 100%; }
        #qr-reader img, #qr-reader button,
        #qr-reader select, #qr-reader span { display: none !important; }

        .sc-overlay {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          background: #080c18;
          z-index: 10;
          gap: 14px;
        }
        .sc-overlay.transparent { background: transparent; pointer-events: none; }

        /* Idle state */
        .sc-idle-ring {
          width: 72px; height: 72px;
          border-radius: 50%;
          border: 2px solid #1e2d45;
          display: flex; align-items: center; justify-content: center;
        }
        .sc-idle-icon { font-size: 28px; opacity: 0.35; }
        .sc-idle-label {
          font-size: 11px;
          color: #1e3a5f;
          letter-spacing: 2.5px;
          font-weight: 600;
          text-transform: uppercase;
        }

        /* Scan frame */
        .sc-frame { width: 210px; height: 210px; position: relative; }
        .sc-frame::before, .sc-frame::after, .sc-corner-bl, .sc-corner-br {
          content: '';
          position: absolute;
          width: 28px; height: 28px;
          border-color: #60a5fa;
          border-style: solid;
        }
        .sc-frame::before  { top:0; left:0;  border-width:3px 0 0 3px; border-radius:6px 0 0 0; }
        .sc-frame::after   { top:0; right:0; border-width:3px 3px 0 0; border-radius:0 6px 0 0; }
        .sc-corner-bl { bottom:0; left:0;  border-width:0 0 3px 3px; border-radius:0 0 0 6px; }
        .sc-corner-br { bottom:0; right:0; border-width:0 3px 3px 0; border-radius:0 0 6px 0; }
        .sc-scan-line {
          position: absolute;
          left: 4px; right: 4px;
          height: 2px;
          background: linear-gradient(90deg, transparent, #60a5fa, transparent);
          animation: sweep 2s ease-in-out infinite;
        }
        @keyframes sweep { 0%{top:6px;opacity:0} 10%{opacity:1} 90%{opacity:1} 100%{top:calc(100% - 6px);opacity:0} }

        /* Spinner */
        .sc-spinner {
          width: 34px; height: 34px;
          border: 3px solid #1e2d45;
          border-top-color: #60a5fa;
          border-radius: 50%;
          animation: spin 0.75s linear infinite;
        }
        @keyframes spin { to{transform:rotate(360deg)} }

        /* ── Panel ── */
        .sc-panel {
          padding: 18px 20px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .sc-divider { height: 1px; background: #111f38; }
        .sc-scan-hint {
          font-size: 12.5px;
          color: #1e3a5f;
          text-align: center;
          letter-spacing: 0.3px;
        }

        /* Buttons */
        .sc-btn {
          width: 100%;
          padding: 14px 20px;
          border-radius: 11px;
          border: none;
          font-family: inherit;
          font-size: 14.5px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.1s, opacity 0.15s, background 0.15s;
          letter-spacing: 0.3px;
        }
        .sc-btn:active { transform: scale(0.97); }
        .sc-btn:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }
        .sc-btn.primary { background: #2563eb; color: #fff; }
        .sc-btn.primary:hover:not(:disabled) { background: #3b82f6; }
        .sc-btn.success { background: #047857; color: #fff; }
        .sc-btn.success:hover { background: #059669; }
        .sc-btn.ghost { background: transparent; color: #cbd2dd; border: 1px solid #1e2d45; }
        .sc-btn.ghost:hover { background: #0f172a; color: #94a3b8; border-color: #263d5f; }
        .sc-btn.sm { font-size: 12px; padding: 6px 13px; width: auto; }

        /* ── Result overlay ── */
        .sc-result-overlay {
          position: absolute;
          inset: 0;
          background: #080c18ee;
          z-index: 10;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 28px 20px 20px;
          gap: 12px;
          overflow-y: auto;
        }
        .sc-member-card {
          width: 100%;
          background: #0d1526;
          border: 1px solid #1e2d45;
          border-radius: 14px;
          padding: 18px;
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .sc-member-id {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: #3b82f6;
          letter-spacing: 2px;
          font-weight: 500;
        }
        .sc-member-name {
          font-size: 21px;
          font-weight: 700;
          color: #f1f5f9;
          line-height: 1.2;
          margin-top: 3px;
        }
        .sc-member-dept {
          font-size: 13px;
          color: #cbd2dd;
          font-weight: 500;
        }
        .sc-already-in {
          width: 100%;
          background: #2d0e0e;
          border: 1px solid #7f1d1d66;
          border-radius: 10px;
          padding: 11px 16px;
          color: #fca5a5;
          font-size: 13.5px;
          font-weight: 600;
          text-align: center;
        }
        .sc-result-btns {
          display: flex;
          flex-direction: column;
          gap: 9px;
          width: 100%;
          margin-top: 2px;
        }

        /* ── Disconnect row ── */
        .sc-disc-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        /* Loading dots */
        .sc-loading-text {
          font-size: 12px;
          color: #bb9004;
          letter-spacing: 0.5px;
        }
      `}</style>

      <div className="sc-root">

        {/* ── Header ── */}
        <header className="sc-header">
          <div className="sc-brand">
            <div className="sc-logo">EWUMUNC</div>
            <div className="sc-logo-sub">ATTENDANCE SYSTEM</div>
          </div>

          {phase !== "setup" && phase !== "boot" && phase !== "connecting" && (
            <div className="sc-disc-row">
              <div className="sc-status-pill">
                <div className="sc-dot green" />
                {config?.column}
              </div>
              <button
                className="sc-btn ghost sm"
                onClick={disconnect}
                title="Disconnect"
              >
                ✕
              </button>
            </div>
          )}
        </header>

        {/* ── Flash ── */}
        {flash && (
          <div className={`sc-flash ${flash.type}`}>{flash.text}</div>
        )}

        {/* ── Setup screen ── */}
        {phase === "setup" && (
          <form className="sc-setup" onSubmit={handleSetup}>

            {connError && (
              <div className="sc-flash error" style={{ margin: 0, width: "100%" }}>
                {connError}
              </div>
            )}

            {/* URL field + Load Columns button */}
            <div className="sc-field">
              <label>Google Script URL</label>
              <input
                type="url"
                required
                autoComplete="off"
                value={urlDraft}
                onChange={e => setUrlDraft(e.target.value)}
                placeholder="https://script.google.com/macros/s/…/exec"
              />
            </div>

            <button
              type="button"
              className="sc-btn ghost"
              disabled={!urlDraft || fetchingCols}
              onClick={() => fetchColumns(urlDraft)}
            >
              {fetchingCols ? "Loading columns…" : "Load Columns"}
            </button>

            {/* Column dropdown — shown only after columns are fetched */}
            {columns.length > 0 && (
              <div className="sc-field">
                <label>Attendance Column</label>
                <div className="sc-select-wrap">
                  <select
                    value={colDraft}
                    onChange={e => setColDraft(e.target.value)}
                    required
                  >
                    {columns.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <span className="sc-col-hint">
                  Scanning will mark ✓ in this column.
                </span>
              </div>
            )}

            <button
              type="submit"
              className="sc-btn primary"
              disabled={!urlDraft || !colDraft}
            >
              Connect
            </button>
          </form>
        )}

        {/* ── Camera card (always rendered to keep #qr-reader in DOM) ── */}
        {phase !== "setup" && (
          <div
            className="sc-card"
            style={{ opacity: isLoading ? 0.4 : 1, pointerEvents: isLoading ? "none" : "auto" }}
          >
            <div className="sc-viewport">

              {/* Always-present QR reader div — visibility toggled by opacity */}
              <div
                id="qr-reader"
                style={{ opacity: phase === "scanning" ? 1 : 0, pointerEvents: "none" }}
              />

              {/* Idle */}
              {phase === "idle" && (
                <div className="sc-overlay">
                  <div className="sc-idle-ring">
                    <div className="sc-idle-icon">⬡</div>
                  </div>
                  <div className="sc-idle-label">Ready to scan</div>
                </div>
              )}

              {/* Loading / connecting */}
              {isLoading && (
                <div className="sc-overlay">
                  <div className="sc-spinner" />
                  <span className="sc-loading-text">
                    {phase === "boot" ? "Loading…" : "Connecting…"}
                  </span>
                </div>
              )}

              {/* Processing */}
              {phase === "processing" && (
                <div className="sc-overlay">
                  <div className="sc-spinner" />
                  <span className="sc-loading-text">Verifying…</span>
                </div>
              )}

              {/* Active scan frame */}
              {phase === "scanning" && (
                <div className="sc-overlay transparent">
                  <div className="sc-frame">
                    <div className="sc-corner-bl" />
                    <div className="sc-corner-br" />
                    <div className="sc-scan-line" />
                  </div>
                </div>
              )}

              {/* Result */}
              {phase === "result" && member && (
                <div className="sc-result-overlay">
                  <div className="sc-member-card">
                    <div className="sc-member-id">{member.id || "—"}</div>
                    <div className="sc-member-name">{member.name || "Unknown"}</div>
                    <div className="sc-member-dept">{member.dept || "—"}</div>
                  </div>

                  {alreadyIn && (
                    <div className="sc-already-in">⚠ Already checked in</div>
                  )}

                  <div className="sc-result-btns">
                    {!alreadyIn && (
                      <button className="sc-btn success" onClick={confirmEntry}>
                        Confirm Entry
                      </button>
                    )}
                    <button className="sc-btn ghost" onClick={resumeScanning}>
                      {alreadyIn ? "Scan Next" : "Cancel"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* ── Panel below viewport ── */}
            {!isLoading && (
              <div className="sc-panel">
                {phase === "idle" && (
                  <button className="sc-btn primary" onClick={startCamera}>
                    Start Camera
                  </button>
                )}
                {phase === "scanning" && (
                  <p className="sc-scan-hint">Point camera at a QR code</p>
                )}
                <div className="sc-divider" />
                <button
                  className="sc-btn ghost"
                  style={{ fontSize: 13 }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  Upload QR Image
                </button>
              </div>
            )}
          </div>
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