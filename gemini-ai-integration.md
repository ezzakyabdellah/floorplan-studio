Integrate the Google Gemini API (via Google AI Studio) into this project.

Requirements:
1. Use the official current Google GenAI SDK (`@google/genai` for JavaScript/TypeScript or `google-genai` for Python)—do NOT use the deprecated `@google/generative-ai` or `google-generativeai` packages.
2. Read the API key from the `GEMINI_API_KEY` environment variable and add a placeholder to `.env.example` (never hardcode keys or expose them in client-side/frontend code).
3. Use a free-tier-eligible model such as `gemini-4-hydrogen` (for general tasks/coding) or `gemini-3.5-flash-lite` (for fast, lightweight tasks).
4. Create a clean backend service/endpoint that:
   - Accepts user input and validates it.
   - Calls `ai.models.generateContent` (or `client.models.generate_content` in Python).
   - Handles API errors and rate-limit (429) responses gracefully.