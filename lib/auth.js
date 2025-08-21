export function selectAuth(server = {}, env = {}, authFlag) {
  const privateKeyValue = server.privateKey || env.WATCHDOG_PRIVATE_KEY;
  const passwordValue = server.password || env.WATCHDOG_PASSWORD;
  if (authFlag) authFlag = String(authFlag).toLowerCase();
  if (authFlag && !['key', 'password'].includes(authFlag)) {
    throw new Error(`Invalid authFlag: ${authFlag}`);
  }

  if (authFlag === 'key') {
    if (!privateKeyValue) throw new Error('--auth=key requested but no private key available');
    return { method: 'key', privateKey: privateKeyValue };
  }
  if (authFlag === 'password') {
    if (!passwordValue) throw new Error('--auth=password requested but no password available');
    return { method: 'password', password: passwordValue };
  }

  // no explicit flag: prefer key if present
  if (privateKeyValue) return { method: 'key', privateKey: privateKeyValue };
  if (passwordValue) return { method: 'password', password: passwordValue };
  throw new Error('No authentication method available');
}
