import React, { useState, useEffect } from 'react';
import DebugSpeedOverlay from '../screens/DebugSpeedOverlay';
import { formatBytes, formatEta } from '../../utils/formatters';
import { pendingStates, queueStateLabel, queuePrompt } from '../../utils/installQueue';
import { iconUrlFor } from '../../BlurIcon';
import PackageThumbnail from '../PackageThumbnail';
import { isPlayStation } from '../../constants/config';

export default function InstallQueueView({ queue, onBack, debugEnabled = false }) {
  const [selectedJobId, setSelectedJobId] = useState(null);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (isPlayStation) return;
        onBack();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onBack]);

  const { overview } = queue;
  const rank = (job) => ['checking', 'preparing', 'installing', 'canceling'].includes(job.state) ? 0 : pendingStates.has(job.state) ? 1 : 2;
  const ordered = [...(queue.jobs || [])].sort((a, b) => rank(a) - rank(b) || a.order - b.order);

  // Identify active or selected hero job
  const activeJob = ordered.find((job) => ['checking', 'preparing', 'installing', 'canceling'].includes(job.state)) ||
    ordered.find((job) => pendingStates.has(job.state)) ||
    ordered[0] ||
    null;

  const heroJob = (selectedJobId && ordered.find((job) => job.id === selectedJobId)) || activeJob;

  const heroActive = heroJob && ['checking', 'preparing', 'installing', 'canceling'].includes(heroJob.state);
  const heroRetryable = heroJob && ['failed', 'canceled', 'blocked'].includes(heroJob.state);
  const heroCancellable = heroJob && pendingStates.has(heroJob.state) && heroJob.state !== 'canceling' && !(heroActive && heroJob.is_direct_storage);
  const heroTitle = heroJob ? (heroJob.title_name || heroJob.path || 'Package') : '';
  const heroLocal = heroJob && heroJob.source_id === queue.sourceId ? queue.files?.find((file) => file.id === heroJob.file_key) : null;
  const heroThumbnail = heroJob ? (heroLocal?.iconUrl || ((!heroJob.source_id || heroJob.state === 'installing') ? iconUrlFor(heroJob.path) : null)) : null;
  const heroPrompt = heroActive ? queuePrompt(heroJob) : '';
  const heroStateLabel = heroJob ? queueStateLabel(heroJob) : '';
  const heroError = heroJob?.error && heroJob.error.trim().toLowerCase() !== heroStateLabel.toLowerCase() ? heroJob.error : '';

  return (
    <div id="install-queue-panel" aria-label="Installation queue" className="max-w-6xl mx-auto px-4 sm:px-8 space-y-6 pb-12">
      {/* Return Button & Breadcrumbs at top */}
      <div className="flex items-center justify-between border-b border-white/10 pb-4">
        <div className="flex items-center space-x-4 min-w-0 flex-1">
          <button
            type="button"
            onClick={onBack}
            className="px-5 py-2.5 rounded-[2px] ps5-focus-item bg-white/5 hover:bg-white/10 border border-white/10 text-base font-semibold transition-all flex items-center space-x-2 text-zinc-200 shrink-0 cursor-pointer"
          >
            <span>&larr;</span>
            <span>Back</span>
          </button>

          <div className="text-sm text-zinc-400 flex items-center space-x-2 min-w-0">
            <span className="shrink-0">PKG Manager</span>
            <span className="shrink-0 text-zinc-600">&rsaquo;</span>
            <span className="text-white font-semibold truncate">Install Queue</span>
          </div>
        </div>

        {overview?.resolved > 0 && (
          <button
            type="button"
            disabled={!queue.connected}
            onClick={queue.clearFinished}
            className="px-4 py-2.5 rounded-[2px] ps5-focus-item bg-white/10 hover:bg-white/15 border border-white/10 text-zinc-200 text-sm font-semibold transition-colors disabled:opacity-50 cursor-pointer shrink-0"
          >
            Clear finished entries
          </button>
        )}
      </div>

      {!queue.connected && (
        <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-[2px] text-sm text-amber-300">
          Connection lost. Queue status will refresh when the app reconnects.
        </div>
      )}

      {overview?.submitted > 0 && (
        <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-[2px] text-xs text-blue-300">
          {overview.submitted} submitted to PS5. Check PS5 Notifications for installation progress and cancellation.
        </div>
      )}

      {/* Option A Layout: Left column (~65% width) & Right column (~35% width) */}
      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Left Column: Active Install Hero (~65% width) */}
        <div className="w-full lg:w-[65%] space-y-6">
          {heroJob ? (
            <div className="rounded-[2px] bg-[#141520] border border-white/10 p-6 space-y-5 shadow-xl">
              <div className="flex flex-col sm:flex-row gap-5">
                <div className="relative w-28 h-28 sm:w-36 sm:h-36 shrink-0 overflow-hidden rounded-[2px] bg-black/50 border border-white/10">
                  <PackageThumbnail src={heroThumbnail} title={heroTitle} small={false} loading="eager" />
                </div>
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="text-xl font-bold text-white break-words leading-tight">{heroTitle}</h2>
                    <span className="px-2 py-0.5 rounded-[2px] text-xs font-semibold uppercase tracking-wider bg-white/10 text-zinc-300 border border-white/10 shrink-0 font-mono">
                      {heroJob.kind}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                    {heroJob.title_id && <span className="font-mono text-zinc-300">{heroJob.title_id}</span>}
                    {heroJob.title_id && <span>·</span>}
                    <span>{formatBytes(heroJob.total_bytes)}</span>
                    <span>·</span>
                    <span>{heroJob.source_id ? 'Browser' : heroJob.path?.startsWith('smb:') ? 'SMB' : 'USB / Disc'}</span>
                  </div>

                  <div className="pt-1">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-[2px] text-xs font-semibold border ${
                      ['failed', 'blocked', 'aborted'].includes(heroJob.state)
                        ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
                        : ['completed', 'submitted'].includes(heroJob.state)
                        ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                        : 'bg-blue-500/10 text-blue-300 border-blue-500/30'
                    }`}>
                      {heroStateLabel}
                    </span>
                  </div>

                  {heroPrompt && <p className="text-xs text-zinc-300 pt-1 break-words">{heroPrompt}</p>}
                  {heroError && <p className="text-xs text-amber-300 pt-1 break-words">{heroError}</p>}
                </div>
              </div>

              {/* Progress Section */}
              <div className="space-y-4 pt-3 border-t border-white/10">
                {/* 1. Current item progress bar */}
                {heroJob.state === 'installing' && !heroJob.is_direct_storage && !heroJob.waiting_for_disc ? (
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-zinc-300 font-medium">Current item progress</span>
                      <span className="text-zinc-400 font-mono">
                        {Math.max(0, heroJob.progress).toFixed(1)}% · {formatBytes(heroJob.downloaded_bytes)} / {formatBytes(heroJob.total_bytes)}
                        {queue.installSpeed > 0 && ` · ${formatBytes(queue.installSpeed)}/s`}
                        {queue.installSpeed > 0 && heroJob.total_bytes > heroJob.downloaded_bytes && formatEta((heroJob.total_bytes - heroJob.downloaded_bytes) / queue.installSpeed) && ` · ${formatEta((heroJob.total_bytes - heroJob.downloaded_bytes) / queue.installSpeed)}`}
                      </span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={`${heroTitle} installation progress`}
                      aria-valuenow={Math.floor(Math.max(0, heroJob.progress))}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="w-full bg-black/60 h-2.5 rounded-[2px] overflow-hidden border border-white/10"
                    >
                      <div
                        className="h-full bg-blue-500 transition-all duration-300"
                        style={{ width: `${Math.min(100, Math.max(0, heroJob.progress))}%` }}
                      />
                    </div>
                  </div>
                ) : heroJob.waiting_for_disc ? (
                  <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-[2px] text-xs text-amber-300">
                    Waiting for next disc / USB part {heroJob.prompt ? `· ${heroJob.prompt}` : ''}
                  </div>
                ) : heroJob.is_direct_storage ? (
                  <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-[2px] text-xs text-blue-300">
                    Submitted to PS5 · Check PS5 Notifications
                  </div>
                ) : heroJob.state === 'completed' ? (
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-zinc-300 font-medium">Current item</span>
                      <span className="text-emerald-400 font-semibold">100% · Complete</span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={`${heroTitle} installation progress`}
                      aria-valuenow={100}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="w-full bg-black/60 h-2.5 rounded-[2px] overflow-hidden border border-white/10"
                    >
                      <div className="h-full bg-emerald-500" style={{ width: '100%' }} />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-zinc-300 font-medium">Current item</span>
                      <span className="text-zinc-400">{heroStateLabel}</span>
                    </div>
                    <div
                      role="progressbar"
                      aria-label={`${heroTitle} installation progress`}
                      aria-valuenow={0}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="w-full bg-black/60 h-2.5 rounded-[2px] overflow-hidden border border-white/10"
                    >
                      <div className="h-full bg-blue-500/20" style={{ width: '0%' }} />
                    </div>
                  </div>
                )}

                {/* 2. Option A: Total queue progress bar directly underneath current item progress bar (when total jobs > 1) */}
                {(queue.jobs.length > 1 || overview?.count > 1) && (
                  <div className="space-y-1.5 pt-2">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-zinc-300 font-medium">Total queue progress</span>
                      <span className="text-zinc-400 font-mono">
                        {overview.percent === null ? 'Working…' : `${Math.floor(overview.percent)}%`}
                        {overview.pending?.length !== undefined && ` · ${overview.pending.length} remaining of ${overview.count}`}
                      </span>
                    </div>
                    <div
                      aria-label="Overall queue progress"
                      role="progressbar"
                      aria-valuenow={overview.percent !== null ? Math.floor(overview.percent) : 0}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="w-full bg-black/60 h-2.5 rounded-[2px] overflow-hidden border border-white/10"
                    >
                      <div
                        className="h-full bg-cyan-500 transition-all duration-300"
                        style={{ width: `${overview.percent !== null ? Math.min(100, Math.max(0, overview.percent)) : 0}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {debugEnabled && heroJob.source_id === queue.sourceId && (
                <div className="pt-2 border-t border-white/10">
                  <DebugSpeedOverlay inline uploadSpeed={queue.uploadSpeed} installSpeed={queue.installSpeed} />
                </div>
              )}

              {/* Actions for Hero Item */}
              {(heroCancellable || heroRetryable) && (
                <div className="flex gap-3 pt-3 border-t border-white/10">
                  {heroCancellable && (
                    <button
                      type="button"
                      disabled={!queue.connected}
                      onClick={() => queue.cancel(heroJob)}
                      className="ps5-focus-item px-4 py-2 bg-red-600/20 hover:bg-red-600/30 border border-red-500/40 text-red-200 text-sm font-semibold rounded-[2px] transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      {heroActive ? 'Cancel install' : 'Remove from queue'}
                    </button>
                  )}
                  {heroRetryable && (
                    <button
                      type="button"
                      disabled={!queue.connected}
                      onClick={() => queue.retry(heroJob)}
                      className="ps5-focus-item px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-[2px] transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      Retry
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-[2px] bg-[#141520] border border-white/10 p-10 text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400">
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-white">Install Queue is Empty</h2>
              <p className="text-sm text-zinc-400 max-w-md mx-auto">
                No installations yet. Install a package to add it here.
              </p>
              <button
                type="button"
                onClick={onBack}
                className="px-5 py-2.5 rounded-[2px] ps5-focus-item bg-blue-600 hover:bg-blue-500 text-white text-sm font-bold transition-colors cursor-pointer"
              >
                Browse Packages
              </button>
            </div>
          )}
        </div>

        {/* Right Column: Queue List Cards (~35% width) */}
        <div className="w-full lg:w-[35%] space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-white/10">
            <h3 className="text-base font-bold text-white">Queue Items</h3>
            <span className="text-xs text-zinc-400">
              {overview?.pending?.length ?? 0} active / pending · {overview?.resolved ?? 0} finished
            </span>
          </div>

          {!ordered.length ? (
            <p className="text-sm text-zinc-400 py-6">No installations yet. Install a package to add it here.</p>
          ) : (
            <div className="space-y-3">
              {ordered.map((job) => {
                const isHero = heroJob?.id === job.id;
                const active = ['checking', 'preparing', 'installing', 'canceling'].includes(job.state);
                const retryable = ['failed', 'canceled', 'blocked'].includes(job.state);
                const cancellable = pendingStates.has(job.state) && job.state !== 'canceling' && !(active && job.is_direct_storage);
                const title = job.title_name || job.path || 'Package';
                const local = job.source_id === queue.sourceId ? queue.files?.find((file) => file.id === job.file_key) : null;
                const thumbnail = local?.iconUrl || ((!job.source_id || job.state === 'installing') ? iconUrlFor(job.path) : null);
                const prompt = active ? queuePrompt(job) : '';
                const stateLabel = queueStateLabel(job);
                const error = job.error && job.error.trim().toLowerCase() !== stateLabel.toLowerCase() ? job.error : '';

                return (
                  <article
                    key={job.id}
                    onClick={() => setSelectedJobId(job.id)}
                    className={`p-3 border rounded-[2px] cursor-pointer transition-all ${
                      isHero
                        ? 'border-blue-500 bg-blue-500/15 shadow-lg'
                        : active
                        ? 'bg-blue-500/5 border-blue-500/30 hover:border-blue-500/60'
                        : 'bg-[#141520] border-white/10 hover:border-white/20'
                    }`}
                  >
                    <div className="flex gap-3">
                      <div className="relative w-14 h-14 shrink-0 overflow-hidden rounded-[2px] bg-black/50 border border-white/10">
                        <PackageThumbnail src={thumbnail} title={title} small loading={active ? 'eager' : 'lazy'} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start gap-2 text-sm">
                          <h4 className="font-semibold text-white truncate text-xs leading-tight" title={title}>
                            {title}
                          </h4>
                          <span className="text-[10px] text-zinc-400 shrink-0 uppercase font-mono">
                            {job.kind}
                          </span>
                        </div>

                        <p className={`text-xs mt-0.5 ${['failed', 'blocked', 'aborted'].includes(job.state) ? 'text-amber-300' : ['completed', 'submitted'].includes(job.state) ? 'text-emerald-400' : 'text-blue-300'}`}>
                          {stateLabel}
                        </p>

                        <p className="text-[11px] text-zinc-400 mt-0.5 truncate font-mono">
                          {job.title_id} · {formatBytes(job.total_bytes)}
                        </p>

                        {prompt && <p className="text-[11px] text-zinc-300 mt-1 break-words">{prompt}</p>}

                        {job.state === 'installing' && !job.is_direct_storage && !job.waiting_for_disc && (
                          <div className="mt-1.5 text-[11px] text-zinc-300">
                            <div className="flex justify-between font-mono text-[10px]">
                              <span>{Math.max(0, job.progress).toFixed(1)}%</span>
                              <span>{formatBytes(job.downloaded_bytes)} / {formatBytes(job.total_bytes)}</span>
                            </div>
                            <div className="h-1 bg-white/10 mt-0.5 overflow-hidden rounded-[1px]">
                              <div className="h-full bg-blue-500" style={{ width: `${Math.min(100, Math.max(0, job.progress))}%` }} />
                            </div>
                          </div>
                        )}

                        {error && <p className="text-[11px] text-amber-300 mt-1 break-words">{error}</p>}

                        {(cancellable || retryable) && (
                          <div className="flex gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                            {cancellable && (
                              <button
                                type="button"
                                disabled={!queue.connected}
                                onClick={() => queue.cancel(job)}
                                className="ps5-focus-item px-2.5 py-1 border border-white/20 rounded-[2px] text-xs hover:bg-red-500/20 disabled:opacity-50 text-zinc-300 cursor-pointer"
                              >
                                {active ? 'Cancel install' : 'Remove from queue'}
                              </button>
                            )}
                            {retryable && (
                              <button
                                type="button"
                                disabled={!queue.connected}
                                onClick={() => queue.retry(job)}
                                className="ps5-focus-item px-2.5 py-1 bg-blue-600 rounded-[2px] text-xs disabled:opacity-50 text-white cursor-pointer"
                              >
                                Retry
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
