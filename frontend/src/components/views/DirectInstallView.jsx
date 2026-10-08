import React, { useRef, useState } from 'react';
import { collectDroppedPkgFiles, collectInputPkgFiles } from '../../utils/collectPkgFiles';
import { pendingStates, queueStateLabel, canQueueBrowserFile } from '../../utils/installQueue';
import { formatBytes, formatVersion } from '../../utils/formatters';
import { getPlatform } from '../../utils/platform';
import PackageThumbnail from '../PackageThumbnail';

export default function DirectInstallView({ queue, onBack, onOpenQueue }) {
  const input = useRef(null);
  const [reading, setReading] = useState(false);
  const ownJob = (local) => [...queue.jobs].reverse().find((job) => job.file_key === local.id && job.source_id === queue.sourceId);
  const ready = queue.files.filter((local) => canQueueBrowserFile(local, queue.jobs, queue.sourceId, queue.files));
  const collect = async (selection, dropped) => {
    setReading(true);
    try {
      const result = dropped ? await collectDroppedPkgFiles(selection) : { files: collectInputPkgFiles(selection), unreadable: [] };
      await queue.addFiles(result.files, result.unreadable);
    } finally { setReading(false); }
  };
  return (
    <div className="max-w-6xl mx-auto space-y-5" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
      event.preventDefault(); event.__pkgManagerDropHandled = true;
      collect(event.dataTransfer, true);
    }}>
      <div className="flex items-center justify-between gap-3">
        <button type="button" onClick={onBack} className="ps5-focus-item px-4 py-2 bg-white/10 rounded-[2px]">← Back</button>
        <button type="button" onClick={onOpenQueue} className="ps5-focus-item px-4 py-2 bg-blue-600 rounded-[2px]">Open install queue</button>
      </div>
      <div className="border border-dashed border-white/20 bg-white/5 p-6 space-y-3 rounded-[2px]">
        <h2 className="text-xl font-bold">Direct Install</h2>
        <p className="text-sm text-zinc-300">Choose or drop PKG files. Keep this tab open while its queued packages stream to your PS5. You can browse the app during installation.</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={() => input.current.click()} className="ps5-focus-item px-4 py-2 bg-white/10 rounded-[2px]">Choose packages</button>
          <button type="button" disabled={!ready.length || !queue.connected} onClick={() => queue.enqueueFiles(ready.map((local) => local.id))} className="ps5-focus-item px-4 py-2 bg-blue-600 disabled:opacity-40 rounded-[2px]">Install all ({ready.length})</button>
        </div>
        <input ref={input} type="file" multiple accept=".pkg" className="hidden" onChange={(event) => { collect(event.target.files, false); event.target.value = ''; }} />
        {reading && <p className="text-sm text-blue-300">Reading packages…</p>}
      </div>
      {queue.skipped.length > 0 && <p className="text-sm text-amber-300">{queue.skipped.length} unreadable file(s) skipped.</p>}
      {queue.files.length > 0 && <div className="flex flex-wrap justify-between gap-2 text-xs text-zinc-400">
        <span>{queue.files.length} package{queue.files.length === 1 ? '' : 's'} · {ready.length} ready to install</span>
      </div>}
      <div aria-label="Selected packages" className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {queue.files.map((local) => {
          const job = ownJob(local);
          const pending = job && pendingStates.has(job.state);
          const canCancel = pending && job.state !== 'canceling' && !job.is_direct_storage;
          const canQueue = canQueueBrowserFile(local, queue.jobs, queue.sourceId);
          const platform = getPlatform(local.details?.title_id);
          const kind = local.details?.pkg_type;
          const title = local.details?.title_name || local.file.name;
          const problem = local.error || job?.error || (!pending && job?.state !== 'completed' && local.eligibility?.can_install === false ? local.eligibility.install_disabled_reason : '');
          return (
            <article key={local.id} className="min-w-0 flex flex-col p-2.5 bg-[#141520] border border-white/10 rounded-[2px]">
              <div className="aspect-square-box rounded-[2px] overflow-hidden bg-black/50 border border-white/10">
                <div className="aspect-square-content overflow-hidden">
                  <PackageThumbnail src={local.iconUrl} title={title} />
                  {platform && <span className={`absolute top-2 right-2 z-20 px-2 py-0.5 rounded-[2px] text-[10px] font-bold border pointer-events-none ${platform === 'PS5' ? 'bg-white text-black border-white' : 'bg-zinc-900 text-zinc-200 border-zinc-600'}`}>{platform}</span>}
                  {kind && <span className={`absolute bottom-2 right-2 z-20 px-2 py-0.5 rounded-[2px] text-[10px] font-bold border uppercase pointer-events-none ${kind === 'update' ? 'bg-purple-600 text-white border-purple-400/60' : kind === 'dlc' ? 'bg-emerald-600 text-white border-emerald-400/60' : 'bg-blue-600 text-white border-blue-400/60'}`}>{kind}</span>}
                </div>
              </div>
              <div className="flex-1 min-w-0 pt-3 pb-3 space-y-1.5">
                <h3 className="text-sm font-semibold break-words">{title}</h3>
                <p className="text-xs text-zinc-400 truncate" title={local.path || local.file.name}>{local.path || local.file.name}</p>
                <p className="text-xs text-zinc-400">{[local.details?.title_id, formatVersion(local.details?.app_version), formatBytes(local.file.size)].filter(Boolean).join(' · ')}</p>
                <p className={`text-xs ${problem ? 'text-amber-300' : job?.state === 'completed' ? 'text-emerald-300' : 'text-blue-300'}`}>{job ? queueStateLabel(job) : local.status === 'reading' ? 'Reading package…' : local.status === 'error' ? 'Unable to read package' : canQueue ? 'Ready' : 'Not installable'}</p>
                {job?.state === 'installing' && <div role="progressbar" aria-label={`${title} installation progress`} aria-valuenow={Math.floor(Math.max(0, job.progress))} aria-valuemin={0} aria-valuemax={100} className="h-1 bg-white/10">
                  <div className="h-full bg-blue-500" style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }} />
                </div>}
                {problem && <p className="text-xs text-amber-300 break-words">{problem}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={!queue.connected || (pending ? !canCancel : !canQueue)} onClick={() => pending ? queue.cancel(job) : queue.enqueueFiles([local.id])} className="ps5-focus-item flex-1 text-xs px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-[2px]">{job?.state === 'completed' ? 'Installed' : pending ? ['queued', 'blocked'].includes(job.state) ? 'Unqueue' : 'Cancel install' : 'Install'}</button>
                <button type="button" disabled={Boolean(pending)} onClick={() => queue.removeFile(local.id)} className="ps5-focus-item text-xs px-3 py-2 bg-white/10 hover:bg-white/20 disabled:opacity-40 rounded-[2px]">Cancel</button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
