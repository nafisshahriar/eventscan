"use client";

import React, { useState, useEffect, useRef } from 'react';
import { Html5Qrcode } from 'html5-qrcode';

interface StudentData {
  id: string;      // <-- Added ID
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

export default function Scanner() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [isUrlValid, setIsUrlValid] = useState<boolean | null>(null);
  const [scannedUser, setScannedUser] = useState<StudentData | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<boolean>(false);
  
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canScanRef = useRef<boolean>(true);

  useEffect(() => {
    const savedConfig = localStorage.getItem('ewumuncScannerConfig');
    if (savedConfig) setConfig(JSON.parse(savedConfig));
  }, []);

  useEffect(() => {
    if (!config) return;
    const verifyConnection = async () => {
      try {
        const response = await fetch(`${config.url}?id=PING_TEST&col=${encodeURIComponent(config.column)}`);
        setIsUrlValid(response.ok);
      } catch (error) {
        setIsUrlValid(false);
      }
    };
    verifyConnection();
  }, [config]);

  useEffect(() => {
    if (isUrlValid !== true) return;
    const html5QrCode = new Html5Qrcode("reader");
    scannerRef.current = html5QrCode;
    let isUnmounted = false;

    const startCamera = async () => {
      try {
        await html5QrCode.start(
          { facingMode: "environment" }, 
          { fps: 10, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
          (decodedText) => {
            if (canScanRef.current) {
              canScanRef.current = false;
              fetchUserDetails(decodedText);
            }
          },
          () => {}
        );
      } catch (err) {
        if (!isUnmounted) setCameraError(true);
      }
    };

    startCamera();

    return () => {
      isUnmounted = true;
      if (html5QrCode.isScanning) {
        html5QrCode.stop().then(() => html5QrCode.clear()).catch(console.error);
      }
    };
  }, [isUrlValid]);

  const fetchUserDetails = async (id: string) => {
    if (!config) return;
    setLoading(true);
    try {
      const response = await fetch(`${config.url}?id=${encodeURIComponent(id)}&col=${encodeURIComponent(config.column)}`);
      const data: StudentData = await response.json();
      
      if (data.error) {
        alert("⚠️ Delegate ID not found in database.");
        canScanRef.current = true;
      } else {
        setScannedUser(data);
      }
    } catch (err) {
      alert("❌ Network error. Check connection.");
      canScanRef.current = true;
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = () => {
    if (!scannedUser || !config) return;
    const targetRow = scannedUser.row;
    const studentName = scannedUser.name;

    alert(`✅ Confirmed: ${studentName}`);
    handleCancel(); 

    fetch(config.url, {
      method: 'POST',
      body: JSON.stringify({ row: targetRow, col: config.column, val: 1 }),
    }).catch(() => console.error("Background sync failed"));
  };

  const handleCancel = () => {
    setScannedUser(null);
    setLoading(false);
    setTimeout(() => { canScanRef.current = true; }, 500);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !scannerRef.current) return;
    try {
      const result = await scannerRef.current.scanFile(file, true);
      canScanRef.current = false;
      fetchUserDetails(result);
    } catch (err) {
      alert("Could not detect a clear QR code. Please try again.");
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const resetConfig = () => {
    localStorage.removeItem('ewumuncScannerConfig');
    window.location.reload(); 
  };

  if (!config || isUrlValid === false) {
    return (
      <div style={{ maxWidth: '400px', margin: '40px auto', padding: '30px', background: '#ffffff', borderRadius: '16px', boxShadow: '0 10px 25px rgba(0,0,0,0.05)', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ textAlign: 'center', marginBottom: '25px' }}>
          <h1 style={{ color: '#1e3a8a', margin: '0 0 5px 0', fontSize: '24px', letterSpacing: '-0.5px' }}>EWUMUNC</h1>
          <p style={{ color: '#64748b', fontSize: '14px', margin: 0, textTransform: 'uppercase', letterSpacing: '1px' }}>Secretariat Portal</p>
        </div>
        
        {isUrlValid === false && (
          <div style={{ background: '#fef2f2', color: '#b91c1c', padding: '12px', borderRadius: '8px', fontSize: '14px', marginBottom: '20px', border: '1px solid #f87171', textAlign: 'center' }}>
            <strong>Connection Failed!</strong><br/>Please check your Google Script URL and ensure it is deployed correctly.
          </div>
        )}
        
        <form onSubmit={(e) => {
          e.preventDefault();
          const formData = new FormData(e.currentTarget);
          const newConfig = { url: formData.get('url') as string, column: formData.get('column') as string };
          localStorage.setItem('ewumuncScannerConfig', JSON.stringify(newConfig));
          setConfig(newConfig);
          setIsUrlValid(null); 
        }}>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', fontWeight: '600', color: '#334155', marginBottom: '6px', fontSize: '14px' }}>Google Script Web App URL</label>
            <input name="url" type="url" required defaultValue={config?.url || ''} placeholder="https://script.google.com/..." style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', outline: 'none' }} />
          </div>
          <div style={{ marginBottom: '25px' }}>
            <label style={{ display: 'block', fontWeight: '600', color: '#334155', marginBottom: '6px', fontSize: '14px' }}>Target Column Header</label>
            <input name="column" type="text" required defaultValue={config?.column || ''} placeholder="e.g. Day 1 Check-In" style={{ width: '100%', padding: '12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', outline: 'none' }} />
          </div>
          <button type="submit" style={{ width: '100%', background: '#1e3a8a', color: 'white', padding: '14px', borderRadius: '8px', border: 'none', fontWeight: 'bold', fontSize: '16px', cursor: 'pointer' }}>
            {isUrlValid === false ? 'Retry Connection' : 'Connect to Database'}
          </button>
        </form>
      </div>
    );
  }

  if (isUrlValid === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '50vh', fontFamily: 'system-ui' }}>
        <div style={{ width: '40px', height: '40px', border: '4px solid #f3f3f3', borderTop: '4px solid #1e3a8a', borderRadius: '50%', animation: 'spin 1s linear infinite', marginBottom: '15px' }} />
        <p style={{ color: '#475569', fontWeight: '500' }}>Establishing secure connection...</p>
        <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  const isAlreadyScanned = scannedUser?.status == 1 || scannedUser?.status === "1" || String(scannedUser?.status).toLowerCase() === "present";

  return (
    <div style={{ width: '100%', maxWidth: '400px', margin: '0 auto', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '15px' }}>
        <div>
          <h1 style={{ color: '#1e3a8a', margin: '0 0 2px 0', fontSize: '20px', letterSpacing: '-0.5px' }}>EWUMUNC</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ display: 'inline-block', width: '8px', height: '8px', background: '#10b981', borderRadius: '50%' }}></span>
            <span style={{ fontSize: '13px', color: '#10b981', fontWeight: '600' }}>Connected ({config.column})</span>
          </div>
        </div>
        <button onClick={resetConfig} style={{ background: '#f1f5f9', color: '#64748b', border: 'none', padding: '6px 12px', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>
          Change Event
        </button>
      </div>

      <div style={{ display: scannedUser ? 'none' : 'block', background: '#000', borderRadius: '16px', overflow: 'hidden', boxShadow: '0 10px 25px rgba(0,0,0,0.15)', position: 'relative', marginBottom: '20px' }}>
        <div id="reader" style={{ width: '100%', minHeight: '300px', border: 'none' }}></div>
        {loading && !scannedUser && (
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(30, 58, 138, 0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', fontWeight: 'bold', backdropFilter: 'blur(4px)' }}>
            Verifying Delegate...
          </div>
        )}
        {cameraError && !loading && (
          <div style={{ position: 'absolute', inset: 0, background: '#1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'white', padding: '20px', textAlign: 'center' }}>
            <p style={{ marginBottom: '15px' }}>Camera unavailable.</p>
            <button onClick={() => fileInputRef.current?.click()} style={{ background: '#3b82f6', color: 'white', border: 'none', padding: '12px 24px', borderRadius: '8px', fontSize: '16px', fontWeight: 'bold', cursor: 'pointer' }}>
              Upload QR Image
            </button>
          </div>
        )}
      </div>

      {!scannedUser && !cameraError && (
        <button onClick={() => fileInputRef.current?.click()} style={{ width: '100%', background: '#f8fafc', color: '#1e3a8a', border: '1px solid #e2e8f0', padding: '14px', borderRadius: '12px', fontSize: '15px', fontWeight: '600', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px' }}>
          📷 Upload QR from Gallery
        </button>
      )}

      <input type="file" accept="image/*" ref={fileInputRef} onChange={handleFileUpload} style={{ display: 'none' }} />

      {scannedUser && (
        <section style={{ background: '#ffffff', border: '1px solid #e2e8f0', padding: '24px', borderRadius: '16px', boxShadow: '0 10px 25px rgba(0,0,0,0.08)', textAlign: 'left' }}>
          <div style={{ borderBottom: '2px solid #f1f5f9', paddingBottom: '16px', marginBottom: '16px' }}>
            <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '1px' }}>Delegate Info</span>
            <h2 style={{ margin: '4px 0', fontSize: '22px', color: '#0f172a' }}>{scannedUser.name}</h2>
            <p style={{ margin: '0 0 4px 0', color: '#1e3a8a', fontWeight: '700' }}>ID: {scannedUser.id}</p> {/* <-- Added ID Display */}
            <p style={{ margin: 0, color: '#64748b', fontWeight: '500' }}>Dept / Institute: {scannedUser.dept}</p>
          </div>
          
          {isAlreadyScanned ? (
            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', color: '#b91c1c', padding: '16px', borderRadius: '12px', fontWeight: 'bold', textAlign: 'center', marginBottom: '15px' }}>
              ⚠️ ALREADY CHECKED IN
            </div>
          ) : (
            <button onClick={handleConfirm} disabled={loading} style={{ background: loading ? '#94a3b8' : '#1e3a8a', color: 'white', border: 'none', padding: '16px', borderRadius: '12px', fontSize: '16px', fontWeight: 'bold', cursor: loading ? 'not-allowed' : 'pointer', width: '100%', marginBottom: '12px' }}>
              {loading ? "Processing..." : "CONFIRM DELEGATE"}
            </button>
          )}
          
          <button onClick={handleCancel} disabled={loading} style={{ width: '100%', padding: '14px', background: '#f1f5f9', color: '#475569', borderRadius: '12px', border: 'none', fontSize: '15px', fontWeight: '600', cursor: loading ? 'not-allowed' : 'pointer' }}>
            Cancel & Scan Next
          </button>
        </section>
      )}
    </div>
  );
}