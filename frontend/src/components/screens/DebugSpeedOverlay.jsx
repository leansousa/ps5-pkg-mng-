import React, { useEffect, useRef, useState } from 'react';
import { formatBytes } from '../../utils/formatters';

const SAMPLE_COUNT = 30;

function linePath(samples, key, maxValue) {
  if (!samples.length) return '';
  const width = 240;
  const height = 64;
  return samples.map((sample, index) => {
    const x = samples.length > 1 ? (index / (SAMPLE_COUNT - 1)) * width : width;
    const y = height - Math.min(1, sample[key] / maxValue) * height;
    return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

export default function DebugSpeedOverlay({ uploadSpeed, installSpeed, inline = false }) {
  const [samples, setSamples] = useState([]);
  const latestRef = useRef({ uploadSpeed, installSpeed });

  useEffect(() => {
    latestRef.current = { uploadSpeed, installSpeed };
  }, [uploadSpeed, installSpeed]);

  useEffect(() => {
    const timer = setInterval(() => {
      const latest = latestRef.current;
      setSamples((previous) => previous.concat({
        upload: latest.uploadSpeed || 0,
        install: latest.installSpeed || 0
      }).slice(-SAMPLE_COUNT));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const maxValue = Math.max(100 * 1024 * 1024, ...samples.flatMap((sample) => [sample.upload, sample.install]));

  return (
    <aside className={`pointer-events-none ${inline ? 'w-full' : 'fixed top-3 right-3 z-[60] w-72'} rounded-lg border border-white/15 bg-[#090b12]/95 p-3 text-white shadow-2xl backdrop-blur-sm`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400">Debug speeds</span>
        <span className="text-[10px] text-zinc-500">30s</span>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2 font-mono">
        <div>
          <div className="text-[10px] text-cyan-300">WS receive</div>
          <div className="text-sm font-semibold">{formatBytes(uploadSpeed)}/s</div>
        </div>
        <div>
          <div className="text-[10px] text-amber-300">Installer stream</div>
          <div className="text-sm font-semibold">{formatBytes(installSpeed)}/s</div>
        </div>
      </div>
      <svg className="w-full h-[76px] rounded bg-black/25" viewBox="0 0 240 64" preserveAspectRatio="none" role="img" aria-label="WebSocket upload and installer stream speed history">
        {[16, 32, 48].map((y) => <line key={y} x1="0" y1={y} x2="240" y2={y} stroke="rgba(255,255,255,0.1)" strokeWidth="1" />)}
        <path d={linePath(samples, 'upload', maxValue)} fill="none" stroke="#67e8f9" strokeWidth="2" />
        <path d={linePath(samples, 'install', maxValue)} fill="none" stroke="#fbbf24" strokeWidth="2" />
      </svg>
    </aside>
  );
}
