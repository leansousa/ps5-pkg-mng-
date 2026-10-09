import { getSourceInfo } from './sourceInfo.js';

export function getBackportTitleId(pkg) {
  const filename = pkg?.filename || (pkg?.path || '').split('/').pop() || '';
  const match = filename.match(/^(PPSA\d{5})-backport\.pkg$/i);
  return match ? match[1].toUpperCase() : null;
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
