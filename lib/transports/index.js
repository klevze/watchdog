// Factory that returns a transport adapter based on server.type.
// Uses dynamic imports so optional peer deps are only required when actually used.
export default async function createTransport(server = {}, env = process.env) {
  const type = String(server.type || '').toLowerCase();
  switch (type) {
    case 's3': {
      const mod = await import('./s3.js');
      return mod.default(server, env);
    }
    case 'azure': {
      const mod = await import('./azure.js');
      return mod.default(server, env);
    }
    case 'ftps': {
      const mod = await import('./ftps.js');
      return mod.default(server, env);
    }
    case 'ftp': {
      const mod = await import('./ftp.js');
      return mod.default(server, env);
    }
    case 'webdav': {
      const mod = await import('./webdav.js');
      return mod.default(server, env);
    }
    case 'tus': {
      const mod = await import('./tus.js');
      return mod.default(server, env);
    }
    case 'gcs': {
      const mod = await import('./gcs.js');
      return mod.default(server, env);
    }
    default:
      throw new Error(`Unsupported transport type: ${type || '(none)'} — expected one of: s3, azure, gcs, ftps, ftp, webdav, tus`);
  }
}
