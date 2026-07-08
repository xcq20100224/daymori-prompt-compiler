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
   - `AIPPT_PROVIDER` (`generic` / `openai-compatible` / `openai` / `lazyman`)
   - `AIPPT_API_AUTH_MODE` (`bearer` / `header` / `none`)
   - `AIPPT_API_KEY_HEADER` (used when auth mode is `header`)
   - `AIPPT_API_EXTRA_HEADERS` (JSON object string)

- Windows PowerPoint COM export (optional, OfficePLUS high-fidelity local path):

   - `POWERPOINT_COM_EXPLICIT_ALLOW=true` (mandatory explicit opt-in)
   - `POWERPOINT_STRICT_NO_POPUP=true` (default; hard-disable COM to prevent popup windows)
   - `POWERPOINT_COM_ENABLED=true` (effective only when both `POWERPOINT_COM_EXPLICIT_ALLOW=true` and `POWERPOINT_STRICT_NO_POPUP=false`)
      - `POWERPOINT_COM_PROBE_ENABLED=false` (default; avoid COM runtime probe popup side effects)
    - `POWERPOINT_COM_TIMEOUT_MS=120000`
      - `POWERPOINT_COM_VISIBLE=false` (default hidden, no popup window during export)
         - Set `POWERPOINT_COM_VISIBLE=true` only when you need visual debugging
    - When OfficePLUS template file is present and upstream AIPPT is unavailable,
       backend will try local PowerPoint COM automation first, then fallback to
       local `pptxgenjs` for stability.

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

    - `openai`:
       - Built-in endpoint default: `https://api.openai.com/v1/chat/completions`
       - Built-in auth default: `Bearer <AIPPT_API_KEY>`
       - Same payload/response contract as `openai-compatible`
       - Recommended with fallback enabled (if no valid base64/downloadUrl, server auto-fallback to local `pptxgenjs`)

    - `lazyman`:
       - Uses OpenAI-compatible request/response contract
       - Endpoint can be configured via `LAZYMAN_API_ENDPOINT` (or `AIPPT_API_ENDPOINT`)
       - Auth defaults to `Bearer <AIPPT_API_KEY>` unless you switch to custom header mode

- Quick OpenAI setup:

    - `AIPPT_PROVIDER=openai`
    - `AIPPT_API_KEY=<your_openai_key>`
    - `AIPPT_API_MODEL=gpt-4.1-mini`
    - `AIPPT_API_AUTH_MODE=bearer`

- Quick Lazyman setup:

   - `AIPPT_PROVIDER=lazyman`
   - `LAZYMAN_API_ENDPOINT=<your_lazyman_chat_completions_endpoint>`
   - `AIPPT_API_KEY=<your_lazyman_key>`
   - `AIPPT_API_MODEL=<your_lazyman_model>`
   - `AIPPT_API_AUTH_MODE=bearer` (or `header` + `AIPPT_API_KEY_HEADER` if required by Lazyman)

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

- DeepSeek-only quick export self-check (one command, auto starts local server if needed):

    npm run check:deepseek

   Expected pass signal:
   - `x-ppt-engine: local-pptxgenjs`
   - output file generated at `docs/benchmarks/results/deepseek-selfcheck-export.pptx`

- Real benchmark run (needs `DEEPSEEK_API_KEY`):

   npm run bench:teacher

- Mock run for local verification (no API key required):

   npm run bench:teacher:mock

- Final deliverable 20-case strict regression (final deliverable state scoring):

   npm run bench:final

- PPT layout regression (strict-layout / balanced / strict-content triple run):

   npm run bench:layout

  - Now includes content gate metrics for each exported file:
    - blank slides
    - placeholder-only slides
    - content coverage

- Production SLA benchmark (20 real topics, one-pass/strict leak/speed/manual adjust):

   npm run bench:production

  - Target pass now also requires:
    - blank slides total = 0
    - placeholder-only slides total = 0
    - avg content coverage >= 98%

- Direct PPT quality gate check on any exported files:

   npm run bench:ppt:quality -- <file1.pptx> <file2.pptx>

- Daymori vs Lazyman dashboard (daily board + top2 failure types):

    npm run bench:vs:lazyman

- Lazyman production SLA baseline (same 20 topics, same metric schema):

   npm run bench:production:lazyman

- One-click daily quality cycle (Daymori production SLA + Lazyman SLA + dashboard + Top2 fix list):

   npm run bench:daily

   - API endpoint override:
      - `BENCH_API_BASE=http://localhost:3000 npm run bench:daily`
   - If `localhost:3000` is unreachable and no `BENCH_API_BASE` is provided, script auto boots a temporary local server on `BENCH_SERVER_PORT` (default `3301`).

   - Writes Daymori baseline to:
      - `docs/benchmarks/results/daymori-production-sla-latest.json`
   - Writes Lazyman baseline to:
      - `docs/benchmarks/results/lazyman-production-sla-latest.json`

- Release publish gate (hard block if any SLA gate is false):

   npm run gate:publish

   - API endpoint override:
      - `BENCH_API_BASE=http://localhost:3000 npm run gate:publish`

## Delivery Gate (Dual Gate)

- Any delivery export now requires BOTH gates to pass:
   - Layout gate pass
   - Content gate pass (`blank=0`, `placeholder-only=0`, `coverage>=98%`)
- If any gate fails, API rejects delivery (`409`) with quality diagnostics.
- For publish blocking in operations, run `npm run gate:publish`:
   - Checks `sla.contentGatePass`, `sla.blankSlidesZero`, `sla.placeholderOnlyZero`, `sla.strictLeakSafe`, and other release flags
   - Exits non-zero immediately when any check fails

## Failed-slide Minimal Repair Loop

- On `/api/ppt/export-save`, when first export fails dual gate:
   - Read the generated `.quality.json`
   - Extract `failedSlides`
   - Re-export by rewriting only those pages (`repairSlideIndexes`)
   - Keep passed slides untouched to reduce style drift

## Training Pair Data

- Repair before/after pairs are appended to:
   - `docs/benchmarks/results/training-pairs/YYYY-MM-DD.jsonl`
- Each row stores:
   - failed slide indexes
   - before quality + diagnostics
   - after quality + diagnostics

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
   - `docs/benchmarks/results/layout-regression-latest.json`
   - `docs/benchmarks/reports/layout-regression-latest.md`
   - `docs/benchmarks/results/production-sla-latest.json`
   - `docs/benchmarks/reports/production-sla-latest.md`

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
