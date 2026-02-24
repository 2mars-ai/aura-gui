# aura-gui

AuraCore Desktop — native Windows/Linux GUI for the AuraCore PoS blockchain.
Combines a full node runner, wallet, block explorer, and validator dashboard in
a single ~5 MB executable built with [Tauri v2](https://tauri.app).

---

## Features

| Tab | Functionality |
|-----|---------------|
| **Node** | Start / stop the embedded `auracore` full node, view chain status (block height, peers, supply) |
| **Wallet** | Generate Ed25519 keypair, import private key, view balance + nonce, export/import encrypted keystore |
| **Send** | Build, sign, and submit transactions (Transfer, Stake, Delegate, Governance, Name Register) |
| **Explorer** | Browse latest 20 blocks, click for full block JSON detail |
| **Validators** | Live validator table — stake, blocks produced, reputation score, jailed status |

---

## Prerequisites

| Tool | Version | Install |
|------|---------|---------|
| Rust + Cargo | 1.77+ | https://rustup.rs |
| Tauri CLI v2 | latest | `cargo install tauri-cli --version "^2"` |
| WebView2 (Windows) | latest | Bundled with Windows 11 / install from Microsoft |
| `auracore.exe` | latest | Build from `AuraCore/` repo or copy from `target/release/` |

---

## Quick Start

### 1. Build auracore.exe (if you do not have it yet)

```powershell
cd C:\Users\SOC\Documents\GitHub\AuraCore
cargo build --release --bin auracore
# binary at:  target\release\auracore.exe
```

### 2. Copy auracore.exe next to the GUI (for development)

```powershell
Copy-Item AuraCore\target\release\auracore.exe aura-gui\
```

During development the GUI will look for `auracore` on your `PATH`.
In a production bundle, copy `auracore.exe` into `src-tauri/binaries/` and configure a Tauri sidecar (see below).

### 3. Run in development mode

```powershell
cd C:\Users\SOC\Documents\GitHub\aura-gui
cargo tauri dev
```

This opens the app with hot-reload of the HTML/JS frontend.

### 4. Build a release .exe / .msi installer

```powershell
cargo tauri build
# output: src-tauri\target\release\bundle\
```

---

## Embedding auracore as a Tauri Sidecar

To ship a single installer that includes the node binary:

1. Copy `auracore.exe` to `src-tauri/binaries/auracore-x86_64-pc-windows-msvc.exe`
2. Add to `tauri.conf.json` under `bundle`:
   ```json
   "externalBin": ["binaries/auracore"]
   ```
3. In `node.rs`, use `tauri::path::resource_dir()` to locate the sidecar at runtime.

---

## Architecture

```
aura-gui/
  Cargo.toml                  Workspace root
  src/
    index.html                Main UI — tab layout
    style.css                 Dark theme
    app.js                    Tab logic, fetch() calls to localhost:8545
  src-tauri/
    Cargo.toml                Tauri app crate
    build.rs                  tauri-build
    tauri.conf.json           Window config, bundle config, CSP
    src/
      main.rs                 Tauri entry point
      lib.rs                  run() — registers commands
      node.rs                 start_node / stop_node / get_node_status
      wallet.rs               generate_keypair / sign_transaction / keystore
      crypto.rs               Ed25519 + aura1 address derivation
```

### Node communication

The frontend calls `window.__TAURI__.core.invoke('start_node', {...})` to spawn
`auracore.exe` as a subprocess (via `std::process::Command`). Once the node is
up, all blockchain data is fetched directly from the local REST API:

```
http://localhost:8545/status
http://localhost:8545/validators
http://localhost:8545/blocks/{height}
http://localhost:8545/accounts/{address}/balance
http://localhost:8545/transactions   (POST)
```

### Wallet signing

The Tauri backend handles all private key operations in Rust (never in JS):

1. Frontend calls `invoke('sign_transaction', args)` with private key hex + tx params
2. Rust backend builds the canonical signing payload:
   `"{from}:{to}:{amount:.8}:{fee:.8}:{nonce}:{timestamp}"`
3. Signs with Ed25519 (same as AuraCore node expects)
4. Returns the full transaction JSON — frontend POSTs it to `/transactions`

### Keystore format

The encrypted keystore is AES-256-GCM + PBKDF2-SHA256 (100,000 iterations),
100% compatible with the format produced by `aura-cli` and the `auracore-web`
wallet. Keystores can be moved between all three interfaces.

---

## Configuration

The Node tab stores settings in memory only (no persistence yet). On next launch,
enter your configuration or set defaults by editing `src/app.js`:

```javascript
// Default bootstrap peers (change if connecting to a private testnet):
const DEFAULT_BOOTSTRAP = '/ip4/88.198.75.149/tcp/30333,/ip4/89.167.89.226/tcp/30333';
```

---

## Known Limitations (MVP)

- Settings are not persisted between launches (planned: Tauri store plugin)
- Node log output is currently discarded; a log viewer tab is planned
- Icons are placeholder — run `cargo tauri icon <icon.png>` to generate all sizes
- No auto-update mechanism yet (planned: Tauri updater plugin)

---

## License

MIT — see AuraCore repository for full terms.
