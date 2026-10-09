let owner;
export function getQueueOwner() {
  if (!owner) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    owner = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return owner;
}

async function request(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch('/api/queue' + path, body === undefined ? { signal: controller.signal } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok || data.success === false) throw new Error(data.error || 'Queue request failed');
    return data;
  } finally { clearTimeout(timeout); }
}

export const getInstallQueue = () => request('');
export const enqueueJobs = (jobs) => request('', { jobs });
export const cancelQueueJob = (id) => request('/cancel', { id });
export const retryQueueJob = (id) => request('/retry', { id });
export const clearFinishedJobs = () => request('/clear', {});
export const heartbeatQueue = () => request('/heartbeat', { owner: getQueueOwner() });
export const attachBrowserJob = (id, owner, path) => request('/attach', { id, owner, path });

export function disconnectQueueSource() {
  if (!owner) return;
  const body = JSON.stringify({ owner });
  if (navigator.sendBeacon?.('/api/queue/disconnect', new Blob([body], { type: 'application/json' }))) return;
  fetch('/api/queue/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
}

export function packageJob(pkg) {
  return { path: pkg.path, title_id: pkg.title_id || '', title_name: pkg.title_name || '',
    content_id: pkg.content_id || '', kind: pkg.pkg_type || 'unknown',
    version: pkg.app_version || '', total_bytes: Number(pkg.total_pkg_size || pkg.file_size) || 0 };
}
