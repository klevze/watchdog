import fs from 'fs';
import path from 'path';
import tus from 'tus-js-client';

export default function tusAdapter(server = {}, env = process.env) {
  const endpoint = server.endpoint || env.TUS_ENDPOINT;
  if (!endpoint) throw new Error('tus adapter requires server.endpoint or TUS_ENDPOINT');

  async function connect() { return adapter; }

  async function fastPut(localPath, remotePath) {
    // remotePath may be used as metadata.filename
    await new Promise((resolve, reject) => {
      const upload = new tus.Upload(fs.createReadStream(localPath), {
        endpoint,
        metadata: { filename: path.basename(remotePath) },
        onError: function(error) { reject(error); },
        onSuccess: function() { resolve(); }
      });
      upload.start();
    });
  }

  async function put(bufferOrStream, remotePath) {
    // tus-js-client supports blobs/streams; write to temp file if buffer
    if (bufferOrStream instanceof Buffer) {
      const tmp = `.__watchdog_tmp_${Date.now()}`;
      fs.writeFileSync(tmp, bufferOrStream);
      try { await fastPut(tmp, remotePath); } finally { fs.unlinkSync(tmp); }
    } else {
      await fastPut(bufferOrStream.path || bufferOrStream, remotePath);
    }
  }

  async function deleteRemote() { throw new Error('tus adapter does not support delete'); }
  async function mkdir() { return; }
  async function rmdir() { return; }
  async function list() { return []; }
  async function end() { }

  const adapter = { connect, fastPut, put, delete: deleteRemote, mkdir, rmdir, list, end };
  return adapter;
}
