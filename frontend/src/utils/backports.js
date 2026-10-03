import { getSourceInfo } from './sourceInfo.js';

const INSTALLED_BACKPORTS_KEY = 'pkg_installed_backports';

export function getBackportTitleId(pkg) {
  const filename = pkg?.filename || (pkg?.path || '').split('/').pop() || '';
  const match = filename.match(/^(PPSA\d{5})-backport\.pkg$/i);
  return match ? match[1].toUpperCase() : null;
}

export function isBackportInstalled(pkg) {
  try {
    const entries = JSON.parse(localStorage.getItem(INSTALLED_BACKPORTS_KEY) || '{}');
    const installed = entries[pkg.path];
    return !!installed &&
      (Number(installed.file_size) || 0) === (Number(pkg.file_size) || 0) &&
      (Number(installed.mtime) || 0) === (Number(pkg.mtime) || 0);
  } catch {
    return false;
  }
}

export function markBackportInstalled(pkg) {
  try {
    const entries = JSON.parse(localStorage.getItem(INSTALLED_BACKPORTS_KEY) || '{}');
    entries[pkg.path] = {
      file_size: Number(pkg.file_size) || 0,
      mtime: Number(pkg.mtime) || 0
    };
    localStorage.setItem(INSTALLED_BACKPORTS_KEY, JSON.stringify(entries));
  } catch {
    return false;
  }
  return true;
}

export function getLinkedBackports(packages, matchingPackages, drives) {
  return packages.flatMap((pkg) => {
    const titleId = getBackportTitleId(pkg);
    if (!titleId) return [];

    const sourceId = getSourceInfo(pkg.path, drives).id;
    const base = packages.find((candidate) =>
      candidate.pkg_type === 'base' &&
      (candidate.title_id || '').toUpperCase() === titleId &&
      getSourceInfo(candidate.path, drives).id === sourceId
    );
    if (!base) return [];

    const isVisible = matchingPackages.some((candidate) =>
      candidate === pkg ||
      ((candidate.title_id || '').toUpperCase() === titleId &&
       getSourceInfo(candidate.path, drives).id === sourceId)
    );
    return isVisible ? [{ pkg, base }] : [];
  });
}
