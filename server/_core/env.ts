export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  // JWT_SECRET is the primary session-signing secret; AUTH_SECRET is an accepted
  // fallback (kept consistent with server/_core/auth.ts).
  cookieSecret: process.env.JWT_SECRET ?? process.env.AUTH_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",

  // ── NVIDIA NIM (internal AI Assistant) ──────────────────────────────────────
  // SERVER-SIDE ONLY. Never prefixed with VITE_/NEXT_PUBLIC_/REACT_APP_, so the
  // key is never shipped to the browser bundle. Read from process.env only.
  nvidiaApiKey:  process.env.NVIDIA_API_KEY  ?? "",
  nvidiaBaseUrl: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  nvidiaModel:   process.env.NVIDIA_MODEL    ?? "google/diffusiongemma-26b-a4b-it",
};
