// AuraCore Desktop — frontend application logic
// Communicates with the Tauri backend via window.__TAURI__.core.invoke()
// and with the running node via fetch() against the configured RPC URL.

'use strict';

// ─── Visible error overlay (debug) ──────────────────────────────────────────
(function () {
  function _showOverlayError(msg, top) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;' + (top ? 'top:0' : 'top:28px') +
      ';left:0;right:0;background:#b00;color:#fff;padding:5px 10px;' +
      'z-index:99999;font-size:11px;font-family:monospace;word-break:break-all;';
    d.textContent = msg;
    document.body ? document.body.appendChild(d) :
      document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(d); });
  }
  window.addEventListener('error', function (e) {
    _showOverlayError('JS Error: ' + e.message + ' (' + (e.filename || '?') + ':' + e.lineno + ')', true);
  });
  window.addEventListener('unhandledrejection', function (e) {
    _showOverlayError('Promise Error: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)), false);
  });
}());

// ---------------------------------------------------------------------------
// Tauri bridge helpers
// ---------------------------------------------------------------------------

const _appInTauri = typeof window !== 'undefined' && window.__TAURI__ !== undefined;

async function invoke(cmd, args = {}) {
  // Try Tauri v2 core.invoke first
  if (window.__TAURI__?.core?.invoke) {
    return window.__TAURI__.core.invoke(cmd, args);
  }
  // Tauri v1 / alternate path
  if (window.__TAURI__?.tauri?.invoke) {
    return window.__TAURI__.tauri.invoke(cmd, args);
  }
  // Direct invoke
  if (window.__TAURI__?.invoke) {
    return window.__TAURI__.invoke(cmd, args);
  }
  console.warn(`invoke('${cmd}') — Tauri IPC not available`);
  return null;
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const State = {
  rpcUrl: 'http://localhost:8545',  // always local node
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
    if (tabName === 'explorer')     refreshExplorer();
    if (tabName === 'validators')   refreshValidators();
    if (tabName === 'send')         updateSendTab();
    if (tabName === 'faucet') {
      updateFaucetTab();
      checkFaucetStatus();
      refreshFaucetBalance();
    }
  });
});

// ---------------------------------------------------------------------------
// Node tab — always-on local validator, no configuration needed
// ---------------------------------------------------------------------------

const nodeDot   = document.getElementById('node-dot');
const nodeLabel = document.getElementById('node-label');
const statsCard = document.getElementById('node-stats-card');

document.getElementById('btn-restart-node')?.addEventListener('click', () => {
  invoke('stop_node').catch(() => {}).finally(() => setTimeout(autoStartLocalNode, 800));
});

function updateNodeValidatorAddr(addr) {
  const el = document.getElementById('node-validator-addr');
  if (el) el.textContent = addr ? `Validator: ${addr}` : 'Load a wallet to activate validator mode';
}

async function autoStartLocalNode() {
  const validatorAddress = State.wallet ? State.wallet.address : null;
  State.rpcUrl = 'http://localhost:8545';
  setNodeIndicator(null, 'Starting…');
  updateNodeValidatorAddr(validatorAddress);
  if (!_appInTauri) {
    // Running in browser without Tauri — show offline, polling will detect the node
    setNodeIndicator(false, 'Node offline');
    return;
  }
  try {
    const result = await invoke('start_node', {
      args: {
        binary_path: null,
        data_dir: getDefaultDataDir(),
        rpc_port: 8545,
        p2p_port: 30341,
        node_id: validatorAddress || 'desktop-wallet',
        bootstrap: '/ip4/88.198.75.149/tcp/30333,/ip4/89.167.89.226/tcp/30333',
        remote_url: null,
        validator_mode: !!validatorAddress,
        validator_address: validatorAddress,
      }
    });
    handleNodeResult(result);
    if (result && result.running) setTimeout(refreshChainStats, 2500);
  } catch (err) {
    setNodeIndicator(false, 'Failed to start');
    showNodeError(err.toString());
  }
}

