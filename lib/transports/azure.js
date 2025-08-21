import fs from 'fs';
import path from 'path';

// Azure Blob Storage adapter. Lazily imports SDK when connect() is called.
export default function azureAdapter(server = {}, env = process.env) {
  const containerName = server.container || env.WATCHDOG_AZURE_CONTAINER;
  if (!containerName) throw new Error('Azure adapter requires server.container or WATCHDOG_AZURE_CONTAINER');

  let sdk = null; // { BlobServiceClient, StorageSharedKeyCredential }
  let containerClient = null;

  async function connect() {
    if (!sdk) {
      // Lazy import SDK so this adapter can be created without the package installed
      sdk = await import('@azure/storage-blob');
    }
    const { BlobServiceClient, StorageSharedKeyCredential } = sdk;

    const connStr = server.connectionString || env.AZURE_STORAGE_CONNECTION_STRING;
    let serviceClient;
    if (connStr) {
      serviceClient = BlobServiceClient.fromConnectionString(connStr);
    } else if (server.accountName && (server.accountKey || env.AZURE_STORAGE_KEY)) {
      const accountName = server.accountName;
      const accountKey = server.accountKey || env.AZURE_STORAGE_KEY;
      const credential = new StorageSharedKeyCredential(accountName, accountKey);
      const endpoint = server.endpoint || `https://${accountName}.blob.core.windows.net`;
      serviceClient = new BlobServiceClient(endpoint, credential);
    } else if (server.accountName && (server.sasToken || env.AZURE_STORAGE_SAS)) {
      const accountName = server.accountName;
      const sas = server.sasToken || env.AZURE_STORAGE_SAS; // should include leading '?'
      const endpoint = (server.endpoint || `https://${accountName}.blob.core.windows.net`) + sas;
      serviceClient = new BlobServiceClient(endpoint);
    } else {
      throw new Error('Azure adapter requires connectionString, or accountName with accountKey or sasToken');
    }

    containerClient = serviceClient.getContainerClient(containerName);
    try { await containerClient.createIfNotExists(); } catch (e) { /* ignore */ }
    return adapter;
  }

  async function fastPut(localPath, remotePath) {
    if (!containerClient) throw new Error('Azure client not connected');
    const key = remotePath.replace(/^\/+/, '');
    const block = containerClient.getBlockBlobClient(key);
    // uploadFile handles chunking internally
    await block.uploadFile(localPath);
  }

  async function put(bufferOrStream, remotePath) {
    if (!containerClient) throw new Error('Azure client not connected');
    const key = remotePath.replace(/^\/+/, '');
    const block = containerClient.getBlockBlobClient(key);
    if (Buffer.isBuffer(bufferOrStream)) {
      await block.uploadData(bufferOrStream);
    } else if (bufferOrStream && typeof bufferOrStream.pipe === 'function') {
      // 8MB block size, 5 parallel uploads by default
      await block.uploadStream(bufferOrStream, 8 * 1024 * 1024, 5);
    } else if (typeof bufferOrStream === 'string' && fs.existsSync(bufferOrStream)) {
      await block.uploadFile(bufferOrStream);
    } else {
      throw new Error('Unsupported body for Azure put');
    }
  }

  async function deleteObject(remotePath) {
    if (!containerClient) throw new Error('Azure client not connected');
    const key = remotePath.replace(/^\/+/, '');
    const blob = containerClient.getBlobClient(key);
    await blob.deleteIfExists();
  }

  async function list(prefix) {
    if (!containerClient) throw new Error('Azure client not connected');
    const Key = (prefix || '').replace(/^\/+/, '');
    const out = [];
    for await (const item of containerClient.listBlobsFlat({ prefix: Key })) {
      out.push({ name: item.name, size: item.properties.contentLength || 0 });
    }
    return out;
  }

  async function mkdir() { /* no-op for object storage */ }
  async function rmdir() { /* no-op for object storage */ }
  async function end() { containerClient = null; }

  const adapter = { connect, fastPut, put, delete: deleteObject, mkdir, rmdir, list, end };
  return adapter;
}
