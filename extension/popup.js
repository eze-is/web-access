chrome.runtime.sendMessage({ type: 'status' }, (status) => {
  const dot = document.getElementById('dot');
  const label = document.getElementById('status');
  if (status?.connected) {
    dot.classList.add('connected');
    label.textContent = 'Connected to local CDP transport';
  } else {
    dot.classList.remove('connected');
    label.textContent = 'Waiting for local CDP transport';
  }
});
