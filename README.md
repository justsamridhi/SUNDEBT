# SUNDEBT

SUNDEBT is a behavioral screen-time economy: users earn screen time by choosing to spend time outdoors. It is not a sunlight tracker, a medical device, or a system-wide app blocker.

## Architecture

- **Frontend:** React, TypeScript, and Vite PWA in `frontend/`. The existing browser-local wallet remains the source of truth for Sun Debt, Sun Minutes, Sol XP, and session history.
- **API:** A small Express service in `backend/` validates mission and session requests. It has no accounts, database, or server-side wallet.
- **Sol (Mastra):** A Mastra agent uses an Ollama-hosted open-weight model to propose a mission, a suggested duration, and short motivation from the user's wallet totals, recent sessions, local time, and optional context. No weather provider is configured. The validated deterministic fallback works without Ollama or the API.
- **Durable sessions (Temporal):** The API starts a `sunSessionWorkflow`; a separate worker records the Sun Check, phone-down, outdoor-session, interruption/resume, completion, and reward stages as Temporal history. The reward activity applies the existing 90-minute daily cap, 100-step bonus, debt-first repayment, and 2 XP per earned minute. The frontend applies the same reward immediately to its local wallet; the workflow result is a durable session record, not a server-side wallet.
- **Offline boundaries:** If the API or Temporal is unavailable, the session and local reward still work in the browser. AI failure returns deterministic guidance. A lost API connection can prevent later workflow events from being recorded; this is shown as a local-session warning rather than blocking the user.

## Requirements

- Node.js 22.13 or later and npm.
- [Ollama](https://ollama.com/) is optional for AI guidance. Install it and pull the default model to enable local inference:

  ```sh
  ollama pull qwen3:4b
  ```

- [Temporal CLI](https://docs.temporal.io/cli) is optional for durable workflow execution. It runs locally without a database container:

  ```sh
  temporal server start-dev
  ```

## Local setup

Install frontend and backend dependencies from their respective directories:

```sh
cd frontend
npm install
cd ../backend
npm install
```

Create `backend/.env` from `backend/.env.example` and adjust values as needed (in PowerShell: `Copy-Item backend\.env.example backend\.env`). In separate terminals, run:

```sh
cd backend
npm run dev
```

```sh
cd backend
npm run dev:worker
```

For durable workflows, keep the Temporal development server running as well. The API and worker both connect to it. The PWA is served independently:

```sh
cd frontend
npm run dev
```

If Ollama is not installed or the model is unavailable, Sol uses a deterministic mission. If the Temporal server, API, or network is unavailable, the frontend continues with its browser-local wallet and reports that the session is local-only.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | Backend HTTP port |
| `CORS_ORIGIN` | `http://localhost:5173` in `.env.example` | Comma-separated allowed browser origins; omit to allow any origin for local development |
| `OLLAMA_BASE_URL` | `http://localhost:11434/api` | Ollama API base URL |
| `OLLAMA_MODEL` | `qwen3:4b` | Local Ollama model used by Mastra |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal frontend address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_TASK_QUEUE` | `sundebt-sun-sessions` | Queue polled by the SUNDEBT worker |
| `VITE_API_BASE_URL` | `http://localhost:8787` | Optional frontend API base URL, set in the frontend environment when using another host |

The backend exposes `GET /api/health`, `POST /api/sol/mission`, `POST /api/sessions/start`, `POST /api/sessions/:id/events`, `POST /api/sessions/:id/complete`, and `GET /api/sessions/:id`.

## Session workflow

1. The frontend requests Sol guidance and starts a Temporal workflow when possible.
2. Sun Check sends available camera/light readings as optional evidence. These readings never prove outdoor presence or health outcomes.
3. Starting the timer records phone-down and outdoor-session stages.
4. The user can explicitly pause and resume; paused time is excluded from the local session duration and the workflow receives interruption/resume signals.
5. Completion sends duration, supported step estimate, current daily earnings, and Sun Debt to a reward activity. The frontend applies the same deterministic reward locally without waiting for the backend.

Temporal persists workflow state and event history, not identity or a cross-device wallet. If the API is unreachable while a workflow is in progress, local session completion remains available, but missed workflow signals are not retroactively reconstructed.

## Real-world reliability and privacy

- Camera, motion, orientation, and ambient-light capabilities depend on the browser, secure context, device, and user permission. Unsupported or denied sensors are treated as unavailable; none is required to finish a session.
- Step counts are estimates, and camera/ambient-light readings are only optional environmental context. SUNDEBT does not claim to verify outdoor presence or measure Vitamin D.
- Screen visibility tracking is informational. The web Scroll Gate adds friction before opening a site; it cannot block other installed apps or enforce time spent there.
- No authentication, database, analytics, or third-party weather service is included. Session history and the wallet remain in browser storage.
- Production deployments should explicitly configure `CORS_ORIGIN`, use HTTPS, and run the API, Temporal service, and worker with appropriate operational controls.

## Checks

```sh
cd backend
npm run typecheck
npm test
npm run build
cd ../frontend
npm run build
```
