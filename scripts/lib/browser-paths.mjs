import fs from 'node:fs';

export function devToolsActivePortFiles({
  platform,
  homeDir,
  localAppData,
}) {
  switch (platform) {
    case 'darwin':
      return [
        `${homeDir}/Library/Application Support/Google/Chrome/DevToolsActivePort`,
        `${homeDir}/Library/Application Support/Google/Chrome Canary/DevToolsActivePort`,
        `${homeDir}/Library/Application Support/Chromium/DevToolsActivePort`,
        `${homeDir}/Library/Application Support/Microsoft Edge/DevToolsActivePort`,
        `${homeDir}/Library/Application Support/Microsoft Edge Beta/DevToolsActivePort`,
        `${homeDir}/Library/Application Support/Microsoft Edge Dev/DevToolsActivePort`,
      ];
    case 'linux':
      return [
        `${homeDir}/.config/google-chrome/DevToolsActivePort`,
        `${homeDir}/.config/chromium/DevToolsActivePort`,
        `${homeDir}/.config/microsoft-edge/DevToolsActivePort`,
        `${homeDir}/.config/microsoft-edge-beta/DevToolsActivePort`,
        `${homeDir}/.config/microsoft-edge-dev/DevToolsActivePort`,
      ];
    case 'win32':
      return [
        `${localAppData}/Google/Chrome/User Data/DevToolsActivePort`,
        `${localAppData}/Chromium/User Data/DevToolsActivePort`,
        `${localAppData}/Microsoft/Edge/User Data/DevToolsActivePort`,
        `${localAppData}/Microsoft/Edge Beta/User Data/DevToolsActivePort`,
        `${localAppData}/Microsoft/Edge Dev/User Data/DevToolsActivePort`,
      ];
    default:
      return [];
  }
}

export function browserUserDataEntries({
  platform,
  homeDir,
  localAppData,
}) {
  switch (platform) {
    case 'darwin':
      return [
        { browser: 'Chrome', dir: `${homeDir}/Library/Application Support/Google/Chrome` },
        { browser: 'Chrome Canary', dir: `${homeDir}/Library/Application Support/Google/Chrome Canary` },
        { browser: 'Chromium', dir: `${homeDir}/Library/Application Support/Chromium` },
        { browser: 'Edge', dir: `${homeDir}/Library/Application Support/Microsoft Edge` },
        { browser: 'Edge Beta', dir: `${homeDir}/Library/Application Support/Microsoft Edge Beta` },
        { browser: 'Edge Dev', dir: `${homeDir}/Library/Application Support/Microsoft Edge Dev` },
      ];
    case 'linux':
      return [
        { browser: 'Chrome', dir: `${homeDir}/.config/google-chrome` },
        { browser: 'Chromium', dir: `${homeDir}/.config/chromium` },
        { browser: 'Edge', dir: `${homeDir}/.config/microsoft-edge` },
        { browser: 'Edge Beta', dir: `${homeDir}/.config/microsoft-edge-beta` },
        { browser: 'Edge Dev', dir: `${homeDir}/.config/microsoft-edge-dev` },
      ];
    case 'win32':
      return [
        { browser: 'Chrome', dir: `${localAppData}/Google/Chrome/User Data` },
        { browser: 'Chromium', dir: `${localAppData}/Chromium/User Data` },
        { browser: 'Edge', dir: `${localAppData}/Microsoft/Edge/User Data` },
        { browser: 'Edge Beta', dir: `${localAppData}/Microsoft/Edge Beta/User Data` },
        { browser: 'Edge Dev', dir: `${localAppData}/Microsoft/Edge Dev/User Data` },
      ];
    default:
      return [];
  }
}

export function browserUserDataDirs(opts) {
  return browserUserDataEntries(opts).map(({ dir }) => dir);
}

export async function discoverBrowserDebugEndpoint({
  platform,
  homeDir,
  localAppData,
  readFileSyncImpl = fs.readFileSync,
  checkPortImpl,
  candidatePorts = [9222, 9229, 9333],
}) {
  for (const filePath of devToolsActivePortFiles({
    platform,
    homeDir,
    localAppData,
  })) {
    try {
      const lines = String(readFileSyncImpl(filePath, 'utf8'))
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
      const port = Number.parseInt(lines[0], 10);
      if (port > 0 && port < 65536 && await checkPortImpl(port)) {
        return {
          port,
          wsPath: lines[1] || null,
        };
      }
    } catch {
      // Ignore missing or unreadable files.
    }
  }

  for (const port of candidatePorts) {
    if (await checkPortImpl(port)) {
      return {
        port,
        wsPath: null,
      };
    }
  }

  return null;
}
