# Verification — Floating AI Log Assistant Widget

## Commands run (from repo root `c:\Antigravity\Urbani DPI`)

- `npm run build` → **PASS** (exit 0). Runs `tsc -b` (type-check) + `vite build` for `@urbani/shared`, `@urbani/backend`, `@urbani/frontend`. Frontend built: 861 modules transformed, `dist/assets/index-*.js` emitted. The ">500 kB chunk" message is a pre-existing Vite advisory, not an error.
- `npm test` → **PASS**. Backend vitest: **21/21 green** (5 test files). No backend regression — expected, since this is a frontend-only change.

## Constraint evidence (grep)

- **Exactly ONE chat API path.** `chatApi.ask()` → `POST /chat`. Only backend chat route is `apiRoutes.post('/chat', …)` in `packages/backend/src/routes/apiRoutes.ts:141`. No `POST /api/assistant`, `/api/ai/chat`, or `/api/log-chat` exist (grep: no matches).
- **No direct backend calls.** grep for `fetch(` in `packages/frontend/src/components/assistant/**` → no matches. The only network call in the assistant code is `chatApi.ask()` in `useAssistantChat.tsx`.
- **Backend untouched.** `git status` shows no changes under `packages/backend/`. `chatService`, `MockAIProvider`, `AIProvider` contract, and shared types are unmodified.
- **No new provenance system.** Reuses `SourceBadge` from `components/ui.tsx`.
- **Never claims Bedrock.** Header renders "Powered by MockAIProvider · Phase 1" + a logs `SourceBadge` (LIVE/MOCK from `res.data.logsSource`). No "Bedrock" string in the widget.

## Behavioral facts

- **Mounted exactly once** in the authenticated shell `components/Layout.tsx` (`<AssistantChatProvider>` wraps the shell, `<AssistantWidget/>` rendered once as a sibling of `.main`).
- **Login does NOT render it.** `/login` is a sibling route outside `Layout` (per `App.tsx` routing), so the widget appears only on authenticated pages.
- **`/assistant` still works**, now reusing the shared `AssistantPanel variant="page"` + `useAssistantChat` hook. One chat implementation feeds both the full page and the floating widget; because both sit inside the same `Layout` provider instance, they share one conversation.
- **Conversation persists** across panel close/reopen and navigation between authenticated pages (state owned by the provider on the persistent shell); torn down on logout when `Layout` unmounts.
- **NO EVIDENCE / NO_ANOMALY_DETECTED** behavior unchanged — citations/answer come straight from the API response; the widget never fabricates citations.
- **API failure** shows "Unable to reach the AI Log Assistant. Please try again." with no stack traces, env vars, keys, or AWS/Bedrock credentials exposed.

## Visual verification

**Static only** — no browser/e2e harness exists in the repo. Correctness of layout (fixed bottom-right launcher, desktop 400×640 panel within the 380-440/560-680 ranges, mobile bottom-sheet `calc(100vw-24px)` / `min(680px, calc(100vh-90px))` at ≤900px, z-index 60 above sidebar 40 / scrim 30 / topbar 10) was verified by reading the CSS tokens and the existing stacking values; it was not confirmed in a live browser. Reviewer should visually confirm positioning, Escape-to-close, focus movement, and absence of horizontal overflow.
