import path from 'path';

export async function uploadFile(localAbs, { sftp, remoteBase, dryRun, mkdirp, rel, stats }) {
  const rPath = `${remoteBase}/${rel(localAbs)}`.replace(/\\/g, '/');
  const rDir = rPath.substring(0, rPath.lastIndexOf('/') ) || remoteBase;
  if (dryRun) return { dryRun: true, action: 'upload', path: rPath };
  await mkdirp(rDir);
  await sftp.fastPut(localAbs, rPath);
  if (stats) stats.uploaded = (stats.uploaded || 0) + 1;
  return { dryRun: false, action: 'upload', path: rPath };
}

export async function deleteRemote(localAbs, { sftp, remoteBase, dryRun, rel, stats }) {
  const rPath = `${remoteBase}/${rel(localAbs)}`.replace(/\\/g, '/');
  if (dryRun) return { dryRun: true, action: 'delete', path: rPath };
  await sftp.delete(rPath);
  if (stats) stats.deleted = (stats.deleted || 0) + 1;
  return { dryRun: false, action: 'delete', path: rPath };
}

export async function createRemoteDir(localAbs, { sftp, remoteBase, dryRun, mkdirp, rel, stats }) {
  const rPath = `${remoteBase}/${rel(localAbs)}`.replace(/\\/g, '/');
  if (dryRun) return { dryRun: true, action: 'mkdir', path: rPath };
  await mkdirp(rPath);
  if (stats) stats.createdDir = (stats.createdDir || 0) + 1;
  return { dryRun: false, action: 'mkdir', path: rPath };
}

export async function deleteRemoteDir(localAbs, { sftp, remoteBase, dryRun, rel, stats }) {
  const rPath = `${remoteBase}/${rel(localAbs)}`.replace(/\\/g, '/');
  if (dryRun) return { dryRun: true, action: 'rmdir', path: rPath };
  await sftp.rmdir(rPath, true);
  if (stats) stats.removedDir = (stats.removedDir || 0) + 1;
  return { dryRun: false, action: 'rmdir', path: rPath };
}
