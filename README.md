# Minimal GPT Chat Platform

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

3. Start:

   npm start

4. Open browser:

   http://localhost:3000

## Notes

- Backend endpoint: `POST /api/chat`
- Multi-provider gateway with provider switch by env:
   - `deepseek` (default)
   - `qwen`
   - `zhipu`
   - `openai`
- Supports drag-and-drop upload (up to 2 files, including `.docx` text extraction).
- Server-side key mode only: frontend never asks users to enter key.
- Optional model override with `LLM_MODEL`.
