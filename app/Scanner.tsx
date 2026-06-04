"use client";

import React, { useState, useEffect, useRef } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';

interface StudentData {
  id: string;
  name: string;
  dept: string;
  status: any;
  row: number;
  error?: string;
}

interface AppConfig {
  url: string;
  column: string;
}

type AppState = 
  | 'INITIALIZING' 
  | 'SETUP' 
  | 'TESTING_CONNECTION' 
  | 'IDLE' 
  | 'STARTING_CAMERA' 
  | 'SCANNING' 
  | 'PROCESSING' 
  | 'RESULT';

export default function Scanner() {
  const [appState, setAppState] = useState<AppState>('INITIALIZING');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [scannedUser, setScannedUser] = useState<StudentData | null>(null);
  const [connectionError, setConnectionError] = useState<boolean>(false);
  
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canScanRef = useRef<boolean>(true); // Prevents double-scanning

  // 1. Safe Initialization
  useEffect(() => {
    const savedConfig = localStorage.getItem('ewumuncScannerConfig');
    if (savedConfig) {
      setConfig(JSON.parse(savedConfig));
      setAppState('TESTING_CONNECTION');
    } else {
      setAppState('SETUP');
    }
  }, []);

  // 2. Test Connection
  useEffect(() => {
    if (appState !== 'TESTING_CONNECTION' || !config) return;

    const testConnection = async () => {
      try {
        const response = await fetch(`${config.url}?id=PING_TEST&col=${encodeURIComponent(config.column)}`);
        if (response.ok) {
          setConnectionError(false);
          setAppState('IDLE');
        } else {
          throw new Error('Bad response');
        }
      } catch (err) {
        setConnectionError(true);
        setAppState('SETUP');
      }
    };

    testConnection();
  }, [appState, config]);

  // 3. Camera Controls (Optimized for continuous scanning)
  // 3. Camera Controls (Maximum Performance Optimized)
// 3. Camera Controls (Maximum Performance Optimized)
  const startCamera = async () => {
    setAppState('STARTING_CAMERA');
    try {
      if (!scannerRef.current) {
        // ⚡ SPEEDUP 1: Restrict formats HERE in the constructor
        scannerRef.current = new Html5Qrcode("reader", {
          formatsToSupport: [ Html5QrcodeSupportedFormats.QR_CODE ],
          verbose: false // <-- This completely satisfies TypeScript
        });
      }
      
      await scannerRef.current.start(
        { facingMode: "environment" }, 
        { 
          fps: 10, 
          qrbox: 250, 
          disableFlip: true // ⚡ SPEEDUP 2: Stop checking for mirrored codes
        },
        async (decodedText) => {
          if (canScanRef.current) {
            canScanRef.current = false;
            
            // Freeze camera frame instantly
            try { scannerRef.current?.pause(true); } catch(e){} 
            
            await processScan(decodedText);
          }
        },
        () => {} // Ignore frame errors silently
      );
      setAppState('SCANNING');
    } catch (err) {
      console.error("Camera failed to start:", err);
      alert("Camera access denied or unavailable. Please use manual upload.");
      setAppState('IDLE');
    }
  };

  // RESUME camera for the next person
  const resumeCamera = () => {
    setScannedUser(null);
    setAppState('SCANNING');
    try { scannerRef.current?.resume(); } catch(e){}
    
    // Slight delay before unlocking the scan gate to prevent accidental double-scans
    setTimeout(() => { canScanRef.current = true; }, 400); 
  };

  // Completely destroy camera only if user logs out/disconnects
  const hardStopCamera = async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      } catch (err) { /* ignore */ }
    }
  };

  // 4. Data Processing
  const processScan = async (id: string) => {
    setAppState('PROCESSING');
    try {
      const response = await fetch(`${config!.url}?id=${encodeURIComponent(id)}&col=${encodeURIComponent(config!.column)}`);
      const data: StudentData = await response.json();
      
      if (data.error) {
        alert("⚠️ Delegate ID not found in database.");
        resumeCamera(); // Go straight back to scanning
      } else {
        setScannedUser(data);
        setAppState('RESULT');
      }
    } catch (err) {
      alert("❌ Network error. Please check your connection.");
      resumeCamera();
    }
  };

  // 5. Actions
  const handleConfirm = () => {
    if (!scannedUser || !config) return;
    
    // Background sync
    fetch(config.url, {
      method: 'POST',
      body: JSON.stringify({ row: scannedUser.row, col: config.column, val: 1 }),
    }).catch(() => console.error("Sync failed"));

    resumeCamera(); // Instantly jump back to the live scanner
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setAppState('PROCESSING');
    if (!scannerRef.current) scannerRef.current = new Html5Qrcode("reader");
    
    try {
      const result = await scannerRef.current.scanFile(file, true);
      canScanRef.current = false;
      await processScan(result);
    } catch (err) {
      alert("Could not detect a clear QR code. Please try again.");
      setAppState('IDLE');
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const resetSetup = async () => {
    await hardStopCamera();
    localStorage.removeItem('ewumuncScannerConfig');
    setConfig(null);
    setAppState('SETUP');
  };

  // ==========================================
  // RENDER: INITIALIZING / LOADING
  // ==========================================
  if (appState === 'INITIALIZING' || appState === 'TESTING_CONNECTION') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', fontFamily: 'system-ui' }}>
        <div style={{ width: '40px', height: '40px', border: '4px solid #e2e8f0', borderTop: '4px solid #1e3a8a', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: '20px' }} />
        <p style={{ color: '#475569', fontWeight: '600', fontSize: '16px' }}>
          {appState === 'INITIALIZING' ? 'Loading Portal...' : 'Securing Connection...'}
        </p>
        <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // ==========================================
  // RENDER: SETUP SCREEN (Fixed Colors)
  // ==========================================
  if (appState === 'SETUP') {
    return (
      <div style={{ maxWidth: '400px', margin: '40px auto', padding: '32px', background: '#ffffff', borderRadius: '20px', boxShadow: '0 10px 40px rgba(0,0,0,0.08)', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ textAlign: 'center', marginBottom: '30px' }}>
          <h1 style={{ color: '#1e3a8a', margin: '0 0 5px 0', fontSize: '26px', letterSpacing: '-0.5px' }}>EWUMUNC</h1>
          <p style={{ color: '#64748b', fontSize: '13px', margin: 0, textTransform: 'uppercase', letterSpacing: '1.5px', fontWeight: '700' }}>Secretariat Portal</p>
        </div>
        
        {connectionError && (
          <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '12px', borderRadius: '8px', fontSize: '14px', marginBottom: '20px', border: '1px solid #f87171', textAlign: 'center' }}>
            <strong>Connection Failed!</strong><br/>Verify your Google Script URL and try again.
          </div>
        )}
        
        <form onSubmit={(e) => {
          e.preventDefault();
          const formData = new FormData(e.currentTarget);
          const newConfig = { url: formData.get('url') as string, column: formData.get('column') as string };
          localStorage.setItem('ewumuncScannerConfig', JSON.stringify(newConfig));
          setConfig(newConfig);
          setAppState('TESTING_CONNECTION');
        }}>
          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', fontWeight: '700', color: '#0f172a', marginBottom: '8px', fontSize: '14px' }}>Google Script Web App URL</label>
            <input 
              name="url" 
              type="url" 
              required 
              defaultValue={config?.url || ''} 
              placeholder="https://script.google.com/..." 
              // FORCE Colors to override Dark Mode
              style={{ width: '100%', padding: '14px', borderRadius: '10px', border: '2px solid #e2e8f0', fontSize: '15px', outline: 'none', backgroundColor: '#f8fafc', color: '#0f172a' }} 
            />
          </div>
          <div style={{ marginBottom: '30px' }}>
            <label style={{ display: 'block', fontWeight: '700', color: '#0f172a', marginBottom: '8px', fontSize: '14px' }}>Target Column Header</label>
            <input 
              name="column" 
              type="text" 
              required 
              defaultValue={config?.column || ''} 
              placeholder="e.g. Day 1 Check-In" 
              // FORCE Colors to override Dark Mode
              style={{ width: '100%', padding: '14px', borderRadius: '10px', border: '2px solid #e2e8f0', fontSize: '15px', outline: 'none', backgroundColor: '#f8fafc', color: '#0f172a' }} 
            />
          </div>
          <button type="submit" style={{ width: '100%', background: '#1e3a8a', color: '#ffffff', padding: '16px', borderRadius: '10px', border: 'none', fontWeight: 'bold', fontSize: '16px', cursor: 'pointer', transition: '0.2s', boxShadow: '0 4px 12px rgba(30,58,138,0.2)' }}>
            Connect to Database
          </button>
        </form>
      </div>
    );
  }

  // Check if status equals 1, '1', or 'present'
  const isAlreadyScanned = scannedUser?.status == 1 || scannedUser?.status === "1" || String(scannedUser?.status).toLowerCase() === "present";

  // ==========================================
  // RENDER: MAIN APP INTERFACE
  // ==========================================
  return (
    <div style={{ width: '100%', maxWidth: '400px', margin: '0 auto', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '20px' }}>
        <div>
          <h1 style={{ color: '#1e3a8a', margin: '0 0 2px 0', fontSize: '22px', letterSpacing: '-0.5px' }}>EWUMUNC</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ display: 'inline-block', width: '8px', height: '8px', background: '#10b981', borderRadius: '50%' }}></span>
            <span style={{ fontSize: '13px', color: '#10b981', fontWeight: '700' }}>Connected: {config?.column}</span>
          </div>
        </div>
        <button onClick={resetSetup} style={{ background: '#f1f5f9', color: '#475569', border: '1px solid #cbd5e1', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: '700', cursor: 'pointer' }}>
          Disconnect
        </button>
      </div>

      {/* CAMERA MODULE */}
      <div style={{ background: '#000', borderRadius: '20px', overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.15)', position: 'relative', marginBottom: '20px', minHeight: '300px', display: 'flex', flexDirection: 'column' }}>
        
        <div id="reader" style={{ width: '100%', flexGrow: 1, display: (appState === 'IDLE') ? 'none' : 'block' }}></div>

        {/* Idle State - "Start Camera" Button */}
        {appState === 'IDLE' && (
          <div style={{ position: 'absolute', inset: 0, background: '#ffffff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '20px', textAlign: 'center' }}>
            <div style={{ fontSize: '48px', marginBottom: '15px' }}>📷</div>
            <h3 style={{ margin: '0 0 20px 0', color: '#0f172a' }}>Scanner Ready</h3>
            <button onClick={startCamera} style={{ background: '#1e3a8a', color: '#ffffff', border: 'none', padding: '14px 32px', borderRadius: '12px', fontSize: '16px', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 12px rgba(30, 58, 138, 0.3)' }}>
              Tap to Start Camera
            </button>
          </div>
        )}

        {/* Processing Overlays */}
        {(appState === 'PROCESSING' || appState === 'STARTING_CAMERA') && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(30, 58, 138, 0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffffff', fontWeight: 'bold', fontSize: '16px', backdropFilter: 'blur(4px)' }}>
            {appState === 'STARTING_CAMERA' ? 'Waking up camera...' : 'Verifying Delegate...'}
          </div>
        )}
      </div>

      {/* RESULT VERIFICATION CARD */}
      {appState === 'RESULT' && scannedUser && (
        <section style={{ background: '#ffffff', border: '1px solid #e2e8f0', padding: '24px', borderRadius: '20px', boxShadow: '0 10px 30px rgba(0,0,0,0.1)', textAlign: 'left', marginBottom: '20px' }}>
          <div style={{ borderBottom: '2px solid #f1f5f9', paddingBottom: '16px', marginBottom: '16px' }}>
            <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px' }}>Delegate Info</span>
            <h2 style={{ margin: '4px 0', fontSize: '24px', color: '#0f172a' }}>{scannedUser.name}</h2>
            <p style={{ margin: '0 0 4px 0', color: '#1e3a8a', fontWeight: '800', fontSize: '18px' }}>ID: {scannedUser.id}</p>
            <p style={{ margin: 0, color: '#64748b', fontWeight: '600', fontSize: '15px' }}>Dept: {scannedUser.dept}</p>
          </div>
          
          {isAlreadyScanned ? (
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#b91c1c', padding: '16px', borderRadius: '12px', fontWeight: 'bold', textAlign: 'center', marginBottom: '15px' }}>
              ⚠️ ALREADY CHECKED IN
            </div>
          ) : (
            <button onClick={handleConfirm} style={{ background: '#10b981', color: '#ffffff', border: 'none', padding: '16px', borderRadius: '12px', fontSize: '18px', fontWeight: 'bold', cursor: 'pointer', width: '100%', marginBottom: '12px', boxShadow: '0 4px 12px rgba(16, 185, 129, 0.3)' }}>
              ✅ CONFIRM ENTRY
            </button>
          )}
          
          <button onClick={resumeCamera} style={{ width: '100%', padding: '14px', background: '#f1f5f9', color: '#475569', borderRadius: '12px', border: 'none', fontSize: '16px', fontWeight: 'bold', cursor: 'pointer' }}>
            {isAlreadyScanned ? 'Scan Next Delegate' : 'Cancel & Scan Next'}
          </button>
        </section>
      )}

      {/* MANUAL UPLOAD (Only show if not showing result) */}
      {(appState === 'IDLE' || appState === 'SCANNING') && (
        <button onClick={() => fileInputRef.current?.click()} style={{ width: '100%', background: '#ffffff', color: '#1e3a8a', border: '2px solid #e2e8f0', padding: '16px', borderRadius: '16px', fontSize: '15px', fontWeight: '700', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px', boxShadow: '0 4px 6px rgba(0,0,0,0.02)' }}>
          📷 Upload QR from Gallery
        </button>
      )}

      <input type="file" accept="image/*" ref={fileInputRef} onChange={handleFileUpload} style={{ display: 'none' }} />

    </div>
  );
}