import "dotenv/config";

// Verifies the NVIDIA API key/connectivity from the server environment BEFORE
// building the full AI Assistant. Run with:  pnpm test:nvidia
// It reads NVIDIA_API_KEY from process.env (.env locally) and never prints it.
const { testNvidiaConnection } = await import("../server/_core/nvidia");

const result = await testNvidiaConnection();

console.log(`[NVIDIA] ${result.ok ? "✓ OK" : "✗ FAILED"} — ${result.message}`);
if (result.model) console.log(`[NVIDIA] model: ${result.model}`);
if (result.sample) console.log(`[NVIDIA] sample: ${result.sample}`);

process.exit(result.ok ? 0 : 1);
