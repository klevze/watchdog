// small wrapper that would normally run the sftp permission check; here we expose the logic to be unit-testable
export async function permissionCheck(sftpClient, remoteBase) {
  // sftpClient must implement list, put, delete
  await sftpClient.list(remoteBase);
  const testFile = `${remoteBase}/.watchdog_test_perm`;
  await sftpClient.put(Buffer.from('x'), testFile);
  await sftpClient.delete(testFile);
  return true;
}
