import fs from 'fs';

export function isLargeFile(path, maxFileSizeBytes) {
  if (!maxFileSizeBytes || maxFileSizeBytes <= 0) return false;
  try {
    const s = fs.statSync(path);
    return s.isFile() && s.size > maxFileSizeBytes;
  } catch (e) {
    return false; // if file missing, not a large file here
  }
}
