import test from "node:test";
import assert from "node:assert/strict";

import {
  browserUserDataDirs,
  devToolsActivePortFiles,
  discoverBrowserDebugEndpoint,
} from "../scripts/lib/browser-paths.mjs";

test("devToolsActivePortFiles includes Microsoft Edge on linux", () => {
  const files = devToolsActivePortFiles({
    platform: "linux",
    homeDir: "/home/tester",
    localAppData: "",
  });

  assert.deepEqual(files, [
    "/home/tester/.config/google-chrome/DevToolsActivePort",
    "/home/tester/.config/chromium/DevToolsActivePort",
    "/home/tester/.config/microsoft-edge/DevToolsActivePort",
    "/home/tester/.config/microsoft-edge-beta/DevToolsActivePort",
    "/home/tester/.config/microsoft-edge-dev/DevToolsActivePort",
  ]);
});

test("browserUserDataDirs includes Microsoft Edge on macOS and Windows", () => {
  assert.deepEqual(
    browserUserDataDirs({
      platform: "darwin",
      homeDir: "/Users/tester",
      localAppData: "",
    }),
    [
      "/Users/tester/Library/Application Support/Google/Chrome",
      "/Users/tester/Library/Application Support/Google/Chrome Canary",
      "/Users/tester/Library/Application Support/Chromium",
      "/Users/tester/Library/Application Support/Microsoft Edge",
      "/Users/tester/Library/Application Support/Microsoft Edge Beta",
      "/Users/tester/Library/Application Support/Microsoft Edge Dev",
    ],
  );

  assert.deepEqual(
    browserUserDataDirs({
      platform: "win32",
      homeDir: "",
      localAppData: "C:/Users/tester/AppData/Local",
    }),
    [
      "C:/Users/tester/AppData/Local/Google/Chrome/User Data",
      "C:/Users/tester/AppData/Local/Chromium/User Data",
      "C:/Users/tester/AppData/Local/Microsoft/Edge/User Data",
      "C:/Users/tester/AppData/Local/Microsoft/Edge Beta/User Data",
      "C:/Users/tester/AppData/Local/Microsoft/Edge Dev/User Data",
    ],
  );
});

test("discoverBrowserDebugEndpoint reads the Microsoft Edge active port file", async () => {
  const endpoint = await discoverBrowserDebugEndpoint({
    platform: "linux",
    homeDir: "/home/tester",
    localAppData: "",
    readFileSyncImpl(filePath) {
      if (filePath === "/home/tester/.config/microsoft-edge/DevToolsActivePort") {
        return "38031\n/devtools/browser/edge-session";
      }

      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    checkPortImpl: async (port) => port === 38031,
  });

  assert.deepEqual(endpoint, {
    port: 38031,
    wsPath: "/devtools/browser/edge-session",
  });
});
