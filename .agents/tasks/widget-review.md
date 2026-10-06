# Floating AI Log Assistant widget reusing the existing single-chat engine

The change extracts the chat logic that lived inline in `pages/Assistant.tsx` into a shared React context (`AssistantChatProvider` + `useAssistantChat`) and a set of presentational components under `components/assistant/`, then consumes those from two surfaces: the refactored full-page `/assistant` route (`variant="page"`) and a new floating widget mounted once in the authenticated `Layout` shell (`variant="floating"`). No backend code is touched: the single `chatApi.ask()` → `POST /chat` path is reused verbatim, the `AIProvider`/`MockAIProvider`/`chatService` abstraction is unchanged, and no new endpoint, RAG machinery, or second provenance system is introduced. Provenance stays honest — the header reads "Powered by MockAIProvider · Phase 1" with a LIVE/MOCK logs `SourceBadge`, never claiming Bedrock.

Watch for: the widget commit `a4073fd` bundles an unrelated diagram-generator change (`scripts/gen-diagram.js`, `OUTPUT/*.png/.svg`, `package.json`) alongside the widget — confirmed, cosmetic to the review but it muddies the changeset. The floating panel is `role="dialog"` without a focus trap, so Tab can leave the panel into background page content — confirmed, minor a11y gap. Neither blocks.

**Verdict**: APPROVED

## High-level view

The chat engine is now a single context provider owning `messages`, `busy`, `error`, `service`, `environment`, and one `send()` that calls `chatApi.ask()`. Both the page and the floating widget read from it, so there is one conversation and one implementation — the duplicate inline logic in `Assistant.tsx` is deleted, not forked. The provider wraps the persistent `Layout`, so the conversation survives navigation and panel close/reopen and tears down on logout.

The hard constraints hold. One canonical API: `chatApi.ask()` → `POST /chat`, and the only `fetch` in the frontend is the pre-existing typed client (`api/client.ts`), unchanged. No `/api/assistant`, `/api/ai/chat`, or `/api/log-chat` anywhere; no RAG/vector/embedding/LangChain/LlamaIndex references; backend and shared packages have an empty diff. Provenance reuses `SourceBadge` and never asserts Bedrock.

The widget is mounted exactly once as a sibling of `.main` inside `Layout`, wrapped by the provider; `/login` sits outside `Layout` in `App.tsx` routing, so authenticated pages get the widget and auth screens never do. The launcher is fixed bottom-right at z-index 60 (above sidebar 40 / scrim 30 / topbar 10), the desktop panel is 400×640 within the required ranges, and the mobile breakpoint switches to the bottom-sheet sizing with left/right/bottom 12px and `calc(100vw - 24px)`.

Accessibility covers the launcher (`aria-label`, `aria-expanded`, `aria-controls`, tooltip), Escape-to-close, focus to the composer on open and back to the launcher on close, an `aria-live="polite"` log, and an accessible close button. The one gap is focus containment: the dialog does not trap Tab. Error handling shows the required generic copy with no internals leaked.

<details>
<summary>Issues (3)</summary>

1. **Unrelated diagram work bundled in the commit** — commit `a4073fd` mixes the diagram generator (`scripts/gen-diagram.js`, `scripts/gen-diagram.test.js`, `OUTPUT/*`, `package.json`) with the widget; split into its own commit so the widget changeset is reviewable in isolation. Non-blocking.
2. **Floating dialog has no focus trap** — the panel is `role="dialog"` but Tab can move focus into background page content behind it; add focus containment (or document the deferral) for full modal a11y. Non-blocking.
3. **`latestProvider` computed but unused in the header** — the hook exposes `latestProvider` yet the panel hardcodes the provider label; harmless today (keeps it honestly MockAIProvider) but dead state to either wire up or drop. Non-blocking.

</details>

<details>
<summary>Details</summary>

### One chat engine, two surfaces

