export function formatBytes(bytes) {
  const b = Number(bytes);
  if (!b || b <= 0 || !isFinite(b)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(b) / Math.log(k)), sizes.length - 1);
  return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function formatEta(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return null;
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}m ${secs}s`;
  }
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  return `${hrs}h ${mins}m`;
}

export function formatVersion(ver) {
  if (!ver) return '';
  const clean = String(ver).trim().replace(/^v+/i, '');
  return clean ? `v${clean}` : '';
}
