// src-tauri/src/crypto.rs
// Ed25519 key generation and address derivation — mirrors AuraCore logic exactly.
//
// Address format: "aura1" + hex(SHA-256(pubkey_bytes)[0..20])
// Signing payload: "{from}:{to}:{amount:.8}:{fee:.8}:{nonce}:{timestamp}"

use ed25519_dalek::{SigningKey, VerifyingKey, Signer};
use rand::rngs::OsRng;
use sha2::{Sha256, Digest};

pub struct KeyPair {
    pub signing_key: SigningKey,
    pub verifying_key: VerifyingKey,
}

impl KeyPair {
    /// Generate a fresh Ed25519 keypair using OS CSPRNG.
    pub fn generate() -> Self {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        Self { signing_key, verifying_key }
    }

    /// Restore from 32-byte private key encoded as 64 lowercase hex chars.
    pub fn from_private_hex(hex_str: &str) -> Result<Self, String> {
        let bytes = hex::decode(hex_str)
            .map_err(|e| format!("invalid hex: {e}"))?;
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| "private key must be exactly 32 bytes".to_string())?;
        let signing_key = SigningKey::from_bytes(&arr);
        let verifying_key = signing_key.verifying_key();
        Ok(Self { signing_key, verifying_key })
    }

    pub fn private_key_hex(&self) -> String {
        hex::encode(self.signing_key.to_bytes())
    }

    pub fn public_key_hex(&self) -> String {
        hex::encode(self.verifying_key.to_bytes())
    }

    pub fn address(&self) -> String {
        derive_address(&self.verifying_key)
    }

    /// Sign a UTF-8 message; returns 128-char hex-encoded 64-byte signature.
    pub fn sign(&self, message: &str) -> String {
        let sig = self.signing_key.sign(message.as_bytes());
        hex::encode(sig.to_bytes())
    }
}

/// Derive canonical aura1 address from a VerifyingKey.
pub fn derive_address(verifying_key: &VerifyingKey) -> String {
    let mut hasher = Sha256::new();
    hasher.update(verifying_key.to_bytes());
    let digest = hasher.finalize();
    format!("aura1{}", hex::encode(&digest[..20]))
}

/// Build the canonical signing payload for a transfer transaction.
/// Format: "{from}:{to}:{amount:.8}:{fee:.8}:{nonce}:{timestamp}"
pub fn build_signing_payload(
    from: &str,
    to: &str,
    amount: f64,
    fee: f64,
    nonce: u64,
    timestamp: u64,
) -> String {
    format!("{from}:{to}:{amount:.8}:{fee:.8}:{nonce}:{timestamp}")
}
