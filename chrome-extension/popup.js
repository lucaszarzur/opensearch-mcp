const ENVS = {
  '319b82a2': 'qa',
  '292f3c27': 'prod',
  '8eec26fa': 'dev'
};

function detectEnv(url) {
  for (const [hash, env] of Object.entries(ENVS)) {
    if (url.includes(hash)) return env;
  }
  return null;
}

function setBadge(env) {
  const el = document.getElementById('envBadge');
  if (!env) {
    el.innerHTML = '<span class="env env-none">Nao e um dashboard OpenSearch</span>';
    return;
  }
  el.innerHTML = `<span class="env env-${env}">${env.toUpperCase()}</span>`;
}

function setStatus(msg, ok) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + (ok ? 'status-ok' : 'status-err');
}

async function run() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  const env = detectEnv(url);

  setBadge(env);

  if (!env) {
    document.getElementById('cookiePreview').textContent = 'Abra um dashboard OpenSearch (QA, PROD ou DEV) e clique novamente.';
    return;
  }

  const domain = new URL(url).hostname;
  const cookies = await chrome.cookies.getAll({ domain });

  if (!cookies.length) {
    document.getElementById('cookiePreview').textContent = 'Nenhum cookie encontrado. Faca login SSO primeiro.';
    return;
  }

  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  document.getElementById('cookiePreview').textContent = cookieStr.substring(0, 200) + '...';

  const btnCopy = document.getElementById('btnCopy');
  btnCopy.disabled = false;
  btnCopy.addEventListener('click', async () => {
    await navigator.clipboard.writeText(cookieStr);
    setStatus('Cookie copiado!', true);
  });

  const btnCopyCmd = document.getElementById('btnCopyCmd');
  btnCopyCmd.disabled = false;
  btnCopyCmd.addEventListener('click', async () => {
    const escaped = cookieStr.replace(/'/g, "'\\''");
    const cmd = `update-opensearch-cookie ${env} '${escaped}'`;
    await navigator.clipboard.writeText(cmd);
    setStatus(`Comando copiado! Cole no terminal.`, true);
  });
}

run();