`useAssistantChat.tsx` is the single source of chat behavior. The provider owns the message list, the busy/error flags, the service/environment selection, and the lone `send()` that trims input, applies the duplicate-submit guard (`if (!question || busy) return`), builds the last-8-turn `history`, appends the user turn, calls `chatApi.ask(question, { service, environment, history })`, and appends the assistant turn with `citations`, `source: res.data.logsSource`, and `meta` of `${provider} · ${modelId}`. The behavior matches the deleted inline version in `Assistant.tsx` line-for-line, which is the point — the page now renders `<AssistantPanel variant="page" />` and the floating widget renders `<AssistantPanel variant="floating" />`, both reading the same context. There is no second message list or second send path.

```
          ┌─────────────────────────────┐
          │  AssistantChatProvider      │  (messages, busy, send → chatApi.ask → POST /chat)
          └──────────────┬──────────────┘
                         │ useAssistantChat()
          ┌──────────────┴──────────────┐
          │                             │
   AssistantPanel variant="page"   AssistantPanel variant="floating"
      /assistant route               AssistantWidget (fixed bottom-right)
```

Because the provider wraps `Layout` and `Layout` persists across authenticated route changes (only `<Outlet/>` swaps), the conversation is preserved across navigation and across panel close/reopen, and is discarded on logout when `Layout` unmounts. A message sent from the page appears in the widget and vice versa — one conversation.

### Single API, no forbidden paths

`chatApi.ask` posts to `/chat` (`endpoints.ts:132`), and the backend has exactly one chat route, `apiRoutes.post('/chat', rateLimit(...), ...)` calling `chatService.ask`. A frontend-wide grep for `/api/assistant`, `/api/ai/chat`, `/api/log-chat`, `fetch(`, `langchain`, `llamaindex`, `vectordb`, and `embedding` returns only the pre-existing typed client's `fetch(\`/api${path}\`)` in `api/client.ts` — no new network path, no direct backend call from the assistant code, no RAG. The `AIProvider` contract, `MockAIProvider`, `chatService`, and the shared types are untouched (`git diff origin/main...a4073fd -- packages/backend packages/shared` is empty).

### Honest provenance via reused SourceBadge

The floating header renders `<SourceBadge source={logsSource} note={\`Logs: ${logsSource}\`} />` followed by the literal "Powered by MockAIProvider · Phase 1", where `logsSource = latestLogsSource ?? 'MOCK'` so it shows MOCK until the first answer sets it. `SourceBadge` is the existing component from `components/ui.tsx` (`{ source, note }` signature — the `note` prop is valid). No second provenance system, and no "Bedrock" string anywhere in the widget. Per-message provenance in `AssistantMessage` renders the same `SourceBadge` plus the `provider · modelId` meta line, driven entirely by the API response — citations only render when `citations.length > 0`, so the NO EVIDENCE / NO_ANOMALY_DETECTED answer text passes through verbatim with no fabricated citations.

The hook also exposes `latestProvider`, but the panel hardcodes the "MockAIProvider · Phase 1" label rather than reading it. That keeps the label honest regardless of what the API returns, but it leaves `latestProvider` as unused state — either wire it in (guarded so it can never print Bedrock) or drop it.

### Mounting and route gating

`Layout.tsx` wraps its tree in `<AssistantChatProvider>` and renders `<AssistantWidget />` once as a sibling of the `.main` region. `App.tsx` places `/login` as a sibling route outside `Layout`, so the widget reaches every authenticated page (Dashboard, Alerts, Logs, Metrics, Services, AI Insights, Usage, Audit, Settings) and never the auth screens. Single mount, correct gating.

### Floating layout and responsiveness