function handleNodeResult(result) {
  if (!result) return;
  if (result.connected) {
    setNodeIndicator(true, null);
    statsCard.style.display = 'block';
    fillStats(result);
    startStatusPoll();
  } else if (result.running) {
    setNodeIndicator(null, 'Starting…');
    startStatusPoll();
  } else {
    setNodeIndicator(false, 'Failed to start');
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
        // Try direct RPC fetch as fallback (when Tauri IPC can't probe)
        try {
          const data = await rpcFetch('/status');
          const h = data.chain_height ?? data.block_height ?? data.height ?? '?';
          setNodeIndicator(true, `Block ${h}`);
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
  // /status returns chain_height + active_validators (not block_height / validator_count)
  document.getElementById('stat-height').textContent     = data.chain_height ?? data.block_height ?? data.height ?? '—';
  document.getElementById('stat-peers').textContent      = data.peer_count ?? data.peers ?? '—';
  document.getElementById('stat-validators').textContent = data.active_validators ?? data.validator_count ?? '—';
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
    const box = document.getElementById('gen-result');
    box.style.display = 'block';
    box.innerHTML = `<div style="margin-bottom:8px;"><b>Address:</b><br><code style="user-select:all;">${kp.address}</code></div>
<div style="margin-bottom:8px;"><b>Public key:</b><br><code style="user-select:all;">${kp.public_key_hex}</code></div>
<div style="margin-bottom:8px;"><b>Private key:</b><br>
  <span id="privkey-display" style="letter-spacing:0.1em;">••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••</span>
  <button id="btn-show-privkey" class="btn btn-sm" style="margin-left:8px;">Show</button>
  <code id="privkey-text" style="display:none;user-select:all;">${kp.private_key_hex}</code>
</div>
<div class="muted" style="margin-top:8px;color:var(--red,#f44336);">⚠ Save your private key — it cannot be recovered if lost.</div>`;
    document.getElementById('btn-show-privkey').addEventListener('click', function() {
      const display = document.getElementById('privkey-display');
      const text = document.getElementById('privkey-text');
      if (text.style.display === 'none') {
        display.style.display = 'none';
        text.style.display = 'inline';
        this.textContent = 'Hide';
      } else {
        display.style.display = 'inline';
        text.style.display = 'none';
        this.textContent = 'Show';
      }
    });
    loadWallet(kp);
  } catch (err) {
    alert(`Generate keypair failed: ${err}`);
  }
}

async function importPrivkey() {
  const hex = document.getElementById('import-privkey').value.replace(/\s/g, '').toLowerCase();
  if (!hex) { alert('Enter a private key.'); return; }
  if (hex.length !== 64) { alert(`Private key must be exactly 64 hex characters (got ${hex.length}). Make sure you paste only the private key, not the address or public key.`); return; }
  if (!/^[0-9a-f]{64}$/.test(hex)) { alert('Private key contains invalid characters. It must be a 64-character hex string (0-9, a-f).'); return; }
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
        tx_type: 'transfer',
      }
    });
    if (!signed) return;
    const address = await invoke('derive_address', { publicKeyHex: signed.public_key });
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
  // Persist wallet across restarts
  try {
    localStorage.setItem('aura_wallet', JSON.stringify({
      address: kp.address,
      private_key_hex: kp.private_key_hex,
      public_key_hex: kp.public_key_hex,
    }));
  } catch (_) {}
  const placeholder = document.getElementById('wallet-placeholder');
  if (placeholder) placeholder.style.display = 'none';
  document.getElementById('wallet-empty').style.display = 'none';
  document.getElementById('wallet-loaded').style.display = 'block';
  document.getElementById('w-address').textContent = kp.address;
  document.getElementById('w-nonce').textContent = '—';
  document.getElementById('w-balance').textContent = '—';
  updateSendTab();
  refreshBalance();
  document.dispatchEvent(new Event("walletLoaded"));
  // Restart local node with the wallet address as validator ID
  invoke('stop_node').catch(() => {}).finally(() => setTimeout(autoStartLocalNode, 800));
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
    try {
      const vd = await rpcFetch(`/validators/${State.wallet.address}`);
      const stake = vd.stake ?? vd.staked_amount ?? 0;
      const stakedEl = document.getElementById('w-staked');
      if (stake > 0) {
        stakedEl.textContent = `${fmt(stake)} AURA${vd.is_active ? ' ✓ active validator' : ''}`;
        stakedEl.style.color = vd.is_active ? 'var(--green, #4caf50)' : '';
      } else {
        stakedEl.textContent = 'Not staked';
        stakedEl.style.color = '';
      }
    } catch (_) {
      document.getElementById('w-staked').textContent = 'Not staked';
    }
  } catch (err) {
    document.getElementById('w-balance').textContent = `Error: ${err.message}`;
  }
}

