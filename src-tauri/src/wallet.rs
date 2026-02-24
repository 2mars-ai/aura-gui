// src-tauri/src/wallet.rs
// Tauri commands for wallet operations: key generation, signing, keystore I/O.

use serde::{Deserialize, Serialize};
use tauri::command;

use crate::crypto::{KeyPair, build_signing_payload};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm,
    Nonce,
};
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use rand::RngCore;

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct GeneratedKeypair {
    pub private_key_hex: String,
    pub public_key_hex: String,
    pub address: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SignTxArgs {
    pub private_key_hex: String,
    pub from: String,
    pub to: String,
    pub amount: f64,
    pub fee: f64,
    pub nonce: u64,
    pub timestamp: u64,
    pub tx_type: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SignedTxPayload {
    pub from: String,
    pub to: String,
    pub amount: f64,
    pub fee: f64,
    pub nonce: u64,
    pub timestamp: u64,
    pub signature: String,
    pub public_key: String,
    pub tx_type: String,
    pub signing_algorithm: String,
}

// Keystore JSON format — matches AuraCore keystore.rs exactly
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KeystoreFile {
    pub version: u32,
    pub address: String,
    pub public_key_hex: String,
    pub kdf: String,
    pub kdf_params: KdfParams,
    pub cipher: String,
    pub ciphertext_hex: String,
    pub nonce_hex: String,
    pub salt_hex: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct KdfParams {
    pub iterations: u32,
}

const PBKDF2_ITERATIONS: u32 = 100_000;
const SALT_LEN: usize = 32;
const NONCE_LEN: usize = 12;

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Generate a brand-new Ed25519 keypair.
#[command]
pub fn generate_keypair() -> Result<GeneratedKeypair, String> {
    let kp = KeyPair::generate();
    Ok(GeneratedKeypair {
        private_key_hex: kp.private_key_hex(),
        public_key_hex: kp.public_key_hex(),
        address: kp.address(),
    })
}

/// Derive the aura1 address from a public key hex string (64 chars).
#[command]
pub fn derive_address(public_key_hex: String) -> Result<String, String> {
    use ed25519_dalek::VerifyingKey;
    let bytes = hex::decode(&public_key_hex)
        .map_err(|e| format!("invalid hex: {e}"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "public key must be 32 bytes".to_string())?;
    let vk = VerifyingKey::from_bytes(&arr)
        .map_err(|e| format!("invalid Ed25519 key: {e}"))?;
    Ok(crate::crypto::derive_address(&vk))
}

/// Build and sign a transaction, returning the full payload ready for
/// POST /transactions on the running node.
#[command]
pub fn sign_transaction(args: SignTxArgs) -> Result<SignedTxPayload, String> {
    let kp = KeyPair::from_private_hex(&args.private_key_hex)?;

    let payload = build_signing_payload(
        &args.from,
        &args.to,
        args.amount,
        args.fee,
        args.nonce,
        args.timestamp,
    );

    let signature = kp.sign(&payload);
    let tx_type = args.tx_type.unwrap_or_else(|| "Transfer".to_string());

    Ok(SignedTxPayload {
        from: args.from,
        to: args.to,
        amount: args.amount,
        fee: args.fee,
        nonce: args.nonce,
        timestamp: args.timestamp,
        signature,
        public_key: kp.public_key_hex(),
        tx_type,
        signing_algorithm: "ed25519".to_string(),
    })
}

/// Encrypt a private key with a password and return a Keystore JSON string.
/// The format is identical to AuraCore's keystore.rs output so keystores
/// are interchangeable between the CLI, web wallet, and this desktop app.
#[command]
pub fn create_keystore(private_key_hex: String, password: String) -> Result<String, String> {
    let kp = KeyPair::from_private_hex(&private_key_hex)?;

    let mut rng = rand::rngs::OsRng;

    let mut salt = [0u8; SALT_LEN];
    rng.fill_bytes(&mut salt);

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, PBKDF2_ITERATIONS, &mut key);

    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("cipher init: {e}"))?;

    let plaintext = kp.private_key_hex().into_bytes();
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("encryption failed: {e}"))?;

    let ks = KeystoreFile {
        version: 1,
        address: kp.address(),
        public_key_hex: kp.public_key_hex(),
        kdf: "pbkdf2-sha256".to_string(),
        kdf_params: KdfParams { iterations: PBKDF2_ITERATIONS },
        cipher: "aes-256-gcm".to_string(),
        ciphertext_hex: hex::encode(&ciphertext),
        nonce_hex: hex::encode(nonce_bytes),
        salt_hex: hex::encode(salt),
    };

    serde_json::to_string_pretty(&ks)
        .map_err(|e| format!("JSON serialisation error: {e}"))
}

/// Decrypt a Keystore JSON string with a password and return the private key hex.
#[command]
pub fn unlock_keystore(keystore_json: String, password: String) -> Result<GeneratedKeypair, String> {
    let ks: KeystoreFile = serde_json::from_str(&keystore_json)
        .map_err(|e| format!("keystore JSON parse error: {e}"))?;

    let salt = hex::decode(&ks.salt_hex)
        .map_err(|e| format!("bad salt hex: {e}"))?;
    let nonce_bytes = hex::decode(&ks.nonce_hex)
        .map_err(|e| format!("bad nonce hex: {e}"))?;
    let ciphertext = hex::decode(&ks.ciphertext_hex)
        .map_err(|e| format!("bad ciphertext hex: {e}"))?;

    if nonce_bytes.len() != NONCE_LEN {
        return Err(format!("nonce must be {} bytes, got {}", NONCE_LEN, nonce_bytes.len()));
    }

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, ks.kdf_params.iterations, &mut key);

    let aes = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| format!("cipher init: {e}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);

    let plaintext = aes
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| "Wrong password or corrupted keystore".to_string())?;

    let private_key_hex = String::from_utf8(plaintext)
        .map_err(|_| "decrypted data is not valid UTF-8".to_string())?;

    let kp = KeyPair::from_private_hex(&private_key_hex)?;

    Ok(GeneratedKeypair {
        private_key_hex,
        public_key_hex: kp.public_key_hex(),
        address: kp.address(),
    })
}
