import fs from 'fs';

// Google Cloud Storage adapter. Lazily imports @google-cloud/storage on connect.
export default function gcsAdapter(server = {}, env = process.env) {
  const bucketName = server.bucket || env.WATCHDOG_GCS_BUCKET;
  if (!bucketName) throw new Error('GCS adapter requires server.bucket or WATCHDOG_GCS_BUCKET');

  let Storage = null; // class from @google-cloud/storage
  let bucket = null;

  async function connect() {
    if (!Storage) {
      const mod = await import('@google-cloud/storage');
      Storage = mod.Storage;
    }
    const opts = {};
    if (server.projectId) opts.projectId = server.projectId;
    if (server.keyFilename || env.GOOGLE_APPLICATION_CREDENTIALS) {
      opts.keyFilename = server.keyFilename || env.GOOGLE_APPLICATION_CREDENTIALS;
    }
    if (server.credentials) {
      opts.credentials = server.credentials; // { client_email, private_key }
    }
    const storage = new Storage(opts);
    bucket = storage.bucket(bucketName);
    return adapter;
  }

  function keyFromRemotePath(remotePath) {
    return String(remotePath || '').replace(/^\/+/, '');
  }

  async function fastPut(localPath, remotePath) {
    if (!bucket) throw new Error('GCS client not connected');
    const destination = keyFromRemotePath(remotePath);
    await bucket.upload(localPath, { destination });
  }

  async function put(bufferOrStream, remotePath) {
    if (!bucket) throw new Error('GCS client not connected');
    const key = keyFromRemotePath(remotePath);
    const file = bucket.file(key);
    if (Buffer.isBuffer(bufferOrStream)) {
      await file.save(bufferOrStream);
    } else if (bufferOrStream && typeof bufferOrStream.pipe === 'function') {
      await new Promise((resolve, reject) => {
        const ws = file.createWriteStream();
        bufferOrStream.pipe(ws).on('error', reject).on('finish', resolve);
      });
    } else if (typeof bufferOrStream === 'string' && fs.existsSync(bufferOrStream)) {
      await bucket.upload(bufferOrStream, { destination: key });
    } else {
      throw new Error('Unsupported body for GCS put');
    }
  }

  async function deleteObject(remotePath) {
    if (!bucket) throw new Error('GCS client not connected');
    const key = keyFromRemotePath(remotePath);
    const file = bucket.file(key);
    try { await file.delete(); } catch (e) { /* ignore 404s */ }
  }

  async function list(prefix) {
    if (!bucket) throw new Error('GCS client not connected');
    const Key = keyFromRemotePath(prefix);
    const [files] = await bucket.getFiles({ prefix: Key });
    return files.map(f => ({ name: f.name, size: f.metadata && f.metadata.size ? parseInt(f.metadata.size, 10) : 0 }));
  }

  async function mkdir() { /* no-op for object storage */ }
  async function rmdir() { /* no-op for object storage */ }
  async function end() { bucket = null; }

  const adapter = { connect, fastPut, put, delete: deleteObject, mkdir, rmdir, list, end };
  return adapter;
}
