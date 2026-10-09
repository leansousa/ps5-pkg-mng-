import React, { useState } from 'react';

// Shared fallback for locally extracted artwork and console-served icons.
// Keep a failed image hidden until its source changes.
export default function PackageThumbnail({ src, title, small = false, loading = 'lazy' }) {
  const [failedSrc, setFailedSrc] = useState(null);
  return <>
    <div className="absolute inset-0 flex items-center justify-center text-zinc-600 pointer-events-none" aria-hidden="true">
      <svg className={small ? 'w-6 h-6' : 'w-12 h-12'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    </div>
    {src && src !== failedSrc && <img src={src} alt={`${title} thumbnail`} loading={loading} decoding="async" onError={() => setFailedSrc(src)} className="absolute inset-0 w-full h-full object-cover z-10 block" />}
  </>;
}
