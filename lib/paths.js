import path from 'path';

export function toRel(sourceDir, p) {
  return path.relative(sourceDir, p).replace(/\\/g, '/');
}

export function normalizeRemote(remoteBase, relPath) {
  const rp = `${remoteBase}/${String(relPath || '')}`.replace(/\\/g, '/');
  return path.posix.normalize(rp);
}

export function isSafeRemotePath(remoteBase, rp) {
  const base = path.posix.normalize(String(remoteBase || ''));
  const norm = path.posix.normalize(String(rp || ''));
  return norm === base || norm.startsWith(base + '/');
}
