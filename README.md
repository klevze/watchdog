# Watchdog

A cross-platform file watcher and SFTP uploader for automated deployment.

## Features

- Watches local files and folders for changes
- Uploads changes to remote server via SFTP
- Supports ignore patterns (minimatch syntax)
- Dry run mode for safe testing
- Configurable concurrency, debounce, and file size limits
- Initial sync option
- Colored output and logging levels
- Graceful shutdown with stats summary

## Installation

### Prerequisites
- Node.js v16 or newer (https://nodejs.org/)
- SSH/SFTP access to your remote server

### Windows
```powershell
# Open PowerShell and run:
git clone https://github.com/klevze/watchdog.git
cd watchdog
npm install
```

### Linux / Mac
```bash
git clone https://github.com/klevze/watchdog.git
cd watchdog
npm install
```

## Configuration

Copy and edit the sample config:
```bash
cp watchdog.sample.config.jsonc watchdog.config.json
```
Edit `watchdog.config.json` to match your project and server details. See comments in the sample for all options.

## Usage

### Basic
```bash
node watchdog.js --config watchdog.config.json
```

### Common CLI Options
- `--dry-run` : Simulate actions, do not upload/delete files
- `--concurrency N` : Override parallel upload count
- `--verbose` : Enable debug logging
- `--config path/to/config.json` : Use a specific config file

### Example
```bash
node watchdog.js --config watchdog.config.json --dry-run --concurrency 8 --verbose
```

## How it works
- Watches the specified folder for changes
- Ignores files/folders matching patterns in `ignore`
- Uploads changed files, creates/deletes directories as needed
- Optionally deletes remote files when deleted locally (`deleteOnRemote`)
- Skips files larger than `maxFileSizeBytes` (if set)
- Shows colored logs and a summary at shutdown

## Troubleshooting
- Ensure your SSH key or password is correct and has permissions for the remote directory
- If you see `[ERROR] SFTP connection or permission check failed`, check your config and server
- Use `--dry-run` to test without making changes
- Increase `debounceMs` or reduce `concurrency` if you experience lag or server overload

## License
MIT

## Contributing
Pull requests and issues welcome!

## Testing

Install dev dependencies:

```
npm install mocha chai minimatch --save-dev
```

Run all tests:

```
npm test
```

## SSH Key Setup Tutorial

To securely connect to your server, generate an SSH key pair and add your public key to the server's authorized_keys.

### Windows (using PowerShell or Git Bash)

1. Open PowerShell or Git Bash.
2. Run:
   ```powershell
   ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
   ```
3. Press Enter to accept the default file location (`C:\Users\YourName\.ssh\id_rsa`).
4. Set a passphrase if desired (optional).
5. Your public key is at `C:\Users\YourName\.ssh\id_rsa.pub`.

### Linux / Mac

1. Open Terminal.
2. Run:
   ```bash
   ssh-keygen -t rsa -b 4096 -C "your_email@example.com"
   ```
3. Press Enter to accept the default file location (`~/.ssh/id_rsa`).
4. Set a passphrase if desired (optional).
5. Your public key is at `~/.ssh/id_rsa.pub`.

### Copy Public Key to Server

1. Use `ssh-copy-id` (recommended, if available):
   ```bash
   ssh-copy-id -i ~/.ssh/id_rsa.pub username@server.example.com
   ```
   - On Windows, you may need to install [Git Bash](https://git-scm.com/downloads) or use [PuTTY](https://www.putty.org/).

2. Or manually copy the public key:
   - Open your public key file (`id_rsa.pub`) in a text editor.
   - SSH into your server:
     ```bash
     ssh username@server.example.com
     ```
   - Append the public key to `~/.ssh/authorized_keys`:
     ```bash
     echo "paste-your-public-key-here" >> ~/.ssh/authorized_keys
     chmod 600 ~/.ssh/authorized_keys
     ```

3. Test your connection:
   ```bash
   ssh username@server.example.com
   ```
   You should connect without entering a password (unless you set a passphrase).

**Tip:** Never share your private key (`id_rsa`). Only the `.pub` file is safe to share.
