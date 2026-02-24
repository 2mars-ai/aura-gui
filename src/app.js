// AuraCore Desktop — frontend application logic
// Communicates with the Tauri backend via window.__TAURI__.core.invoke()
// and with the running node via fetch() against the configured RPC URL.

'use strict';

// ---------------------------------------------------------------------------
// Tauri bridge helpers
// ---------------------------------------------------------------------------

const isTauri = typeof window !== 'undefined' && window.__TAURI__ !== undefined;

async function invoke(cmd, args = {}) {
  if (!isTauri) {
    console.warn(`invoke('${cmd}') called outside Tauri — stubbed`);
    return null;
  }
  return window.__TAURI__.core.invoke(cmd, args);
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const State = {
  rpcUrl: 'http://89.167.89.226:8545',  // default: live ARM testnet node 1
  nodeRunning: false,
  wallet: null,          // { address, privateKeyHex, publicKeyHex }
  pollInterval: null,
};

function rpcBase() {
  return State.rpcUrl.replace(/\/$/, '');
}

async function rpcFetch(path) {
  const res = await fetch(`${rpcBase()}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Tab navigation
// ---------------------------------------------------------------------------

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');
    // Trigger a data refresh when switching to a data tab
    if (tabName === 'explorer')   refreshExplorer();
    if (tabName === 'validators') refreshValidators();
    if (tabName === 'send')       updateSendTab();
  });
});

// ---------------------------------------------------------------------------
// Node tab
// ---------------------------------------------------------------------------

const btnStart     = document.getElementById('btn-start');
const btnStop      = document.getElementById('btn-stop');
const nodeDot      = document.getElementById('node-dot');
const nodeLabel    = document.getElementById('node-label');
const statsCard    = document.getElementById('node-stats-card');

btnStart.addEventListener('click', connectNode);
btnStop.addEventListener('click', stopNode);

async function connectNode() {
  btnStart.disabled = true;
  btnStart.textContent = 'Connecting…';
  hideNodeError();

  // Remote URL takes priority if filled in
  const remoteUrlEl = document.getElementById('cfg-remote-url');
  const remoteUrl = remoteUrlEl ? remoteUrlEl.value.trim() : '';

  if (remoteUrl) {
    // Remote node mode — just store the URL and probe it
    State.rpcUrl = remoteUrl;
    try {
      const result = await invoke('start_node', {
        args: {
          remote_url: remoteUrl,
          binary_path: null,
          data_dir: null,
          rpc_port: null,
          p2p_port: null,
          node_id: null,
          bootstrap: null,
        }
      });
      handleNodeResult(result, false);
    } catch (err) {
      showNodeError(err.toString());
    }
  } else {
    // Local subprocess mode
    const binary   = document.getElementById('cfg-binary').value.trim() || 'auracore';
    const dataDir  = document.getElementById('cfg-datadir').value.trim()
      || getDefaultDataDir();
    const rpcPort  = parseInt(document.getElementById('cfg-rpc').value, 10) || 8545;
    const p2pPort  = parseInt(document.getElementById('cfg-p2p').value, 10) || 30341;
    const nodeId   = document.getElementById('cfg-nodeid').value.trim() || 'desktop-wallet';
    const bootstrap = document.getElementById('cfg-bootstrap').value.trim();

    State.rpcUrl = `http://localhost:${rpcPort}`;

    try {
      const result = await invoke('start_node', {
        args: {
          binary_path: binary !== 'auracore' ? binary : null,
          data_dir: dataDir,
          rpc_port: rpcPort,
          p2p_port: p2pPort,
          node_id: nodeId,
          bootstrap: bootstrap || null,
          remote_url: null,
        }
      });
      handleNodeResult(result, true);
      if (result && result.running) {
        // Give the process a moment to open its RPC port
        setTimeout(refreshChainStats, 2500);
      }
    } catch (err) {
      showNodeError(err.toString());
    }
  }

  btnStart.disabled = false;
  btnStart.textContent = 'Connect';
}

function handleNodeResult(result, localMode) {
  if (!result) return;
  if (result.connected) {
    setNodeIndicator(true, null);
    statsCard.style.display = 'block';
    fillStats(result);
    startStatusPoll();
  } else if (result.running) {
    setNodeIndicator(null, 'Starting…');
    statsCard.style.display = 'none';
    startStatusPoll();
  } else {
    setNodeIndicator(false, localMode ? 'Failed to start' : 'Node unreachable');
    statsCard.style.display = 'none';
  }
  btnStop.disabled = !result.running;
}

async function stopNode() {
  btnStop.disabled = true;
  try {
    await invoke('stop_node');
    setNodeIndicator(false, 'Node stopped');
    stopStatusPoll();
    statsCard.style.display = 'none';
    btnStart.disabled = false;
  } catch (err) {
    showNodeError(err.toString());
  } finally {
    btnStop.disabled = false;
  }
}

/** Set the header indicator. pass null for online=syncing */
function setNodeIndicator(online, label) {
  if (online === true) {
    nodeDot.className = 'dot dot-on';
    nodeLabel.textContent = label ?? 'Connected';
  } else if (online === null) {
    nodeDot.className = 'dot dot-syncing';
    nodeLabel.textContent = label ?? 'Connecting…';
  } else {
    nodeDot.className = 'dot dot-off';
    nodeLabel.textContent = label ?? 'Node offline';
  }
}

function startStatusPoll() {
  if (State.pollInterval) clearInterval(State.pollInterval);
  State.pollInterval = setInterval(refreshChainStats, 8000);
}

function stopStatusPoll() {
  if (State.pollInterval) { clearInterval(State.pollInterval); State.pollInterval = null; }
}

async function refreshChainStats() {
  try {
    const result = await invoke('get_node_status');
    if (result) {
      if (result.connected) {
        setNodeIndicator(true, `Block ${result.block_height ?? '?'}`);
        statsCard.style.display = 'block';
        fillStats(result);
        hideNodeError();
      } else if (result.running) {
        setNodeIndicator(null, 'Starting…');
      } else {
        // Try direct RPC fetch as fallback
        try {
          const data = await rpcFetch('/status');
          setNodeIndicator(true, `Block ${data.block_height ?? data.height ?? '?'}`);
          statsCard.style.display = 'block';
          fillStatsFromRpc(data);
          hideNodeError();
        } catch (_) {
          setNodeIndicator(null, 'Connecting…');
        }
      }
    }
  } catch (_) {}
}

function fillStats(result) {
  document.getElementById('stat-height').textContent     = result.block_height ?? '—';
  document.getElementById('stat-peers').textContent      = result.peer_count ?? '—';
  document.getElementById('stat-validators').textContent = result.validator_count ?? '—';
  document.getElementById('stat-supply').textContent     = fmt(result.total_supply);
  document.getElementById('stat-chainid').textContent    = result.chain_id ?? '—';
  document.getElementById('stat-version').textContent    = result.version ?? '—';
}

function fillStatsFromRpc(data) {
  document.getElementById('stat-height').textContent     = data.block_height ?? data.height ?? '—';
  document.getElementById('stat-peers').textContent      = data.peer_count ?? data.peers ?? '—';
  document.getElementById('stat-validators').textContent = data.validator_count ?? '—';
  document.getElementById('stat-supply').textContent     = fmt(data.total_supply);
  document.getElementById('stat-chainid').textContent    = data.chain_id ?? '—';
  document.getElementById('stat-version').textContent    = data.version ?? '—';
}

function showNodeError(msg) {
  const el = document.getElementById('node-error');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}
function hideNodeError() {
  const el = document.getElementById('node-error');
  if (el) el.style.display = 'none';
}

function getDefaultDataDir() {
  try {
    const home = window.__TAURI__?.path?.homeDir?.() ?? '~';
    return `${home}\\.auracore\\data`;
  } catch (_) {
    return '%USERPROFILE%\\.auracore\\data';
  }
}

// ---------------------------------------------------------------------------
// Wallet tab
// ---------------------------------------------------------------------------

document.getElementById('btn-gen-keypair').addEventListener('click', generateKeypair);
document.getElementById('btn-import-privkey').addEventListener('click', importPrivkey);
document.getElementById('btn-refresh-balance').addEventListener('click', refreshBalance);
document.getElementById('btn-clear-wallet').addEventListener('click', clearWallet);
document.getElementById('btn-export-keystore').addEventListener('click', exportKeystoreFromWallet);
document.getElementById('btn-ks-import').addEventListener('click', importKeystore);
document.getElementById('btn-ks-export').addEventListener('click', exportKeystore);

// Copy address on click
document.getElementById('w-address').addEventListener('click', function() {
  navigator.clipboard?.writeText(this.textContent);
  this.style.color = '#3fb950';
  setTimeout(() => (this.style.color = ''), 1200);
});

async function generateKeypair() {
  try {
    const kp = await invoke('generate_keypair');
    if (!kp) return;
    document.getElementById('gen-result').style.display = 'block';
    document.getElementById('gen-result').textContent =
      `Address:     ${kp.address}\nPublic key:  ${kp.public_key_hex}\nPrivate key: ${kp.private_key_hex}\n\nWARNING: Save your private key — it cannot be recovered if lost.`;
    loadWallet(kp);
  } catch (err) {
    alert(`Generate keypair failed: ${err}`);
  }
}

async function importPrivkey() {
  const hex = document.getElementById('import-privkey').value.trim();
  if (!hex) { alert('Enter a private key.'); return; }
  if (hex.length !== 64) { alert('Private key must be exactly 64 hex characters.'); return; }
  try {
    // Use sign_transaction to derive the public key from the private key
    const ts = Math.floor(Date.now() / 1000);
    const signed = await invoke('sign_transaction', {
      args: {
        private_key_hex: hex,
        from: 'aura10000000000000000000000000000000000000000',
        to:   'aura10000000000000000000000000000000000000000',
        amount: 0.0,
        fee: 0.0,
        nonce: 1,
        timestamp: ts,
        tx_type: 'Transfer',
      }
    });
    if (!signed) return;
    const address = await invoke('derive_address', { public_key_hex: signed.public_key });
    loadWallet({ address, private_key_hex: hex, public_key_hex: signed.public_key });
  } catch (err) {
    alert(`Import failed: ${err}`);
  }
}

function loadWallet(kp) {
  State.wallet = {
    address: kp.address,
    privateKeyHex: kp.private_key_hex,
    publicKeyHex: kp.public_key_hex,
  };
  document.getElementById('wallet-empty').style.display = 'none';
  document.getElementById('wallet-loaded').style.display = 'block';
  document.getElementById('w-address').textContent = kp.address;
  document.getElementById('w-nonce').textContent = '—';
  document.getElementById('w-balance').textContent = '—';
  updateSendTab();
  refreshBalance();
}

async function refreshBalance() {
  if (!State.wallet) return;
  try {
    const data = await rpcFetch(`/accounts/${State.wallet.address}/balance`);
    document.getElementById('w-balance').textContent = `${fmt(data.balance ?? data)} AURA`;
    try {
      const nd = await rpcFetch(`/accounts/${State.wallet.address}/nonce`);
      document.getElementById('w-nonce').textContent = nd.nonce ?? nd ?? '0';
    } catch (_) {}
  } catch (err) {
    document.getElementById('w-balance').textContent = `Error: ${err.message}`;
  }
}

function clearWallet() {
  State.wallet = null;
  document.getElementById('wallet-empty').style.display = 'block';
  document.getElementById('wallet-loaded').style.display = 'none';
  document.getElementById('gen-result').style.display = 'none';
  updateSendTab();
}

async function exportKeystoreFromWallet() {
  if (!State.wallet) return;
  const pass = prompt('Enter a password to encrypt the keystore:');
  if (!pass) return;
  try {
    const json = await invoke('create_keystore', {
      private_key_hex: State.wallet.privateKeyHex,
      password: pass,
    });
    document.getElementById('ks-json').value = json;
    document.getElementById('ks-password').value = '';
    alert('Keystore exported to the JSON field below. Copy and save it to a file.');
  } catch (err) {
    alert(`Export failed: ${err}`);
  }
}

async function importKeystore() {
  const json = document.getElementById('ks-json').value.trim();
  const pass = document.getElementById('ks-password').value;
  const errEl = document.getElementById('ks-error');
  errEl.style.display = 'none';

  if (!json) { errEl.textContent = 'Paste a keystore JSON first.'; errEl.style.display = 'block'; return; }
  if (!pass) { errEl.textContent = 'Enter the keystore password.'; errEl.style.display = 'block'; return; }

  try {
    const kp = await invoke('unlock_keystore', { keystore_json: json, password: pass });
    if (!kp) return;
    loadWallet(kp);
  } catch (err) {
    errEl.textContent = `Unlock failed: ${err}`;
    errEl.style.display = 'block';
  }
}

async function exportKeystore() {
  if (!State.wallet) { alert('Load a wallet first.'); return; }
  await exportKeystoreFromWallet();
}

// ---------------------------------------------------------------------------
// Send tab
// ---------------------------------------------------------------------------

document.getElementById('btn-send').addEventListener('click', sendTransaction);

function updateSendTab() {
  const noWallet = document.getElementById('send-no-wallet');
  const form     = document.getElementById('send-form');
  if (State.wallet) {
    noWallet.style.display = 'none';
    form.style.display = 'block';
    document.getElementById('send-from').textContent = State.wallet.address;
  } else {
    noWallet.style.display = 'block';
    form.style.display = 'none';
  }
}

async function sendTransaction() {
  const errEl    = document.getElementById('send-error');
  const resultEl = document.getElementById('send-result');
  errEl.style.display = 'none';
  resultEl.style.display = 'none';

  if (!State.wallet) { errEl.textContent = 'No wallet loaded.'; errEl.style.display = 'block'; return; }

  const to     = document.getElementById('send-to').value.trim();
  const amount = parseFloat(document.getElementById('send-amount').value);
  const fee    = parseFloat(document.getElementById('send-fee').value) || 0.001;
  const txType = document.getElementById('send-txtype').value;

  if (!to.startsWith('aura1') || to.length < 40) {
    errEl.textContent = 'Invalid recipient address. Must start with aura1.';
    errEl.style.display = 'block';
    return;
  }
  if (isNaN(amount) || amount <= 0) {
    errEl.textContent = 'Enter a valid positive amount.';
    errEl.style.display = 'block';
    return;
  }

  try {
    // Fetch current nonce
    let nonce = 1;
    try {
      const nd = await rpcFetch(`/accounts/${State.wallet.address}/nonce`);
      nonce = (nd.nonce ?? nd ?? 0) + 1;
    } catch (_) {}

    const timestamp = Math.floor(Date.now() / 1000);

    // Sign
    const signed = await invoke('sign_transaction', {
      args: {
        private_key_hex: State.wallet.privateKeyHex,
        from: State.wallet.address,
        to,
        amount,
        fee,
        nonce,
        timestamp,
        tx_type: txType,
      }
    });

    if (!signed) return;

    // Submit to node
    const body = {
      from: signed.from,
      to: signed.to,
      amount: signed.amount,
      fee: signed.fee,
      nonce: signed.nonce,
      timestamp: signed.timestamp,
      signature: signed.signature,
      public_key: signed.public_key,
      tx_type: signed.tx_type,
      signing_algorithm: signed.signing_algorithm,
    };

    const res = await fetch(`${rpcBase()}/transactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const responseJson = await res.json().catch(() => ({ status: res.statusText }));

    if (res.ok) {
      resultEl.textContent = `Transaction submitted!\n${JSON.stringify(responseJson, null, 2)}`;
      resultEl.style.display = 'block';
      document.getElementById('send-to').value = '';
      document.getElementById('send-amount').value = '';
      setTimeout(refreshBalance, 3000);
    } else {
      errEl.textContent = `Node rejected tx: ${JSON.stringify(responseJson)}`;
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = `Send failed: ${err}`;
    errEl.style.display = 'block';
  }
}

// ---------------------------------------------------------------------------
// Explorer tab
// ---------------------------------------------------------------------------

document.getElementById('btn-explorer-refresh').addEventListener('click', refreshExplorer);
document.getElementById('btn-close-detail').addEventListener('click', () => {
  document.getElementById('block-detail-card').style.display = 'none';
});

async function refreshExplorer() {
  const errEl = document.getElementById('explorer-error');
  const tbody = document.getElementById('blocks-tbody');
  errEl.style.display = 'none';

  try {
    // Get current height first
    const status = await rpcFetch('/status');
    const height = status.block_height ?? status.height ?? 0;

    // Fetch last 20 blocks
    const start = Math.max(0, height - 19);
    const rows = [];

    for (let h = height; h >= start; h--) {
      try {
        const block = await rpcFetch(`/blocks/${h}`);
        rows.push(block);
      } catch (_) { break; }
    }

    tbody.innerHTML = '';
    rows.forEach(block => {
      const tr = document.createElement('tr');
      const hash      = block.hash ?? block.block_hash ?? '—';
      const validator = block.validator ?? block.produced_by ?? '—';
      const txCount   = Array.isArray(block.transactions) ? block.transactions.length : (block.tx_count ?? '?');
      const reward    = block.reward ?? block.block_reward ?? '—';
      const ts        = block.timestamp ? new Date(block.timestamp * 1000).toLocaleTimeString() : '—';

      tr.innerHTML = `
        <td>${block.height ?? '?'}</td>
        <td class="hash-cell" title="${hash}">${truncate(hash, 16)}</td>
        <td title="${validator}">${truncate(validator, 20)}</td>
        <td>${txCount}</td>
        <td>${fmt(reward)}</td>
        <td>${ts}</td>
      `;
      tr.addEventListener('click', () => showBlockDetail(block));
      tbody.appendChild(tr);
    });

    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:20px;">No blocks found. Connect to a node first.</td></tr>';
    }
  } catch (err) {
    errEl.textContent = `Could not fetch blocks: ${err.message}. Connect to a node first.`;
    errEl.style.display = 'block';
  }
}

function showBlockDetail(block) {
  document.getElementById('block-detail-pre').textContent = JSON.stringify(block, null, 2);
  document.getElementById('block-detail-card').style.display = 'block';
}

// ---------------------------------------------------------------------------
// Validators tab
// ---------------------------------------------------------------------------

document.getElementById('btn-val-refresh').addEventListener('click', refreshValidators);

async function refreshValidators() {
  const errEl = document.getElementById('validators-error');
  const tbody = document.getElementById('validators-tbody');
  errEl.style.display = 'none';

  try {
    const data = await rpcFetch('/validators');
    const validators = Array.isArray(data) ? data : (data.validators ?? []);

    tbody.innerHTML = '';
    validators.forEach(v => {
      const tr = document.createElement('tr');
      const addr     = v.address ?? v.id ?? '—';
      const stake    = fmt(v.stake ?? v.total_stake ?? 0);
      const produced = v.blocks_produced ?? v.blocks ?? '—';
      const rep      = v.reputation_score ?? v.reputation ?? '—';
      const jailed   = v.is_jailed || v.jailed ? 'Yes' : 'No';

      tr.innerHTML = `
        <td title="${addr}">${truncate(addr, 28)}</td>
        <td>${stake}</td>
        <td>${produced}</td>
        <td>${rep}</td>
        <td style="color:${jailed === 'Yes' ? 'var(--red)' : 'var(--green)'}">${jailed}</td>
      `;
      tbody.appendChild(tr);
    });

    if (validators.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="muted" style="text-align:center;padding:20px;">No validators found. Connect to a node first.</td></tr>';
    }
  } catch (err) {
    errEl.textContent = `Could not fetch validators: ${err.message}. Connect to a node first.`;
    errEl.style.display = 'block';
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function fmt(val) {
  if (val === null || val === undefined || val === '—') return '—';
  const n = parseFloat(val);
  if (isNaN(n)) return String(val);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(8).replace(/\.?0+$/, '');
}

function truncate(str, len) {
  if (!str || str.length <= len) return str;
  return `${str.slice(0, len)}…`;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  // Set default data dir placeholder
  try {
    if (window.__TAURI__?.path) {
      const home = await window.__TAURI__.path.homeDir();
      const ddEl = document.getElementById('cfg-datadir');
      if (ddEl) {
        ddEl.placeholder = `${home}\\.auracore\\data`;
        ddEl.value = `${home}\\.auracore\\data`;
      }
    }
  } catch (_) {
    const ddEl = document.getElementById('cfg-datadir');
    if (ddEl) ddEl.value = '%USERPROFILE%\\.auracore\\data';
  }

  // Check if there is already a node running from a previous session
  try {
    const status = await invoke('get_node_status');
    if (status) {
      if (status.connected) {
        if (status.rpc_url) State.rpcUrl = status.rpc_url;
        setNodeIndicator(true, `Block ${status.block_height ?? '?'}`);
        statsCard.style.display = 'block';
        fillStats(status);
        startStatusPoll();
      } else if (status.running) {
        setNodeIndicator(null, 'Starting…');
        startStatusPoll();
      }
    }
  } catch (_) {}

  // Auto-connect to the default remote testnet node
  const remoteUrlEl = document.getElementById('cfg-remote-url');
  if (remoteUrlEl && !remoteUrlEl.value) {
    remoteUrlEl.value = 'http://89.167.89.226:8545';
  }
}

document.addEventListener('DOMContentLoaded', init);
