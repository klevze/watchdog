import fs from 'fs';
import ftp from 'basic-ftp';

export default function ftpsAdapter(server = {}, env = process.env) {
  let client = null;

  async function connect() {
    client = new ftp.Client();
    client.ftp.verbose = false;
    const host = server.host;
    const port = server.port || 21;
    const user = server.username || env.WATCHDOG_FTP_USER;
    const password = server.password || env.WATCHDOG_FTP_PASSWORD;
  const secure = server.secure !== undefined ? server.secure : true; // FTPS by default, allow explicit false
    await client.access({ host, port, user, password, secure });
    return adapter;
  }

  async function fastPut(localPath, remotePath) {
    const remote = remotePath.replace(/\\/g, '/');
    await client.ensureDir(remote.substring(0, remote.lastIndexOf('/')) || '/');
    await client.uploadFrom(localPath, remote);
  }

  async function put(bufferOrStream, remotePath) {
    // basic-ftp supports uploadFrom for path or stream
    const remote = remotePath.replace(/\\/g, '/');
    if (bufferOrStream instanceof Buffer) {
      const tmp = `.__watchdog_tmp_${Date.now()}`;
      fs.writeFileSync(tmp, bufferOrStream);
      await fastPut(tmp, remote);
      fs.unlinkSync(tmp);
    } else {
      await client.uploadFrom(bufferOrStream, remote);
    }
  }

  async function deleteRemote(remotePath) {
    try { await client.remove(remotePath); } catch (e) { /* ignore */ }
  }

  async function mkdir(remoteDir) {
    const d = remoteDir.replace(/\\/g, '/');
    await client.ensureDir(d);
  }

  async function rmdir(remoteDir, recursive = false) {
    // basic-ftp has removeDir
    try { await client.removeDir(remoteDir); } catch (e) { /* ignore */ }
  }

  async function list(remoteDir) {
    try { return await client.list(remoteDir); } catch (e) { return []; }
  }

  async function end() { try { client.close(); } catch (e) {} client = null; }

  const adapter = { connect, fastPut, put, delete: deleteRemote, mkdir, rmdir, list, end };
  return adapter;
}
