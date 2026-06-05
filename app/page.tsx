"use client";
import dynamic from 'next/dynamic';

// Dynamically import the scanner so Next.js doesn't crash on the server
const CameraScanner = dynamic(() => import('./Scanner'), {
  ssr: false,
  loading: () => <div style={{ padding: '50px', textAlign: 'center' }}>Starting camera...</div>
});

export default function Home() {
  return (
    <main style={{ maxWidth: '500px', margin: '0 auto', padding: '20px', textAlign: 'center', fontFamily: 'sans-serif' }}>
      <CameraScanner />
    </main>
  );
}