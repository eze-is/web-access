export async function waitForProxyConnection({
  healthUrl,
  attempts = 15,
  timeoutMs = 8000,
  httpGetJson,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  for (let i = 1; i <= attempts; i++) {
    const health = await httpGetJson(healthUrl, timeoutMs);
    if (health?.status === 'ok' && health.connected) {
      return true;
    }
    if (i < attempts) {
      await sleep(1000);
    }
  }
  return false;
}
