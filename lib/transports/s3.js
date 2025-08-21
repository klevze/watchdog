import fs from 'fs';
import path from 'path';
import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

// Simple multipart uploader with local checkpointing to allow resume on process restart.
export default function s3Adapter(server = {}, env = process.env) {
  const bucket = server.bucket || env.WATCHDOG_S3_BUCKET;
  if (!bucket) throw new Error('S3 adapter requires server.bucket or WATCHDOG_S3_BUCKET');
  const region = server.region || server.signingRegion || env.AWS_REGION;
  const endpoint = server.endpoint || server.s3Endpoint || env.WATCHDOG_S3_ENDPOINT;
  const forcePathStyle = server.forcePathStyle === true || String(env.WATCHDOG_S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true';

  let client = null;

  function getClient() {
    return client || adapter.client || null;
  }

  function checkpointPath(key) {
    // store checkpoint per-key in .watchdog_s3
    const dir = path.resolve(process.cwd(), '.watchdog_s3');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    // sanitize key into filename
    const filename = key.replace(/[^a-zA-Z0-9-_\.]/g, '_');
    return path.join(dir, filename + '.json');
  }

  async function connect() {
    const opts = {};
    if (region) opts.region = region;
    if (endpoint) opts.endpoint = endpoint;
    if (forcePathStyle) opts.forcePathStyle = true;
    // expose options for tests
    adapter._clientOptions = opts;
    // credentials via env is supported by default by SDK
    client = new S3Client(opts);
    return adapter;
  }

  async function fastPut(localPath, remotePath) {
    const key = remotePath.replace(/^\/+/, '');
    const stats = fs.statSync(localPath);
    const size = stats.size;
    // Use multipart for files > 5MB
    if (size < 5 * 1024 * 1024) {
      const body = fs.createReadStream(localPath);
      const c = getClient();
      if (!c) throw new Error('S3 client not connected');
      await c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
      return;
    }

    // multipart upload with resume
    const cpPath = checkpointPath(key);
    let cp = null;
    if (fs.existsSync(cpPath)) {
      try { cp = JSON.parse(fs.readFileSync(cpPath, 'utf8')); } catch (e) { cp = null; }
    }

    if (!cp || !cp.UploadId) {
      // create multipart
      const c = getClient();
      if (!c) throw new Error('S3 client not connected');
      const create = await c.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }));
      cp = { UploadId: create.UploadId, Parts: [] };
      fs.writeFileSync(cpPath, JSON.stringify(cp));
    }

    const partSize = 5 * 1024 * 1024; // 5MB
    const totalParts = Math.ceil(size / partSize);

    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      if (cp.Parts && cp.Parts.some(p => p.PartNumber === partNumber)) continue; // already uploaded
      const start = (partNumber - 1) * partSize;
      const end = Math.min(start + partSize, size);
      const stream = fs.createReadStream(localPath, { start, end: end - 1 });
  const c = getClient();
  if (!c) throw new Error('S3 client not connected');
  const up = await c.send(new UploadPartCommand({ Bucket: bucket, Key: key, PartNumber: partNumber, UploadId: cp.UploadId, Body: stream }));
      cp.Parts.push({ PartNumber: partNumber, ETag: up.ETag });
      fs.writeFileSync(cpPath, JSON.stringify(cp));
    }

    // complete
    const sorted = cp.Parts.slice().sort((a,b) => a.PartNumber - b.PartNumber);
  const c2 = getClient();
  if (!c2) throw new Error('S3 client not connected');
  await c2.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: cp.UploadId, MultipartUpload: { Parts: sorted } }));
    try { fs.unlinkSync(cpPath); } catch (e) {}
  }

  async function put(bufferOrStream, remotePath) {
    const key = remotePath.replace(/^\/+/, '');
  const c = getClient();
  if (!c) throw new Error('S3 client not connected');
  await c.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bufferOrStream }));
  }

  async function deleteObject(remotePath) {
    const key = remotePath.replace(/^\/+/, '');
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async function list(prefix) {
  const Key = (prefix || '').replace(/^\/+/, '');
  const c = getClient();
  if (!c) throw new Error('S3 client not connected');
  const out = await c.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: Key, MaxKeys: 100 }));
    return (out.Contents || []).map(c => ({ name: c.Key, size: c.Size }));
  }

  async function mkdir() { /* no-op for S3 */ }
  async function rmdir() { /* no-op for S3 */ }
  async function end() { client = null; }

  const adapter = { connect, fastPut, put, delete: deleteObject, mkdir, rmdir, list, end };
  return adapter;
}
