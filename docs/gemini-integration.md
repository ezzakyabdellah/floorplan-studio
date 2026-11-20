# Google Gemini integration

FloorPlan Studio reads Gemini configuration from a per-user `.env` file managed
by the Tauri backend, then calls the Gemini API directly from the React app with
the official `@google/genai` SDK (browser build). There is no separate backend
server to run.

```
%APPDATA%\com.floorplan.studio\.env
            │
            ▼
  Rust command get_app_env
            │
            ▼
  src/services/appEnv.ts  ──►  src/services/geminiService.ts
                                      │
                                      ▼
                        @google/genai → Gemini API
```

## Config file

On first launch the app creates:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\com.floorplan.studio\.env` |
| macOS | `~/Library/Application Support/com.floorplan.studio/.env` |
| Linux | `~/.config/com.floorplan.studio/.env` |

The file is never overwritten on later launches, so keys survive app updates.

```env
# FloorPlan Studio local configuration.
# Create a free key at https://aistudio.google.com/apikey
GEMINI_API_KEY=
GEMINI_MODEL=gemini-4-hydrogen
GEMINI_FAST_MODEL=gemini-3.5-flash-lite
```

| Key | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Yes | — | Google AI Studio API key |
| `GEMINI_MODEL` | No | `gemini-4-hydrogen` | General tasks / coding |
| `GEMINI_FAST_MODEL` | No | `gemini-3.5-flash-lite` | Fast, lightweight requests |

Real process environment variables take precedence over the file, which is
handy for development and CI. The frontend only calls the two models listed in
the file; other model IDs are rejected.

## Missing-key warning

If `GEMINI_API_KEY` is empty (or still the placeholder from `.env.example`):

- The app shows a dismissible banner on every screen with the full config path.
- The browser console logs:
  ```
  [config] Missing required key(s): GEMINI_API_KEY. Add them to <path> and reload the app.
  ```
- The Rust console logs the same path and missing key names (never the value).
- **Reveal file** opens the file in the OS file explorer.
- **Reload** re-reads the file and recreates the Gemini client, so no app
  restart is needed.
- The rest of the app (drafting, stairs) keeps working. In Auto mode the app
  falls back to Ollama; if you explicitly select Gemini, AI calls fail with
  `NOT_CONFIGURED` until the key is added.

## Provider selection

Every AI feature goes through `src/services/aiProvider.ts`:

- AI assistant: Ask, Audit, and Generate plan
- AI Furnish (furniture layout)
- Stairs design copilot
- Design advisors (structural and cost)
- Workshop notes

The AI assistant has a **Gemini / Local** switch. In Auto mode (the default),
Gemini is used when a key is configured and Ollama is used otherwise. The
choice is stored in `localStorage`. Selecting a provider explicitly is
respected, even if that provider is not currently configured, so the UI can
show a clear error.

Both providers share the same prompts, validation, streaming, retry, and
structured-JSON handling. Gemini structured requests use `responseJsonSchema`;
if a schema is rejected by the API, the provider retries in plain JSON mode and
lets the existing validators reject bad output.

## Using the client

`src/services/geminiService.ts` contains the low-level Gemini client:

```ts
import {
  checkGeminiStatus,
  generateWithGemini,
  GeminiRequestError,
} from "./services/geminiService";

const status = await checkGeminiStatus();
if (status.configured) {
  try {
    const { text } = await generateWithGemini({
      prompt: "Suggest a better furniture layout for this room.",
      model: status.fastModel,
    });
    console.log(text);
  } catch (error) {
    if (error instanceof GeminiRequestError && error.status === 429) {
      console.warn(`Retry in ${error.retryAfterSeconds ?? 30}s`);
    }
  }
}
```

For provider-neutral code, use `generateAiText` / `generateAiJson` from
`src/services/aiProvider.ts`. Plan-aware helpers live in
`src/services/planAiService.ts`:

- `analyzeComplianceWithAI(walls, openings)`
- `askPlanQuestionWithAI(question, walls, openings)`

Both accept an optional `{ model, signal, onChunk }` argument.

## Validation and limits

- `prompt`: required, ≤ 20,000 characters.
- `systemInstruction`: optional, ≤ 8,000 characters.
- `temperature`: `0–2`.
- `maxOutputTokens`: integer `1–32,768`.
- Unknown request fields are rejected.
- Request timeout: 70 seconds. Transient 5xx responses are retried once; 429 is
  surfaced immediately with the retry delay.

## Error mapping

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST`, `INVALID_MODEL` | Bad input or a model not listed in the config file |
| 422 | `CONTENT_BLOCKED` | Safety filters blocked the prompt or answer |
| 429 | `RATE_LIMITED` | Free-tier quota reached; includes `retryAfterSeconds` |
| 502 | `UPSTREAM_AUTH_ERROR` | Gemini rejected the key |
| 502 | `UPSTREAM_UNAVAILABLE` | Network or upstream 5xx failure |
| 502 | `EMPTY_RESPONSE` | Gemini returned no text |
| 503 | `NOT_CONFIGURED` | `GEMINI_API_KEY` is missing |
| 504 | `TIMEOUT` | Gemini did not answer in time |

## Browser development

`npm run dev` runs outside Tauri, so `invoke("get_app_env")` is unavailable.
For browser-only development you can set `VITE_GEMINI_API_KEY` in the project
`.env`; the app will use it and note in the console that this is a dev-only
fallback.

This fallback embeds the key in the browser build. Do not ship a build created
this way.

## Security notes

- The key is **not** compiled into the installer. It lives in each user's own
  config directory, and on Unix is created with `0600` permissions.
- The key **is** read into the React webview at runtime so the SDK can use it.
  It is visible to someone with access to the running app or enabled DevTools.
- Never commit a real `.env`; `.env` and `.env.*` are git-ignored while
  `.env.example` stays in the repository.
- If the key must never reach the webview, move the API call into Rust instead.

## Why the direct SDK instead of LangChain

This app uses one model provider with highly domain-specific prompts, strict
JSON validators, bounded repair loops, and deterministic fallbacks. The direct
`@google/genai` SDK gives full control over those pieces without another
abstraction layer.

LangChain is useful when you need multi-provider routing, chains/agents, RAG,
memory, or tool orchestration. It would not remove the validation and prompt
code here, and it adds a large dependency plus its own release churn. If the
project later needs agentic workflows across several providers, LangChain (or
its Google integration) can be evaluated then; it wraps the same underlying
API.

## Verification

```bash
npm test
npm run build
cd src-tauri && cargo test
```

Manual check with `npm run tauri dev`:

1. Confirm the config file is created at the logged path.
2. Confirm the banner and console warning appear.
3. Add a key, choose **Reload**, and confirm the banner disappears.
4. Run a Gemini helper and confirm a real response.
5. Replace the key with an invalid value and confirm a clear auth error.
