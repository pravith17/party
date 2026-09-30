export const reserved = new Set(['admin','api','assets','uploads','demo','favicon.ico','robots.txt']);
export function slugify(value) { return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0,80); }
export function validSlug(value) { return /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(value) && !reserved.has(value); }
export function youtubeId(value) {
  if (!value) return '';
  try { const u = new URL(value); let id = '';
    if (u.hostname === 'youtu.be') id = u.pathname.slice(1);
    else if (['youtube.com','www.youtube.com','m.youtube.com','music.youtube.com'].includes(u.hostname)) id = u.searchParams.get('v') || u.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] || '';
    return /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}
export function cleanText(v, max=1000) { return typeof v === 'string' ? v.trim().slice(0,max) : ''; }
