import { createClient } from 'webdav';
import fs from 'fs';

export default function webdavAdapter(server = {}, env = process.env) {
  const url = server.url || server.host;
  if (!url) throw new Error('webdav adapter requires server.url or server.host');
  const username = server.username || env.WEBDAV_USER;
  const password = server.password || env.WEBDAV_PASSWORD;
  const client = createClient(url, { username, password });

  async function connect() { return adapter; }

  async function fastPut(localPath, remotePath) {
    const remote = remotePath.replace(/\\/g, '/');
    const dir = remote.substring(0, remote.lastIndexOf('/')) || '/';
    try { await client.createDirectory(dir); } catch (e) { /* ignore */ }
    const stream = fs.createReadStream(localPath);
    await client.putFileContents(remote, stream, { overwrite: true });
  }

  async function put(bufferOrStream, remotePath) {
    const remote = remotePath.replace(/\\/g, '/');
    await client.putFileContents(remote, bufferOrStream, { overwrite: true });
  }

  async function deleteRemote(remotePath) { try { await client.deleteFile(remotePath); } catch (e) {} }
  async function mkdir(remoteDir) { try { await client.createDirectory(remoteDir); } catch (e) {} }
  async function rmdir(remoteDir) { try { await client.deleteFile(remoteDir); } catch (e) {} }
  async function list(remoteDir) { try { return await client.getDirectoryContents(remoteDir); } catch (e) { return []; } }
  async function end() { /* no-op */ }

  const adapter = { connect, fastPut, put, delete: deleteRemote, mkdir, rmdir, list, end };
  return adapter;
}
