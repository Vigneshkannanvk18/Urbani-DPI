# Implementation Plan — Floating AI Log Assistant Widget

Frontend-only refactor of the existing Urbani DPI chat experience into a reusable, floating AI Log Assistant widget mounted once in the authenticated shell. The backend, the typed API client, the `AIProvider`/`MockAIProvider` abstraction, and the single `POST /api/chat` endpoint are **not touched**.

## Grounding (verified by reading the code)

- **One canonical API already exists** and is reused untouched: `chatApi.ask(question, { service, environment, history })` → `POST /chat` returning `Sourced<ChatAnswer>`. Declared in `packages/frontend/src/api/endpoints.ts`. Types `ChatTurn` and `ChatAnswer` (fields: `answer`, `citations: string[]`, `provider`, `modelId`, `service`, `environment`, `logsSource`, `inputTokens`, `outputTokens`) live in the same file and are reused as-is.
- **The chat implementation to EXTRACT (not rewrite)** is `packages/frontend/src/pages/Assistant.tsx`: it holds `messages`/`input`/`busy` state, builds last-8-turn `history`, calls `chatApi.ask`, renders user/assistant bubbles, citations, typing indicator, suggestion chips, and provenance via `SourceBadge` + a `provider · modelId` meta line. It passes `source="MOCK"` with the honest note "Answers via MockAIProvider in Phase 1; Bedrock later with no UI change." The per-message `SourceBadge` reflects `res.data.logsSource` (LIVE/MOCK). This behavior is the source of truth to preserve.
- **Single mount point**: `packages/frontend/src/components/Layout.tsx` is the only authenticated shell. In `App.tsx` it is rendered inside `<RequireAuth>` and renders `<Outlet/>` for every authenticated page; `/login` is a sibling route outside it. The `Layout` component instance persists across authenticated route changes (only `<Outlet/>` swaps), so state owned at/above `Layout` survives navigation. Mounting the widget in `Layout` gives it to all authenticated pages and never to Login.
- **Design system to reuse**: brand `--color-primary: #d1990a` and the full token set in `packages/frontend/src/styles.css`; existing chat CSS classes (`.chat-panel`, `.chat-log`, `.chat-msg`, `.chat-bubble`, `.chat-avatar`, `.chat-citations .cite`, `.chat-input-row`, `.chat-suggestions`, `.chat-chip`, `.chat-meta`, `.typing-dot`) in `packages/frontend/src/components.css`. `SourceBadge` and `Button` from `packages/frontend/src/components/ui.tsx`. `IconAI` from `packages/frontend/src/components/icons.tsx`. Sidebar mobile overlay uses `z-index: 40`, topbar `z-index: 10`, scrim `z-index: 30` — the floating widget must sit above these (use `z-index: 60`).

## Design decisions (made here, grounded in the above)

