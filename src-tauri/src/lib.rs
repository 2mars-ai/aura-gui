// src-tauri/src/lib.rs — AuraCore Desktop GUI backend

mod node;
mod wallet;
mod crypto;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Initialise shared node state
            app.manage(node::NodeState::new());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Node commands
            node::start_node,
            node::stop_node,
            node::get_node_status,
            // Wallet / crypto commands
            wallet::generate_keypair,
            wallet::derive_address,
            wallet::sign_transaction,
            wallet::create_keystore,
            wallet::unlock_keystore,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