The launcher is `position: fixed; bottom: 24px; right: 24px; z-index: 60`, a 56px rounded-square using `--color-primary`/`--color-on-primary` with `--shadow-md`. z-index 60 clears the sidebar (40), scrim (30), and topbar (10), so it won't be occluded or interfere with navigation. The desktop panel is `400px × 640px` with `max-height: calc(100vh - 48px)`, inside the required 380–440 / 560–680 envelope. The `@media (max-width: 900px)` block converts it to a bottom-sheet: `bottom/right/left: 12px`, `width: calc(100vw - 24px)`, `max-width: 440px`, `height: min(680px, calc(100vh - 90px))`. Fixed positioning with `left`/`right` pinned to the viewport avoids horizontal overflow. Visual confirmation (actual browser render, no clipping, Escape/focus behavior on-screen) was not done here and is left to a manual pass, consistent with the verification note — there is no e2e harness in the repo.

### Accessibility and input handling

The launcher carries `aria-label` (toggling Open/Close), `aria-expanded`, `aria-controls={PANEL_ID}`, and a `title` tooltip. Opening moves focus to the composer; Escape and the close button both close and return focus to the launcher. The log is `aria-live="polite"`, the typing indicator has an `aria-label`. `AssistantInput` is a textarea with Enter-to-send, Shift+Enter for newline, disabled while busy, and a send button guarded on `busy || !input.trim()` — the duplicate-submit guard lives in both the input and the hook's `send`.

The gap: the panel is `role="dialog"` but there is no focus trap, so Tab can move into the page content behind the open panel. Escape-close and focus-on-open/return-on-close are implemented, which covers the common keyboard flows, but a true modal would contain Tab. Minor, non-blocking.

### Error handling

A failed `chatApi.ask` sets `error` and appends an assistant bubble with the exact copy "Unable to reach the AI Log Assistant. Please try again." and `isError: true` (styled via the new `.chat-bubble.is-error`). The `catch` discards the error object entirely, so no stack trace, message, env var, key, or AWS/Bedrock detail can leak to the UI. This is stricter than the old page, which interpolated `err.message` into the bubble — a small improvement folded into the refactor.

### Build and test evidence

The coder's `widget-verification.md` records `npm run build` passing (exit 0; `tsc -b` + `vite build`, 861 modules, the >500 kB chunk note is a pre-existing Vite advisory) and `npm test` staying 21/21 on the backend vitest suite, as expected for a frontend-only change. There are no frontend tests configured in the repo, so the type-check is the authoritative automated gate; the SourceBadge prop signature, the IconClose/IconAI exports, and the `/chat` route were spot-checked here and are consistent with a clean compile. Not re-run per the review instructions.

### Unrelated changes in the same commit

`a4073fd` also contains the diagram generator (`scripts/gen-diagram.js` +1297, `scripts/gen-diagram.test.js` +92, regenerated `OUTPUT/*.png/.svg`, and a `package.json` change). None of it touches the widget and it doesn't affect the constraints, but bundling it makes the widget harder to isolate in history. Prefer a separate commit next time.

</details>

<details>
<summary>File map</summary>

Created (frontend widget):
- `components/assistant/useAssistantChat.tsx` — shared context provider + hook; owns state and the one `chatApi.ask()` call.
- `components/assistant/AssistantPanel.tsx` — composes header/log/suggestions/input; `variant="page" | "floating"`.
- `components/assistant/AssistantWidget.tsx` — fixed launcher + dialog, open state, Escape/focus a11y.
- `components/assistant/AssistantMessage.tsx` — one message bubble + citations + provenance (markup extracted verbatim).
- `components/assistant/AssistantInput.tsx` — textarea composer, Enter/Shift+Enter, submit guard.
- `components/assistant/AssistantSuggestions.tsx` — starter-prompt chips routing through `send`.

Modified:
- `components/Layout.tsx` — wrap shell in provider, mount widget once.
- `pages/Assistant.tsx` — refactor to `<AssistantPanel variant="page" />`; delete inline chat logic.
- `components/icons.tsx` — add `IconClose`.
- `components.css` — floating-shell classes + `.chat-bubble.is-error`; reuses existing `.chat-*`.

Unrelated to the widget (bundled in the same commit):
- `scripts/gen-diagram.js`, `scripts/gen-diagram.test.js`, `OUTPUT/*`, `package.json`.

Full diff: `git diff origin/main...a4073fd`.

</details>