function clearWallet() {
  State.wallet = null;
  try { localStorage.removeItem('aura_wallet'); } catch (_) {}
  const placeholder = document.getElementById('wallet-placeholder');
  if (placeholder) placeholder.style.display = 'block';
  document.getElementById('wallet-empty').style.display = 'block';
  document.getElementById('wallet-loaded').style.display = 'none';
  document.getElementById('gen-result').style.display = 'none';
  updateSendTab();

  document.dispatchEvent(new Event("walletCleared"));
  updateNodeValidatorAddr(null);
  // Restart node without validator mode when wallet is cleared
  invoke('stop_node').catch(() => {}).finally(() => setTimeout(autoStartLocalNode, 800));
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
    const nd = await rpcFetch(`/accounts/${State.wallet.address}/nonce`);
    const nonce = nd.next_nonce ?? (nd.nonce != null ? nd.nonce + 1 : 1);

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
      id: signed.id,
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
    const height = status.chain_height ?? status.block_height ?? status.height ?? 0;

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
// Faucet tab
// ---------------------------------------------------------------------------

document.getElementById('btn-faucet-request')?.addEventListener('click', requestFaucet);
document.getElementById('btn-faucet-check')?.addEventListener('click', checkFaucetStatus);

function updateFaucetTab() {
  const noWallet = document.getElementById('faucet-no-wallet');
  const form = document.getElementById('faucet-form');
  if (State.wallet) {
    noWallet.style.display = 'none';
    form.style.display = 'block';
    document.getElementById('faucet-address').textContent = State.wallet.address;
  } else {
    noWallet.style.display = 'block';
    form.style.display = 'none';
  }
}

async function requestFaucet() {
  const errEl = document.getElementById('faucet-error');
  const resultEl = document.getElementById('faucet-result');
  errEl.style.display = 'none';
  resultEl.style.display = 'none';

  if (!State.wallet) {
    errEl.textContent = 'No wallet loaded.';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('btn-faucet-request');
  btn.disabled = true;
  btn.textContent = 'Requesting…';

  try {
    const response = await fetch(`${rpcBase()}/faucet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: State.wallet.address }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(error.error || error.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    resultEl.textContent = `Success! Received 1010 AURA\nTransaction Hash: ${data.transaction_hash || data.tx_hash || 'pending'}\nAmount: ${data.amount ?? '1010.00000000'} AURA\n\nThe faucet has a cooldown of 24 hours per address.`;
    resultEl.style.display = 'block';

    // Refresh balance after a short delay
    setTimeout(() => refreshBalance(), 2000);

    // Check faucet status
    setTimeout(checkFaucetStatus, 2000);
  } catch (err) {
    errEl.textContent = `Faucet request failed: ${err.message}`;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Request 1010 AURA';
  }
}

async function checkFaucetStatus() {
  if (!State.wallet) return;
  const cooldownEl = document.getElementById('faucet-cooldown');
  if (!cooldownEl) return;

  try {
    const base = rpcBase();
    if (!base) { cooldownEl.textContent = '—'; return; }

    const response = await fetch(`${base}/faucet/${State.wallet.address}`, { method: 'GET' });

    // 404 means address never requested — ready to go
    if (response.status === 404) {
      cooldownEl.textContent = 'Ready to request';
      cooldownEl.style.color = 'var(--green, #4caf50)';
      return;
    }

    const data = await response.json().catch(() => ({}));

    if (data.last_request || data.last_claim) {
      const raw = data.last_request || data.last_claim;
      // Try Unix timestamp (seconds) or ISO string
      const lastTime = typeof raw === 'number' ? new Date(raw * 1000) : new Date(raw);
      const nextTime = new Date(lastTime.getTime() + 24 * 60 * 60 * 1000);
      const now = new Date();

      if (now < nextTime) {
        const hoursLeft = Math.ceil((nextTime - now) / (60 * 60 * 1000));
        cooldownEl.textContent = `Cooldown active — ${hoursLeft}h remaining`;
        cooldownEl.style.color = 'var(--red, #f44336)';
      } else {
        cooldownEl.textContent = 'Ready to request';
        cooldownEl.style.color = 'var(--green, #4caf50)';
      }
    } else {
      cooldownEl.textContent = 'Ready to request';
      cooldownEl.style.color = 'var(--green, #4caf50)';
    }
  } catch (_) {
    cooldownEl.textContent = 'Connect to a node first';
    cooldownEl.style.color = '';
  }
}

async function refreshFaucetBalance() {
  try {
    const data = await rpcFetch('/faucet');
    const balanceInfo = document.getElementById('faucet-balance-info');
    balanceInfo.textContent = `Available: ${fmt(data.balance || 0)} AURA\nNext replenish: ${data.next_replenish || 'Unknown'}`;
  } catch (_) {
    document.getElementById('faucet-balance-info').textContent = 'Unable to load faucet info';
  }
}

// Override loadWallet to update faucet tab
const originalLoadWallet = loadWallet;
loadWallet = function(kp) {
  originalLoadWallet(kp);
  updateFaucetTab();
  checkFaucetStatus();
  refreshFaucetBalance();
};

// Override clearWallet to update faucet tab
const originalClearWallet = clearWallet;
clearWallet = function() {
  originalClearWallet();
  updateFaucetTab();
};

// Update faucet tab when switching to it
document.addEventListener('DOMContentLoaded', () => {
  const faucetBtn = document.querySelector('[data-tab="faucet"]');
  if (faucetBtn) {
    faucetBtn.addEventListener('click', () => {
      updateFaucetTab();
      checkFaucetStatus();
      refreshFaucetBalance();
    });
  }
});

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

    // Sort validators by blocks_produced (descending)
    validators.sort((a, b) => {
      const prodA = a.blocks_produced ?? a.blocks ?? 0;
      const prodB = b.blocks_produced ?? b.blocks ?? 0;
      return prodB - prodA;
    });

    tbody.innerHTML = '';
    validators.forEach(v => {
      const tr = document.createElement('tr');
      const addr     = v.address ?? v.id ?? '—';
      const stake    = fmt(v.stake ?? v.total_stake ?? 0);
      const produced = v.blocks_produced ?? v.blocks ?? '—';
      const rep      = v.reputation_score ?? v.reputation ?? '—';
      const jailed   = v.is_jailed || v.jailed ? 'Yes' : 'No';
      const isActive = !jailed || jailed === 'No' ? 'Active' : 'Jailed';
      const statusColor = isActive === 'Active' ? 'var(--green)' : 'var(--red)';

      tr.innerHTML = `
        <td title="${addr}">${truncate(addr, 24)}</td>
        <td><span style="color:${statusColor}; font-weight:bold;">● ${isActive}</span></td>
        <td>${stake}</td>
        <td><strong>${produced}</strong></td>
        <td>${rep}</td>
        <td><button class="btn btn-sm" onclick="stakeToValidator('${addr}')">Stake</button></td>
      `;
      tbody.appendChild(tr);
    });

    if (validators.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted" style="text-align:center;padding:20px;">No validators found. Connect to a node first.</td></tr>';
    }
  } catch (err) {
    errEl.textContent = `Could not fetch validators: ${err.message}. Connect to a node first.`;
    errEl.style.display = 'block';
  }
}

/** Pre-fill Send tab for staking to a validator */
function stakeToValidator(validatorAddr) {
  // Switch to Staking tab
  const stakingBtn = document.querySelector('[data-tab="staking"]');
  if (stakingBtn) stakingBtn.click();

  // Pre-fill the delegate form
  document.getElementById('delegate-to').value = validatorAddr;
  document.getElementById('delegate-amount').value = '100.00000000';
  document.getElementById('delegate-fee').value = '0.00100000';
  document.getElementById('delegate-amount').focus();
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
  // Restore saved wallet from previous session
  try {
    const savedWallet = localStorage.getItem('aura_wallet');
    if (savedWallet) {
      const kp = JSON.parse(savedWallet);
      if (kp && kp.address && kp.private_key_hex) {
        // Restore wallet state without triggering node restart (node starts below)
        State.wallet = { address: kp.address, privateKeyHex: kp.private_key_hex, publicKeyHex: kp.public_key_hex };
        const placeholder = document.getElementById('wallet-placeholder');
        if (placeholder) placeholder.style.display = 'none';
        document.getElementById('wallet-empty').style.display = 'none';
        document.getElementById('wallet-loaded').style.display = 'block';
        document.getElementById('w-address').textContent = kp.address;
        document.getElementById('w-nonce').textContent = '—';
        document.getElementById('w-balance').textContent = '—';
        updateSendTab();
        refreshBalance();
        updateNodeValidatorAddr(kp.address);
      }
    }
  } catch (_) {}

  // Always auto-start the local validator node on launch
  setTimeout(autoStartLocalNode, 300);

  initStakingTab();
  initMultiSigTab();
  initTimelockTab();
}


// ---------------------------------------------------------------------------
// Utility helpers for new tabs
// ---------------------------------------------------------------------------

function showTabResult(id, text) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.style.display = "";
}

function hideTabEl(id) {
  var el = document.getElementById(id);
  if (el) el.style.display = "none";
}

function showTabError(id, msg) {
  var el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.style.display = "";
}

// sendTypedTx - sign and submit typed transaction via Tauri

async function sendTypedTx(txType, to, amount, fee, resultId, errorId) {
  hideTabEl(resultId);
  hideTabEl(errorId);
  if (!State.wallet) { showTabError(errorId, "No wallet loaded"); return; }
  try {
    var nd = await rpcFetch("/accounts/" + State.wallet.address + "/nonce");
    var nonce = nd.next_nonce != null ? nd.next_nonce : (nd.nonce != null ? nd.nonce + 1 : 1);
    var timestamp = Math.floor(Date.now() / 1000);
    var signed = await invoke("sign_transaction", {
      args: {
        private_key_hex: State.wallet.privateKeyHex,
        from: State.wallet.address,
        to: to, amount: amount, fee: fee,
        nonce: nonce, timestamp: timestamp, tx_type: txType
      }
    });
    if (!signed) return;
    var body = {
      id: signed.id,
      from: signed.from, to: signed.to, amount: signed.amount, fee: signed.fee,
      nonce: signed.nonce, timestamp: signed.timestamp,
      signature: signed.signature, public_key: signed.public_key,
      tx_type: signed.tx_type, signing_algorithm: signed.signing_algorithm
    };
    var res = await fetch(rpcBase() + "/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    var rj = await res.json().catch(function() { return { status: res.statusText }; });
    showTabResult(resultId, JSON.stringify(rj, null, 2));
  } catch (e) {
    showTabError(errorId, e.message || String(e));
  }
}

// ---------------------------------------------------------------------------
// STAKING TAB
// ---------------------------------------------------------------------------

function initStakingTab() {
  function updateStakingVisibility() {
    var hasWallet = !!State.wallet;
    var nw = document.getElementById("staking-no-wallet");
    var fm = document.getElementById("staking-form");
    if (nw) nw.style.display = hasWallet ? "none" : "";
    if (fm) fm.style.display = hasWallet ? "" : "none";
  }
  document.addEventListener("walletLoaded", updateStakingVisibility);
  document.addEventListener("walletCleared", updateStakingVisibility);
  updateStakingVisibility();
  var btnStake = document.getElementById("btn-stake");
  if (btnStake) btnStake.addEventListener("click", async function() {
    var amount = parseFloat(document.getElementById("stake-amount").value);
    var fee = parseFloat(document.getElementById("stake-fee").value) || 0.001;
    if (!amount || amount < 1000) { showTabError("stake-error", "Minimum stake is 1,000 AURA"); return; }
    // Check balance: must have amount + fee available
    try {
      var balData = await rpcFetch("/accounts/" + State.wallet.address + "/balance");
      var bal = balData.balance ?? balData ?? 0;
      if (bal < amount + fee) {
        showTabError("stake-error", "Insufficient balance: need " + (amount + fee).toFixed(8) + " AURA (you have " + bal.toFixed(8) + ")");
        return;
      }
    } catch (_) {}
    await sendTypedTx("stake", State.wallet.address, amount, fee, "stake-result", "stake-error");
  });
  var btnUnstake = document.getElementById("btn-unstake");
  if (btnUnstake) btnUnstake.addEventListener("click", async function() {
    var fee = parseFloat(document.getElementById("stake-fee").value) || 0.001;
    await sendTypedTx("unstake", State.wallet.address, 0, fee, "stake-result", "stake-error");
  });
  var btnDelegate = document.getElementById("btn-delegate");
  if (btnDelegate) btnDelegate.addEventListener("click", async function() {
    var to = document.getElementById("delegate-to").value.trim();
    var amount = parseFloat(document.getElementById("delegate-amount").value);
    var fee = parseFloat(document.getElementById("delegate-fee").value) || 0.001;
    if (!to) { showTabError("delegate-error", "Enter validator address"); return; }
    if (!amount) { showTabError("delegate-error", "Enter amount"); return; }
    await sendTypedTx("delegate", to, amount, fee, "delegate-result", "delegate-error");
  });
  var btnUndelegate = document.getElementById("btn-undelegate");
  if (btnUndelegate) btnUndelegate.addEventListener("click", async function() {
    var to = document.getElementById("delegate-to").value.trim();
    var amount = parseFloat(document.getElementById("delegate-amount").value) || 0;
    var fee = parseFloat(document.getElementById("delegate-fee").value) || 0.001;
    if (!to) { showTabError("delegate-error", "Enter validator address"); return; }
    await sendTypedTx("undelegate", to, amount, fee, "delegate-result", "delegate-error");
  });
}

// ---------------------------------------------------------------------------
// MULTI-SIG TAB
// ---------------------------------------------------------------------------

function initMultiSigTab() {
  var btnMsigCreate = document.getElementById("btn-msig-create");
  if (btnMsigCreate) btnMsigCreate.addEventListener("click", async function() {
    hideTabEl("msig-create-result"); hideTabEl("msig-create-error");
    if (!State.wallet) { showTabError("msig-create-error", "No wallet loaded"); return; }
    var lines = document.getElementById("msig-signers").value
      .trim().split("\n").map(function(s) { return s.trim(); }).filter(Boolean);
    var threshold = parseInt(document.getElementById("msig-threshold").value);
    var fee = parseFloat(document.getElementById("msig-create-fee").value) || 0.001;
    if (lines.length < 2) { showTabError("msig-create-error", "Need at least 2 signers"); return; }
    if (threshold < 1 || threshold > lines.length) { showTabError("msig-create-error", "Invalid threshold"); return; }
    var msigData = JSON.stringify({ signers: lines, threshold: threshold });
    await sendTypedTx("MultisigCreate", msigData, 0, fee, "msig-create-result", "msig-create-error");
  });
  var btnMsigPropose = document.getElementById("btn-msig-propose");
  if (btnMsigPropose) btnMsigPropose.addEventListener("click", async function() {
    hideTabEl("msig-propose-result"); hideTabEl("msig-propose-error");
    if (!State.wallet) { showTabError("msig-propose-error", "No wallet loaded"); return; }
    var from = document.getElementById("msig-from").value.trim();
    var to = document.getElementById("msig-to").value.trim();
    var amount = parseFloat(document.getElementById("msig-amount").value) || 0;
    var fee = parseFloat(document.getElementById("msig-propose-fee").value) || 0.001;
    if (!from || !to) { showTabError("msig-propose-error", "Fill in all fields"); return; }
    await sendTypedTx("MultisigPropose", to, amount, fee, "msig-propose-result", "msig-propose-error");
  });
  var btnMsigApprove = document.getElementById("btn-msig-approve");
  if (btnMsigApprove) btnMsigApprove.addEventListener("click", async function() {
    hideTabEl("msig-approve-result"); hideTabEl("msig-approve-error");
    if (!State.wallet) { showTabError("msig-approve-error", "No wallet loaded"); return; }
    var txId = document.getElementById("msig-approve-txid").value.trim();
    var fee = parseFloat(document.getElementById("msig-approve-fee").value) || 0.001;
    if (!txId) { showTabError("msig-approve-error", "Enter tx ID to approve"); return; }
    await sendTypedTx("MultisigApprove", txId, 0, fee, "msig-approve-result", "msig-approve-error");
  });
  var btnMsigRefresh = document.getElementById("btn-msig-refresh");
  if (btnMsigRefresh) btnMsigRefresh.addEventListener("click", async function() {
    hideTabEl("msig-wallets-list");
    try {
      var data = await rpcFetch("/multisig/wallets");
      var el = document.getElementById("msig-wallets-list");
      el.textContent = JSON.stringify(data, null, 2);
      el.style.display = "";
    } catch (e) { console.error("msig wallets fetch error", e); }
  });
}

// ---------------------------------------------------------------------------
// TIME-LOCK TAB
// ---------------------------------------------------------------------------

function initTimelockTab() {
  function updateTimelockVisibility() {
    var hasWallet = !!State.wallet;
    var nw = document.getElementById("timelock-no-wallet");
    var fm = document.getElementById("timelock-form");
    if (nw) nw.style.display = hasWallet ? "none" : "";
    if (fm) fm.style.display = hasWallet ? "" : "none";
  }
  document.addEventListener("walletLoaded", updateTimelockVisibility);
  document.addEventListener("walletCleared", updateTimelockVisibility);
  updateTimelockVisibility();
  var btnTlSend = document.getElementById("btn-tl-send");
  if (btnTlSend) btnTlSend.addEventListener("click", async function() {
    hideTabEl("tl-result"); hideTabEl("tl-error");
    if (!State.wallet) { showTabError("tl-error", "No wallet loaded"); return; }
    var to = document.getElementById("tl-to").value.trim();
    var amount = parseFloat(document.getElementById("tl-amount").value);
    var fee = parseFloat(document.getElementById("tl-fee").value) || 0.001;
    var notBefore = parseInt(document.getElementById("tl-height").value);
    if (!to) { showTabError("tl-error", "Enter recipient address"); return; }
    if (!amount) { showTabError("tl-error", "Enter amount"); return; }
    if (!notBefore || notBefore < 1) { showTabError("tl-error", "Enter a valid block height"); return; }
    try {
      var nd = await rpcFetch("/accounts/" + State.wallet.address + "/nonce");
      var nonce = nd.next_nonce != null ? nd.next_nonce : (nd.nonce != null ? nd.nonce + 1 : 1);
      var timestamp = Math.floor(Date.now() / 1000);
      var signed = await invoke("sign_transaction", {
        args: {
          private_key_hex: State.wallet.privateKeyHex,
          from: State.wallet.address,
          to: to, amount: amount, fee: fee,
          nonce: nonce, timestamp: timestamp, tx_type: "transfer"
        }
      });
      if (!signed) return;
      var body = {
        from: signed.from, to: signed.to, amount: signed.amount, fee: signed.fee,
        id: signed.id,
        nonce: signed.nonce, timestamp: signed.timestamp,
        signature: signed.signature, public_key: signed.public_key,
        tx_type: signed.tx_type, signing_algorithm: signed.signing_algorithm,
        not_before_height: notBefore
      };
      var res = await fetch(rpcBase() + "/transactions/timelock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      var rj = await res.json().catch(function() { return { status: res.statusText }; });
      showTabResult("tl-result", JSON.stringify(rj, null, 2));
    } catch (e) { showTabError("tl-error", e.message || String(e)); }
  });
  var btnTlCheck = document.getElementById("btn-tl-check");
  if (btnTlCheck) btnTlCheck.addEventListener("click", async function() {
    hideTabEl("tl-check-result");
    var hash = document.getElementById("tl-check-hash").value.trim();
    if (!hash) return;
    try {
      var data = await rpcFetch("/transactions/" + hash + "/unlock-status");
      showTabResult("tl-check-result", JSON.stringify(data, null, 2));
    } catch (e) { console.error("timelock check error", e); }
  });
}

document.addEventListener('DOMContentLoaded', init);
