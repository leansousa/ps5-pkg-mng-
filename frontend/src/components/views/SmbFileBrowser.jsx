import { canQueuePackage, pendingStates } from '../../utils/installQueue';
import React, { useEffect, useRef, useState } from 'react';
import { browseSmb, inspectSmb } from '../../api/smb';
import { formatBytes } from '../../utils/formatters';

export default function SmbFileBrowser({ share, onBack, onInstall, installQueue }) {
  const root = (share.path || '').replace(/^\/+|\/+$/g, '');
  const [path, setPath] = useState(root);
  const [cursors, setCursors] = useState(['']);
  const [entries, setEntries] = useState([]);
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [selected, setSelected] = useState(null);
  const request = useRef(0);
  const cursor = cursors[cursors.length - 1];
  const jobs = installQueue?.jobs || [];
  const queueable = selected && canQueuePackage(selected, jobs);
  const queued = selected && jobs.some((job) => job.path === selected.path && pendingStates.has(job.state));
  const queueBusy = jobs.some((job) => pendingStates.has(job.state));
  const button = 'ps5-focus-item px-4 py-2 bg-white/10 hover:bg-white/20 rounded-[2px] disabled:opacity-40';

  useEffect(() => {
    const id = ++request.current;
    setBusy(true);
    setError('');
    setSelected(null);
    setEntries([]);
    setNext('');
    browseSmb({ ...share, path, after: cursor }).then((data) => {
      if (id !== request.current) return;
      if (!data.success) throw new Error(data.error || 'Could not open folder');
      setEntries(data.entries || []);
      setNext(data.next_cursor || '');
    }).catch((err) => { if (id === request.current) setError(err.message); })
      .finally(() => { if (id === request.current) setBusy(false); });
    return () => { request.current++; };
  }, [share, path, cursor, attempt]);

  const openFolder = (folder) => {
    if (folder.length >= 256) { setError('This folder path is too long to browse. Configure it as a separate share folder.'); return; }
    setPath(folder);
    setCursors(['']);
  };
  const selectFile = async (entry) => {
    const id = ++request.current;
    setBusy(true);
    setError('');
    setSelected(null);
    const port = share.port && Number(share.port) !== 445 ? `:${share.port}` : '';
    const filePath = `smb://${share.server}${port}/${share.share}/${path ? `${path}/` : ''}${entry.name}`;
    try {
      const pkg = await inspectSmb(filePath);
      if (id === request.current) setSelected(pkg);
    } catch (err) { if (id === request.current) setError(err.message); }
    finally { if (id === request.current) setBusy(false); }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 space-y-4 text-zinc-200">
      <div className="flex items-center space-x-4">
        <button className={button} onClick={onBack}>Back</button>
        <h2 className="text-xl font-bold">{share.label || share.share} — Browse files</h2>
      </div>
      <p className="text-sm text-zinc-400">Open a folder and select a PKG. Only the selected file’s metadata is read.</p>
      <p className="font-mono break-all">/{path}</p>
      {path !== root && <button className={button} disabled={busy} onClick={() => openFolder(path.split('/').slice(0, -1).join('/'))}>Up one folder</button>}
      {busy && <p role="status">Loading…</p>}
      {error && <div className="space-y-2"><p role="alert" className="text-rose-300">{error}</p>
        <button className={button} disabled={busy} onClick={() => setAttempt(attempt + 1)}>Reload folder</button></div>}
      {selected && <div className="p-4 border border-cyan-500/40 space-y-3">
        <h3 className="font-bold">{selected.title_name}</h3>
        <p>{selected.title_id} · {selected.pkg_type} · {selected.app_version} · {formatBytes(selected.total_pkg_size || selected.file_size)}</p>
        {!queueable && !queued && <p>{selected.install_disabled_reason}</p>}
        <button className={button} disabled={busy || !queueable} onClick={async () => {
          setBusy(true);
          try { await onInstall(selected); } finally { setBusy(false); }
        }}>{queued ? 'Queued' : queueBusy ? 'Queue selected PKG' : 'Install selected PKG'}</button>
      </div>}
      <div className="space-y-1">
        {entries.map((entry) => <button key={entry.name} disabled={busy}
          className={`${button} w-full flex justify-between text-left`}
          onClick={() => entry.is_dir ? openFolder(path ? `${path}/${entry.name}` : entry.name) : selectFile(entry)}>
          <span className="break-all">{entry.is_dir ? 'Folder: ' : ''}{entry.name}</span>
          {!entry.is_dir && <span className="shrink-0 ml-4 text-zinc-400">{formatBytes(entry.size)}</span>}
        </button>)}
      </div>
      {!busy && !error && entries.length === 0 && <p>No folders or PKG files here.</p>}
      <div className="flex items-center space-x-4">
        <button className={button} disabled={busy || cursors.length === 1} onClick={() => setCursors(cursors.slice(0, -1))}>Previous</button>
        <span>Page {cursors.length}</span>
        <button className={button} disabled={busy || !next} onClick={() => setCursors([...cursors, next])}>Next</button>
      </div>
    </div>
  );
}
