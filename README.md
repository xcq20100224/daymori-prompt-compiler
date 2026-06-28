# Minimal GPT Chat Platform

## Fast Permanent URL (GitHub Pages)

If Render/Vercel onboarding blocks you, use GitHub Pages for a fixed URL first.

1. Push this repository to `main` branch (already configured with workflow).
2. In GitHub repository settings, open **Pages**.
3. Under **Build and deployment**, select **GitHub Actions**.
4. Wait for workflow `Deploy GitHub Pages` to finish.
5. Your fixed URL will be:
   - `https://xcq20100224.github.io/daymori-prompt-compiler/`

Update workflow:

- Push to `main`.
- GitHub Actions auto-deploys.
- Refresh the same URL.

Notes:

- Pages version is a static frontend in `docs/index.html`.
- 生产建议走后端代理模式（`/api/llm-proxy`），不要在前端保存 API key。

## Permanent URL (Render)

This project includes `Dockerfile` and `render.yaml` for a stable public URL.

1. Push this folder to your GitHub repository.
2. Open Render dashboard and choose **New + -> Blueprint**.
3. Select your repository and deploy.
4. In environment variables, set:
   - `DEEPSEEK_API_KEY=...`
   - `LLM_PROVIDER=deepseek`
5. After first deploy, Render gives a fixed URL like:
   - `https://daymori-prompt-compiler.onrender.com`

Update workflow:

- Push code updates to the connected branch.
- Render auto-builds and auto-deploys.
- Open the same URL and refresh.

## Permanent URL (Vercel Alternative)

If Render email verification is blocked, use Vercel with GitHub OAuth.

1. Open `https://vercel.com/new`.
2. Import repository `xcq20100224/daymori-prompt-compiler`.
3. In Project Settings -> Environment Variables, set:
   - `LLM_PROVIDER=deepseek`
   - `DEEPSEEK_API_KEY=...`
4. Deploy.

You get a fixed URL like:

- `https://daymori-prompt-compiler.vercel.app`

Update workflow:

- Push code to `main`.
- Vercel auto-deploys.
- Open the same URL and refresh.

## Run

1. Install dependencies:

   npm install

2. Create env file:

   Copy `.env.example` to `.env` and configure provider + key.

   Recommended for users in mainland China:

   - `LLM_PROVIDER=deepseek`
   - Fill `DEEPSEEK_API_KEY=...`
    - Optional but recommended:
       - `ALLOWED_ORIGINS=https://your-domain.com,https://your-backup-domain.com`
       - `AUDIT_LOG_ENABLED=true`
       - `AUDIT_LOG_DIR=./logs`
       - `AUDIT_SALT=your-random-salt`

3. Start:

   npm start

4. Open browser:

   http://localhost:3000

## Notes

- Backend endpoint: `POST /api/chat`
- Secure proxy endpoint for frontend LLM requests: `POST /api/llm-proxy`
- Audit status endpoint: `GET /api/audit/status`
- Multi-provider gateway with provider switch by env:
   - `deepseek` (default)
   - `qwen`
   - `zhipu`
   - `openai`
- Supports drag-and-drop upload (up to 2 files, including `.docx` text extraction).
- Server-side key mode only: frontend never asks users to enter key.
- Optional model override with `LLM_MODEL`.

## AIPPT Export Adapter (Contract JSON -> PPTX)

The app now supports a direct adapter from `aippt.v1` contract JSON to `.pptx` output.

- Backend endpoint:

   - `POST /api/ppt/export`

- Frontend command (after generating a structured PPT contract):

   - `/ppt export`

- Behavior:

   1. Try upstream AIPPT API first (if configured).
   2. If upstream is unavailable, fallback to local PPTX generation (`pptxgenjs`).

- Upstream config (optional):

   - `AIPPT_API_ENDPOINT`
   - `AIPPT_API_KEY`
   - `AIPPT_API_MODEL`
   - `AIPPT_PROVIDER` (`generic` or `openai-compatible`)
   - `AIPPT_API_AUTH_MODE` (`bearer` / `header` / `none`)
   - `AIPPT_API_KEY_HEADER` (used when auth mode is `header`)
   - `AIPPT_API_EXTRA_HEADERS` (JSON object string)

- Provider mapping behavior:

   - `generic`:
     - Request payload: `{ model, contractVersion, contract }`
     - Response payload expects one of: `downloadUrl` or `fileBase64` / `pptxBase64`

   - `openai-compatible`:
     - Request payload: OpenAI-style `chat/completions` (`messages`)
     - Model should return JSON in assistant content with one of:
       - `downloadUrl`
       - `fileBase64` (or `pptxBase64`)
     - Optional fields: `fileName`, `mimeType`

- Response:

   - Returns `.pptx` binary as attachment
   - Header `x-ppt-engine` indicates actual engine (`upstream-aippt-generic`, `upstream-aippt-openai-compatible`, or `local-pptxgenjs`)

## Benchmark Engineering (Run Batch + Daily Report + Failure Attribution)

Teacher benchmark now supports an execution loop upgrade:

- Run batch automatically over `docs/benchmarks/teacher-prompts.json`
- Attribute failures by type (`missing_blocks`, `page_mismatch`, `homework_levels`, `invalid_json`, `api_error`)
- Strategy-based fixer (not block-only rewrite):
   - `schema_rewrite` for structure/schema failures
   - `page_reconcile` for page-count mismatch
   - `homework_layer` for missing layered homework
- Output daily artifacts for dashboard and history:
   - `docs/benchmarks/results/latest-summary.json`
   - `docs/benchmarks/results/latest.json`
   - `docs/benchmarks/results/YYYY-MM-DD.json`
   - `docs/benchmarks/reports/latest.md`
   - `docs/benchmarks/reports/YYYY-MM-DD.md`

### Commands

- Real benchmark run (needs `DEEPSEEK_API_KEY`):

   npm run bench:teacher

- Mock run for local verification (no API key required):

   npm run bench:teacher:mock

- Final deliverable 20-case strict regression (final deliverable state scoring):

   npm run bench:final

- Same run with visible browser (debug):

   npm run bench:final:headed

Notes for final regression:

- Requires Playwright in local environment. If missing, run:

   npm install -D playwright

- Output artifacts:
  - `docs/benchmarks/results/final-deliverable-latest.json`
  - `docs/benchmarks/results/final-deliverable-YYYY-MM-DD.json`
  - `docs/benchmarks/reports/final-deliverable-latest.md`
  - `docs/benchmarks/reports/final-deliverable-YYYY-MM-DD.md`

### CI Automation

Workflow `Benchmark Daily Report` runs daily and can be triggered manually:

- File: `.github/workflows/benchmark-daily.yml`
- Required secret: `DEEPSEEK_API_KEY`
- Auto-commits benchmark artifacts under `docs/benchmarks/results` and `docs/benchmarks/reports`

Because GitHub Pages deploy watches `docs/**`, benchmark report updates are published automatically. After deployment, refresh desktop/mobile page to view the latest benchmark board.

## Security Baseline Checklist

1. Never put API keys in frontend code or browser storage.
2. Configure `ALLOWED_ORIGINS` in production to block untrusted origins.
3. Keep `AUDIT_LOG_ENABLED=true` and rotate files in `AUDIT_LOG_DIR` regularly.
4. Set a private `AUDIT_SALT` to anonymize audit hashes.
