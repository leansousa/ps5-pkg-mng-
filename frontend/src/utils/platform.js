export function getPlatform(titleId) {
  const normalized = String(titleId || '').trim().toUpperCase();
  if (normalized.startsWith('PPSA')) return 'PS5';
  if (normalized.startsWith('CUSA')) return 'PS4';
  return null;
}
