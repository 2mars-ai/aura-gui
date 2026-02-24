// src-tauri/src/node.rs
// Node management: local subprocess launch OR remote node connection.

use std::process::{Child, Command};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::State;

// ---------------------------------------------------------------------------
// Shared mutable state
// ---------------------------------------------------------------------------

pub struct NodeState {
    pub child: Mutex<Option<Child>>,
    /// The RPC URL of the node we are talking to (local or remote).
    pub rpc_url: Mutex<String>,
}

impl NodeState {
    pub fn new() -> Self {
        NodeState {
            child: Mutex::new(None),
            rpc_url: Mutex::new("http://89.167.89.226:8545".to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NodeStatusResult {
    /// Whether the local subprocess is running (false when using a remote node).
    pub running: bool,
    /// PID of the local subprocess, if any.
    pub pid: Option<u32>,
    /// RPC URL currently in use.
    pub rpc_url: Option<String>,
    /// Whether the RPC endpoint returned a successful response.
    pub connected: bool,
    /// Latest block height reported by /status.
    pub block_height: Option<u64>,
    /// Peer count reported by /status.
    pub peer_count: Option<u64>,
    /// Validator count reported by /status.
    pub validator_count: Option<u64>,
    /// Total supply reported by /status.
    pub total_supply: Option<f64>,
    /// Chain ID reported by /status.
    pub chain_id: Option<String>,
    /// Version reported by /status.
    pub version: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StartNodeArgs {
    /// For local mode: absolute path to the auracore binary.
    pub binary_path: Option<String>,
    /// For local mode: absolute path to the data directory.
    pub data_dir: Option<String>,
    /// For local mode: HTTP RPC port (default 8545).
    pub rpc_port: Option<u16>,
    /// For local mode: P2P listen port (default 30341).
    pub p2p_port: Option<u16>,
    /// For local mode: node identifier string.
    pub node_id: Option<String>,
    /// For local mode: comma-separated bootstrap peers multiaddrs.
    pub bootstrap: Option<String>,
    /// Remote node URL (used instead of launching a local binary).
    /// Example: "http://89.167.89.226:8545"
    /// If set, no subprocess is spawned; we just talk to this URL.
    pub remote_url: Option<String>,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Connect to a node (local subprocess or remote URL).
///
/// If `args.remote_url` is set, we store that URL and query its /status.
/// Otherwise, we attempt to spawn a local auracore subprocess.
#[tauri::command]
pub async fn start_node(
    args: StartNodeArgs,
    state: State<'_, NodeState>,
) -> Result<NodeStatusResult, String> {
    // Remote mode — no subprocess
    if let Some(ref url) = args.remote_url {
        let clean = url.trim_end_matches('/').to_string();
        *state.rpc_url.lock().map_err(|e| e.to_string())? = clean.clone();

        // Probe the node
        let status = probe_rpc(&clean).await;
        return Ok(NodeStatusResult {
            running: false,
            pid: None,
            rpc_url: Some(clean),
            ..status
        });
    }

    // Local subprocess mode
    let rpc_port = args.rpc_port.unwrap_or(8545);
    let local_url = format!("http://localhost:{}", rpc_port);
    *state.rpc_url.lock().map_err(|e| e.to_string())? = local_url.clone();

    let binary = args.binary_path.clone().unwrap_or_else(|| "auracore".to_string());
    let data_dir = args.data_dir.clone().unwrap_or_else(|| ".auracore/data".to_string());
    let p2p_port = args.p2p_port.unwrap_or(30341);
    let node_id = args.node_id.clone().unwrap_or_else(|| "desktop-wallet".to_string());
    let bootstrap = args.bootstrap.clone().unwrap_or_else(|| {
        "/ip4/88.198.75.149/tcp/30333,/ip4/89.167.89.226/tcp/30333".to_string()
    });

    let genesis_validators = concat!(
        "aura1validator1:10000,aura1validator2:10000,aura1validator3:10000,",
        "aura1armvalidator1:10000,aura1armvalidator2:10000,aura1armvalidator3:10000,",
        "aura1armvalidator4:10000,aura1armvalidator5:10000,aura1armvalidator6:10000,",
        "aura1armvalidator7:10000,aura1armvalidator8:10000"
    );

    // Check if already running — acquire and release guard before any await
    let already_running_pid: Option<u32> = {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        match guard.as_mut() {
            Some(child) => {
                if let Ok(None) = child.try_wait() {
                    Some(child.id())
                } else {
                    *guard = None;
                    None
                }
            }
            None => None,
        }
    }; // guard dropped here before any await

    if let Some(pid) = already_running_pid {
        let status = probe_rpc(&local_url).await;
        return Ok(NodeStatusResult {
            running: true,
            pid: Some(pid),
            rpc_url: Some(local_url),
            ..status
        });
    }

    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Could not create data dir '{}': {e}", data_dir))?;

    let child = Command::new(&binary)
        .arg("node")
        .arg(format!("--data-dir={}", data_dir))
        .arg(format!("--port={}", p2p_port))
        .arg(format!("--rpc-port={}", rpc_port))
        .arg(format!("--node-id={}", node_id))
        .arg(format!("--bootstrap={}", bootstrap))
        .arg(format!("--genesis-validators={}", genesis_validators))
        .env("RUST_LOG", "warn")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| {
            format!(
                "Failed to launch '{}': {}. Place auracore.exe next to aura-gui.exe or in PATH.",
                binary, e
            )
        })?;

    let pid = child.id();
    // Store child — acquire guard fresh, no await follows
    *state.child.lock().map_err(|e| e.to_string())? = Some(child);

    Ok(NodeStatusResult {
        running: true,
        pid: Some(pid),
        rpc_url: Some(local_url),
        connected: false,
        block_height: None,
        peer_count: None,
        validator_count: None,
        total_supply: None,
        chain_id: None,
        version: None,
    })
}

/// Stop the running local node subprocess (no-op for remote nodes).
#[tauri::command]
pub fn stop_node(state: State<'_, NodeState>) -> Result<NodeStatusResult, String> {
    let mut guard = state.child.lock().map_err(|e| e.to_string())?;
    let url = state.rpc_url.lock().map_err(|e| e.to_string())?.clone();

    if let Some(mut child) = guard.take() {
        child.kill().map_err(|e| format!("Failed to kill node process: {e}"))?;
        let _ = child.wait();
    }

    Ok(NodeStatusResult {
        running: false,
        pid: None,
        rpc_url: Some(url),
        connected: false,
        block_height: None,
        peer_count: None,
        validator_count: None,
        total_supply: None,
        chain_id: None,
        version: None,
    })
}

/// Poll the current node (local subprocess or remote URL) for status.
#[tauri::command]
pub async fn get_node_status(state: State<'_, NodeState>) -> Result<NodeStatusResult, String> {
    // Collect url and subprocess state without holding the guard across an await
    let url = state.rpc_url.lock().map_err(|e| e.to_string())?.clone();

    let (running, pid) = {
        let mut guard = state.child.lock().map_err(|e| e.to_string())?;
        match guard.as_mut() {
            None => (false, None),
            Some(child) => match child.try_wait() {
                Ok(None) => (true, Some(child.id())),
                _ => {
                    *guard = None;
                    (false, None)
                }
            },
        }
    }; // guard dropped before await below

    let status = probe_rpc(&url).await;
    Ok(NodeStatusResult {
        running,
        pid,
        rpc_url: Some(url),
        ..status
    })
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Probe a node RPC endpoint and return whatever fields are available.
async fn probe_rpc(url: &str) -> NodeStatusResult {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return NodeStatusResult {
                running: false,
                pid: None,
                rpc_url: Some(url.to_string()),
                connected: false,
                block_height: None,
                peer_count: None,
                validator_count: None,
                total_supply: None,
                chain_id: None,
                version: None,
            };
        }
    };

    match client.get(format!("{}/status", url)).send().await {
        Ok(resp) if resp.status().is_success() => {
            let json: serde_json::Value = match resp.json().await {
                Ok(v) => v,
                Err(_) => serde_json::Value::Null,
            };
            NodeStatusResult {
                running: false, // overwritten by caller
                pid: None,
                rpc_url: Some(url.to_string()),
                connected: true,
                block_height: json["block_height"].as_u64().or_else(|| json["height"].as_u64()),
                peer_count: json["peer_count"].as_u64().or_else(|| json["peers"].as_u64()),
                validator_count: json["validator_count"].as_u64(),
                total_supply: json["total_supply"].as_f64(),
                chain_id: json["chain_id"].as_str().map(String::from),
                version: json["version"].as_str().map(String::from),
            }
        }
        _ => NodeStatusResult {
            running: false,
            pid: None,
            rpc_url: Some(url.to_string()),
            connected: false,
            block_height: None,
            peer_count: None,
            validator_count: None,
            total_supply: None,
            chain_id: None,
            version: None,
        },
    }
}
