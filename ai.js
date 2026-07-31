/* Cloudflare Workers AI, over the REST API.
 *
 * This is the ONLY part of the app that talks to Cloudflare. There is no
 * Worker, no D1, no KV — the server and the chat database run locally, and
 * Cloudflare is just where the model runs. Requests are billed to the account
 * that owns CLOUDFLARE_API_TOKEN.
 *
 * Docs: https://developers.cloudflare.com/workers-ai/get-started/rest-api/
 */

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

// Llama 3.3 70B: a non-reasoning instruct model that follows a long behavioral
// system prompt closely — which is exactly what the kid-safety rules in
// prompt.js depend on. The "fp8-fast" variant keeps replies quick enough that a
// 6-year-old doesn't lose interest. Context size is not a concern here: the
// prompt is small and history is capped at MAX_TURNS.
const MODEL = process.env.KIDS_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// Answers are meant to be a few sentences (see the prompt), so this cap is a
// backstop against a runaway generation, not a normal limit.
export const MAX_OUTPUT_TOKENS = 1024;

export function isConfigured() {
  return Boolean(ACCOUNT_ID && API_TOKEN);
}

export function modelName() {
  return MODEL;
}

/** True when the model produced no usable text and the error is worth showing.
 *  Everything user-facing is phrased for a child to read. */
export class AIError extends Error {}

/**
 * Stream a reply from Workers AI, calling `onDelta(text)` for each chunk.
 * Resolves with the full reply text once the stream ends.
 *
 * @param {{role: "user"|"assistant", content: string}[]} messages
 * @param {string} system
 * @param {(text: string) => void} onDelta
 * @param {AbortSignal} [signal]
 */
export async function streamReply({ messages, system, onDelta, signal }) {
  if (!isConfigured()) {
    throw new AIError(
      "The chatbot isn't set up yet — CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are missing."
    );
  }

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ role: "system", content: system }, ...messages],
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: true,
      }),
      signal,
    }
  );

  if (!res.ok) {
    // Cloudflare returns its error detail as JSON even on a streaming endpoint.
    const detail = await res.text().catch(() => "");
    console.error(`workers-ai ${res.status}: ${detail.slice(0, 500)}`);
    if (res.status === 401 || res.status === 403) {
      throw new AIError(
        "I can't reach my brain right now — the Cloudflare API token looks wrong."
      );
    }
    if (res.status === 429) {
      throw new AIError("Whoa, I'm a bit busy! Try asking me again in a moment.");
    }
    throw new AIError("Oops, something went wrong. Can you ask me again?");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; the last piece may be partial.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const delta = parseDelta(frame);
      if (delta) {
        full += delta;
        onDelta(delta);
      }
    }
  }

  return full;
}

/** Pull the text out of one Workers AI SSE frame. Models on the platform emit a
 *  few different shapes, so tolerate all of them rather than pinning to one. */
function parseDelta(frame) {
  const line = frame.split("\n").find((l) => l.startsWith("data: "));
  if (!line) return null;
  const payload = line.slice(6).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    const obj = JSON.parse(payload);
    if (typeof obj.response === "string") return obj.response;
    const chatDelta = obj.choices?.[0]?.delta?.content;
    if (typeof chatDelta === "string") return chatDelta;
  } catch {
    /* ignore malformed frames */
  }
  return null;
}
