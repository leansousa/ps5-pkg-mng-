export async function pollStatus() {
  const res = await fetch('/api/poll');
  if (!res.ok) throw new Error(`Poll failed: ${res.status}`);
  return res.json();
}