1. **Shared state = React Context provider** (`AssistantChatProvider` exposing a `useAssistantChat()` hook). Rationale: conversation must persist across navigation and across close/reopen within a session. A context provider mounted so it wraps `Layout` (which itself persists across authenticated routes) keeps one message list alive for the whole authenticated session without module-global singletons, and it is torn down naturally on logout when `Layout` unmounts. Chosen over per-page state (the user explicitly rejected that) and over module-level state (would leak across logout/login of a different user in the same tab).
2. **One chat engine hook** (`useAssistantChat`) owns `messages`, `busy`, `error`, `service`, `environment`, and `send()`. BOTH the floating widget and the refactored `/assistant` page consume it, so there is exactly one chat implementation. Rationale: the user requires a single source of chat behavior feeding both surfaces.
3. **Service/environment selection stays on the full page only.** The full `/assistant` page keeps its service/environment `Select`s (now driving the shared hook's state). The floating widget uses the shared hook's current `service`/`environment` (defaults `urbani-app` / `production-eb`, matching today's defaults) without duplicating the selectors, keeping the compact widget uncluttered. Rationale: minimal surface, no behavior regression on the page.
4. **Reuse existing chat CSS; add only floating-shell CSS.** New `.assistant-*` classes (launcher button, panel, header, body wrapper) are added to `components.css`; message/citation/chip/input styling reuses the existing `.chat-*` classes. Rationale: no second visual language; matches the user's "reuse the design system" constraint.
5. **No new API, no backend edits, no provenance system.** `chatApi.ask` and `SourceBadge` are reused verbatim. Honest provenance only: header shows provider from the latest answer (or "MockAIProvider · Phase 1" before the first answer) and a `SourceBadge` for `logsSource`; never claims Bedrock.

## Verification note

`npm test` at the repo root runs the **backend** vitest suite only (21 tests); there are **no frontend tests** configured (confirmed in root `package.json` and project-status report). This task is frontend-only, so the authoritative verification is **`npm run build`** at the repo root, which runs `tsc -b` (type-check) + `vite build` for `@urbani/frontend` and will fail on any type error or broken import. `npm test` is still run to confirm no backend regression (it must stay 21/21). Manual UI behaviors (floating position, Escape-to-close, focus, mobile sizing) are listed per step as reviewer checks since no e2e harness exists.

---

# Implementation Plan

- [ ] 1. Create the shared chat engine: `useAssistantChat` hook + `AssistantChatProvider` context.
      Define a `Message` type (role, content, optional citations, meta, source) and move the chat logic out of `Assistant.tsx` into a provider that owns `messages`, `busy`, `error`, `service`, `environment`, and a `send(text)` function. `send` must replicate the current page behavior exactly: trim + ignore empty/while-busy (duplicate-submit guard), build `history` from the last 8 user/assistant turns, append the user message, call `chatApi.ask(question, { service, environment, history })`, append the assistant message with `citations`, `source: res.data.logsSource`, and `meta: \`${res.data.provider} · ${res.data.modelId}\``. On failure, append an assistant message using the required copy "Unable to reach the AI Log Assistant. Please try again." and set `error`. Seed the same initial greeting message currently in `Assistant.tsx`. Expose `service`/`setService`/`environment`/`setEnvironment`. Also expose a `latestLogsSource`/`latestProvider` derived value for the widget header.
      Files: create `packages/frontend/src/components/assistant/useAssistantChat.tsx` (hook + `AssistantChatProvider` + `useAssistantChat` consumer; `.tsx` because it returns a provider element).
      Reuse: `chatApi`, `ChatTurn`, `ChatAnswer` from `../../api/endpoints`.
      Verify: `npm run build` at repo root — frontend type-checks and builds (hook compiles, no unused/implicit-any errors). Not yet wired to UI, so build is the check.

- [ ] 2. Create `AssistantMessage` to render one message (user/assistant/citations/provenance/error), extracting the exact markup from `Assistant.tsx`.
      Render the `.chat-msg`/`.chat-avatar`/`.chat-bubble` structure, `IconAI` avatar for assistant and "You" for user, the `.chat-citations .cite` list when citations exist, and the `.chat-meta` line with `<SourceBadge source={m.source} />` + `m.meta` when meta exists. Preserve the NO EVIDENCE / NO_ANOMALY_DETECTED text exactly as returned by the API (no fabricated citations — only render citations the response provided). Error messages render as a normal assistant bubble (optionally add an `is-error` class for styling).
      Files: create `packages/frontend/src/components/assistant/AssistantMessage.tsx`.
      Reuse: `SourceBadge` from `../ui`, `IconAI` from `../icons`, existing `.chat-*` CSS.
      Verify: `npm run build` at repo root — compiles and builds.

- [ ] 3. Create `AssistantInput` (textarea + send) with keyboard handling and `AssistantSuggestions` (chips).
      `AssistantInput`: a `<textarea class="input">` with Enter-to-send, Shift+Enter for newline, disabled while `busy`, send button disabled when `busy` or input is blank (duplicate-submit guard), `aria-label` on the field. `AssistantSuggestions`: render the recommended prompts as `.chat-chip` buttons (reuse the existing suggestion list, extended to include "Show recent warnings" and "What is the most suspicious log?" per the request), each calling `send` and disabled while `busy`.
      Files: create `packages/frontend/src/components/assistant/AssistantInput.tsx` and `packages/frontend/src/components/assistant/AssistantSuggestions.tsx`.
      Reuse: `Button` from `../ui`, existing `.chat-input-row`/`.chat-suggestions`/`.chat-chip` CSS.
      Verify: `npm run build` at repo root — compiles and builds.

- [ ] 4. Create `AssistantPanel` composing header + message list + suggestions + input from the shared hook.
      Header: title "AI Log Assistant", an honest status line — a `<SourceBadge source={latestLogsSource ?? 'MOCK'} />` labelled for logs (LIVE/MOCK) plus the text "Powered by MockAIProvider · Phase 1" (provider taken from the latest answer when available; never "Bedrock"). Body: scrollable `.chat-log` with `aria-live="polite"` auto-scrolling to newest message and showing the typing indicator while `busy`. Accept a `variant` prop (`'page' | 'floating'`) and an optional `onClose` so the floating header can show an accessible close button; render service/environment selectors only when `variant === 'page'`. The panel reads everything from `useAssistantChat()` — no local chat state.
      Files: create `packages/frontend/src/components/assistant/AssistantPanel.tsx`.
      Reuse: `SourceBadge`, `Button`, `IconAI`, items from steps 2-3, the hook from step 1.
      Verify: `npm run build` at repo root — compiles and builds.

- [ ] 5. Create `AssistantWidget` (floating launcher + panel) with full a11y and responsive behavior.
      Closed state: fixed rounded-square/circular button at bottom:24px/right:24px, `IconAI`, subtle shadow, high z-index, `aria-label="Open AI Log Assistant"`, `aria-expanded`, `aria-controls` pointing at the panel id, accessible tooltip (title). Open state: render `AssistantPanel variant="floating"` inside a fixed container sized desktop 400px × 640px (within the 380-440 / 560-680 ranges) and mobile `width: calc(100vw - 24px)`, `max-width: 440px`, `height: min(680px, calc(100vh - 90px))`, offsets bottom/right/left 12px. Escape closes the panel; move focus to the input on open and back to the launcher on close; close button in the panel header is keyboard-reachable. Must not create horizontal overflow and must sit above the sidebar/scrim (z-index 60). Open/closed is local UI state in the widget; the conversation lives in the shared provider so it persists across open/close and navigation. Do NOT render provider/model as Bedrock.
      Files: create `packages/frontend/src/components/assistant/AssistantWidget.tsx`.
      Reuse: `AssistantPanel` (step 4), `IconAI`, `useAssistantChat`.
      Verify: `npm run build` at repo root — compiles and builds. Reviewer manual checks: launcher fixed bottom-right, panel opens within viewport on desktop and mobile widths, Escape closes, focus moves correctly, no horizontal scrollbar introduced.

- [ ] 6. Add floating-shell CSS for the widget (reusing existing chat classes for message/input styling).
      Add `.assistant-launcher` (fixed bottom:24px right:24px, size ~56px, `--radius-lg`/pill, `--color-primary` background, `--color-on-primary` icon, `--shadow-md`, `z-index: 60`, focus-visible ring), `.assistant-fab-badge` (optional status dot), `.assistant-panel` (fixed container with the desktop/mobile dimensions from step 5, `--color-surface` bg, `--color-border`, `--shadow-md`, `--radius-lg`, flex column, `z-index: 60`), `.assistant-panel-header` (brand-tinted header row with title + status + close), and the mobile `@media (max-width: 900px)` overrides (bottom/right/left 12px, `calc(100vw - 24px)`, `max-width: 440px`, `min(680px, calc(100vh - 90px))`). Inside the panel, reuse the existing `.chat-*` classes. Add an `.assistant-panel .chat-panel { height: 100% }`-style override so the reused chat body fills the floating panel instead of the page-height calc.
      Files: modify `packages/frontend/src/components.css`.
      Verify: `npm run build` at repo root — frontend builds with the new CSS; reviewer confirms the panel fills correctly and nothing clips.

- [ ] 7. Mount the provider + widget once in the authenticated shell.
      Wrap `Layout`'s rendered tree in `AssistantChatProvider` so the conversation state is owned by the persistent shell (survives route changes and panel close/open; torn down on logout when `Layout` unmounts). Render `<AssistantWidget/>` once as a sibling of `.main` inside `.app-shell` (fixed-positioned, so it is outside sidebar/content flow and appears on every authenticated page but never on Login, which is outside `Layout`).
      Files: modify `packages/frontend/src/components/Layout.tsx`.
      Reuse: `AssistantChatProvider`, `AssistantWidget`.
      Verify: `npm run build` at repo root — builds. Reviewer manual checks: widget visible on Dashboard/Alerts/Logs/etc., absent on `/login`, conversation preserved when navigating between pages and when closing/reopening the panel.

- [ ] 8. Refactor the `/assistant` page to consume the shared components/hook (one implementation feeding both surfaces).
      Replace the inline chat state and markup in `Assistant.tsx` with `AssistantPanel variant="page"` reading from `useAssistantChat()`. Keep the `PageHeader` (title "AI Log Assistant", `source="MOCK"`, the existing honest note) and keep the service/environment selectors wired to the shared hook's `setService`/`setEnvironment`. The `/assistant` route must look and behave as before. Because the page sits inside `Layout`, it shares the same provider instance as the widget — so there is one conversation. The `services` list fetch (`servicesApi.list()`) stays on the page to populate the selectors.
      Files: modify `packages/frontend/src/pages/Assistant.tsx`.
      Reuse: `AssistantPanel`, `useAssistantChat`, `PageHeader`, `Select`, `servicesApi`.
      Verify: `npm run build` at repo root — builds clean. Reviewer manual checks: `/assistant` renders the chat full-page, send works, citations/provenance show, service/environment selection still works, and a message sent on the page also appears in the floating widget (shared state).

- [ ] 9. Full verification pass and cleanup.
      Confirm no `fetch` was introduced (all calls go through `chatApi`), no new endpoint added, `chatService`/`MockAIProvider`/`AIProvider` and the shared types are untouched, no secrets referenced in the frontend, the NO EVIDENCE / NO_ANOMALY_DETECTED behavior is unchanged (driven entirely by the API response), and the UI never claims Bedrock.
      Files: none (verification only).
      Verify: run `npm run build` and `npm test` at repo root (`c:\Antigravity\Urbani DPI`). Expected: build exits 0 for shared+backend+frontend; `npm test` stays 21/21 green (backend unchanged). Reviewer confirms the HARD CONSTRAINTS checklist above holds.

## Files summary

Create:
- `packages/frontend/src/components/assistant/useAssistantChat.tsx`
- `packages/frontend/src/components/assistant/AssistantMessage.tsx`
- `packages/frontend/src/components/assistant/AssistantInput.tsx`
- `packages/frontend/src/components/assistant/AssistantSuggestions.tsx`
- `packages/frontend/src/components/assistant/AssistantPanel.tsx`
- `packages/frontend/src/components/assistant/AssistantWidget.tsx`

Modify:
- `packages/frontend/src/components.css` (floating-shell classes only)
- `packages/frontend/src/components/Layout.tsx` (mount provider + widget once)
- `packages/frontend/src/pages/Assistant.tsx` (refactor to reuse shared panel/hook)

Reuse untouched:
- `packages/frontend/src/api/endpoints.ts` (`chatApi.ask`, `ChatTurn`, `ChatAnswer`)
- `packages/frontend/src/components/ui.tsx` (`SourceBadge`, `Button`, `PageHeader`, `Select`)
- `packages/frontend/src/components/icons.tsx` (`IconAI`)
- Existing `.chat-*` CSS in `components.css`
- Entire backend, `POST /api/chat`, `chatService`, `MockAIProvider`, `AIProvider` contract

## Open assumptions
- Default widget service/environment = `urbani-app` / `production-eb` (today's page defaults). If the shared hook has not yet received an answer, the header shows "Powered by MockAIProvider · Phase 1" and a `MOCK` logs badge until the first response sets `logsSource`.
- Desktop floating panel fixed at 400×640 (inside the required ranges); adjust within 380-440 / 560-680 if a reviewer prefers.
