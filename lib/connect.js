import { selectAuth } from './auth.js';

// A testable ensureConnected that accepts an injectable SFTP client class.
export async function ensureConnected({ server = {}, SFTPClientClass, env = process.env, authFlag, privateKey }) {
  if (!SFTPClientClass) throw new Error('SFTPClientClass is required');
  const client = new SFTPClientClass();
  // merge available auth sources into a server-like object for selectAuth
  const serverForAuth = Object.assign({}, server);
  if (privateKey) serverForAuth.privateKey = privateKey;

  const auth = selectAuth(serverForAuth, env, authFlag);
  const connOpts = {
    host: server.host,
    port: server.port || 22,
    username: server.username
  };
  if (auth.method === 'key') {
    connOpts.privateKey = Buffer.isBuffer(auth.privateKey) ? auth.privateKey : Buffer.from(String(auth.privateKey));
  } else if (auth.method === 'password') {
    connOpts.password = auth.password;
  }
  await client.connect(connOpts);
  // attempt to ensure remote base dir exists if client provides mkdir
  const remoteBase = (server.remoteBaseDir || '').replace(/\\/g, '/');
  if (remoteBase && typeof client.mkdir === 'function') {
    try { await client.mkdir(remoteBase, true); } catch (e) { /* ignore */ }
  }
  return client;
}
