import { ENV } from "./env";

/**
 * NVIDIA NIM Chat Completions client (server-side only).
 *
 * SECURITY INVARIANTS:
 *   - NVIDIA_API_KEY is read from process.env (via ENV) only. It is sent solely
 *     in the Authorization header and is NEVER returned to callers, included in
 *     responses, or written to any log.
 *   - All NVIDIA traffic originates here on the backend; the browser never calls
 *     NVIDIA directly and never receives the key.
 */

// Exact message required when the key is missing — safe to surface to clients.
export const NVIDIA_NOT_CONFIGURED_MESSAGE =
  "NVIDIA API key is not configured on the server.";

// Friendly fallback shown to users when the upstream call fails for any reason.
export const NVIDIA_UNAVAILABLE_MESSAGE =
  "AI analysis is temporarily unavailable. Please try again later.";

export type NvidiaChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type NvidiaChatOptions = {
  messages: NvidiaChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** Abort the request after this many ms (default 30s). */
  timeoutMs?: number;
};

export type NvidiaChatResult = {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

/** True when a non-empty NVIDIA_API_KEY is present in the server environment. */
export function isNvidiaConfigured(): boolean {
  return ENV.nvidiaApiKey.trim().length > 0;
}

/**
 * Validation guard — call BEFORE attempting any NVIDIA request. Throws with the
 * exact safe message (no key material) when the key is absent.
 */
export function assertNvidiaConfigured(): void {
  if (!isNvidiaConfigured()) {
    throw new Error(NVIDIA_NOT_CONFIGURED_MESSAGE);
  }
}

/**
 * Low-level call to NVIDIA's Chat Completions endpoint. Non-streaming.
 * Reasoning/"thinking" is disabled so only the final answer is returned.
 * The API key appears only in the Authorization header; errors never include it.
 */
export async function callNvidiaChat(opts: NvidiaChatOptions): Promise<NvidiaChatResult> {
  assertNvidiaConfigured();

  const base = ENV.nvidiaBaseUrl.replace(/\/+$/, "");
  const url = `${base}/chat/completions`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // Key used ONLY here, never logged or returned.
        authorization: `Bearer ${ENV.nvidiaApiKey}`,
      },
      body: JSON.stringify({
        model: ENV.nvidiaModel,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.2,
        top_p: opts.topP ?? 0.95,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Surface status + a truncated provider message for diagnostics — but the
      // request body/headers (and therefore the key) are never echoed here.
      const detail = await response.text().catch(() => "");
      throw new Error(`NVIDIA API error ${response.status}: ${detail.slice(0, 500)}`);
    }

    const data: any = await response.json();
    const content: string = data?.choices?.[0]?.message?.content ?? "";
    return { content, model: data?.model ?? ENV.nvidiaModel, usage: data?.usage };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lightweight connectivity check used by the admin-only test route/script. Sends
 * a trivial prompt and reports success/failure WITHOUT exposing the API key.
 * Returns a structured result rather than throwing, so the route can relay a
 * clean status to the admin.
 */
export async function testNvidiaConnection(): Promise<{
  ok: boolean;
  message: string;
  model?: string;
  sample?: string;
}> {
  if (!isNvidiaConfigured()) {
    return { ok: false, message: NVIDIA_NOT_CONFIGURED_MESSAGE };
  }
  try {
    const result = await callNvidiaChat({
      messages: [
        { role: "system", content: "You are a connectivity test. Reply with one short sentence." },
        { role: "user", content: "Reply with exactly: NVIDIA connection OK." },
      ],
      maxTokens: 32,
      timeoutMs: 20_000,
    });
    return {
      ok: true,
      message: "NVIDIA API reachable.",
      model: result.model,
      sample: result.content.slice(0, 200),
    };
  } catch {
    // Never leak the underlying error/key to the caller.
    return { ok: false, message: NVIDIA_UNAVAILABLE_MESSAGE };
  }
}
