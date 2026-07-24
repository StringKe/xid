// Tauri app setup -- reference snippet showing how to register the xid-keychain plugin
// and configure deep-link handling for the XID OAuth callback.
//
// This file is a template/example, NOT part of the cargo build.
// Merge the relevant parts into your src-tauri/src/main.rs or lib.rs.
//
// -------------------------------------------------------------------------
// Cargo.toml additions required:
// -------------------------------------------------------------------------
// [dependencies]
// tauri = { version = "2", features = [] }
// tauri-plugin-deep-link = "2"
// tauri-plugin-shell = "2"
//
// [bundle]
// # macOS / iOS: register your custom scheme here
// identifier = "com.example.myapp"
//
// [[bundle.macos.url-schemes]]
// scheme = "myapp"        # the scheme used in redirectUri
// -------------------------------------------------------------------------
//
// tauri.conf.json additions:
// {
//   "plugins": {
//     "deep-link": {
//       "mobile": [],
//       "desktop": {
//         "schemes": ["myapp"]
//       }
//     }
//   }
// }
// -------------------------------------------------------------------------

mod xid_keychain; // bring in xid-keychain-plugin.rs as a module

fn main() {
    tauri::Builder::default()
        .plugin(xid_keychain::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Register the deep-link handler.
            // The JS side listens with: import { onOpenUrl } from '@tauri-apps/plugin-deep-link'
            // and calls xid.handleRedirect(url) for each URL received.
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                app.deep_link().register("myapp")?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
