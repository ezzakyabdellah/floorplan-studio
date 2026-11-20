/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Optional browser-development fallback. Tauri builds use the per-user
   * config file instead, so this is never required in production.
   */
  readonly VITE_GEMINI_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
