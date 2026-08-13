# AI extension

Gitmun ships AI support as a bundled, experimental extension. It is disabled by default on new installations. The frontend, Tauri commands and provider runtime are compiled into the main application; the extension is not currently a separate or on-demand download. Enabling or disabling it does not remove profiles or credentials. Gitmun does not currently load third-party extension code.

## Providers

The provider list contains OpenAI, Anthropic Claude, Mistral, Google Gemini, OpenRouter, Azure OpenAI, Ollama, LM Studio and an advanced OpenAI-compatible option. Mistral and Gemini use their OpenAI-compatible APIs through Gitmun's shared transport. OpenRouter uses the same transport with additional privacy, routing, catalogue, pricing and usage handling.

Profiles keep the provider, canonical endpoint, protocol, main model, optional commit-message model override and provider-specific settings together. Credentials are stored separately in the operating-system credential store and are scoped to the profile, provider and endpoint authority. Changing a destination does not reuse the previous destination's credential. Environment-provided secrets are never returned to the UI, written to the configuration file or copied to the credential store.

When configured, commit message generation (including composer candidates and regeneration) uses the commit-message model override; conflict resolution, AI writing features (staged review, branch summary, pull request description, release notes) and connection tests always use the main model. The connection test and reasoning effort capabilities are probed against the main model only; an override model that rejects reasoning controls surfaces `reasoningUnsupported` at generation time.

Remote providers must use HTTPS. Plain HTTP is accepted only for loopback addresses such as `127.0.0.1`, `localhost` and `::1`. URLs containing credentials are rejected, redirects are not followed and responses are size-limited. Generation requests are not retried after transport failures or ordinary provider errors, but Gitmun can make bounded follow-up requests when automatic reasoning effort or structured output is rejected as unsupported. Large commit contexts can also require separate summarisation requests, so one user action can make more than one provider request.

## Environment overrides

Gitmun reads AI overrides once at launch. Precedence is explicit `GITMUN_AI_*` values, standard variables for the explicitly selected provider, the selected stored profile, then provider defaults. Invalid values fail closed and errors identify the variable name without including its value. Environment-managed controls are read-only in Settings.

The supported variables are:

```text
GITMUN_AI_ENABLED
GITMUN_AI_PROVIDER
GITMUN_AI_ENDPOINT
GITMUN_AI_MODEL
GITMUN_AI_COMMIT_MODEL
GITMUN_AI_API_KEY
GITMUN_AI_REASONING
GITMUN_AI_API_STYLE
GITMUN_AI_REQUEST_PATH
GITMUN_AI_MODELS_PATH
GITMUN_AI_AUTH_MODE
GITMUN_AI_AUTH_HEADER
GITMUN_AI_MAX_TOKENS_FIELD
GITMUN_AI_EXTRA_HEADERS_JSON
GITMUN_AI_AZURE_DEPLOYMENT
GITMUN_AI_AZURE_API_VERSION
GITMUN_AI_OPENROUTER_PRIVACY
GITMUN_AI_OPENROUTER_ALLOW_FALLBACKS
GITMUN_AI_OPENROUTER_REQUIRE_PARAMETERS
GITMUN_AI_OPENROUTER_MAX_PROMPT_PRICE
GITMUN_AI_OPENROUTER_MAX_COMPLETION_PRICE
GITMUN_AI_COMMIT_CONTEXT_LIMIT_KIB
GITMUN_AI_CONFLICT_CONTEXT_LIMIT_KIB
GITMUN_AI_COMMIT_MAX_TOKENS
GITMUN_AI_CONFLICT_MAX_TOKENS
GITMUN_AI_COMMIT_PROMPT_FILE
GITMUN_AI_CONFLICT_PROMPT_FILE
GITMUN_AI_INCLUDE_COMMIT_HISTORY
```

`GITMUN_AI_REASONING` accepts `automatic`, `off`, `providerdefault`, `low`, `medium` or `high`. The aliases `none` and `disabled` also select Off.

When a provider is explicitly selected, Gitmun also recognises its standard secret variable: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, `GEMINI_API_KEY` (then `GOOGLE_API_KEY`), `OPENROUTER_API_KEY` or `AZURE_OPENAI_API_KEY`. Established endpoint variables including `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` and `AZURE_OPENAI_ENDPOINT` are supported in the same provider-scoped way.

## Privacy and workflows

Before any workflow sends repository content to a provider authority for the first time, Gitmun shows an outbound-context preview and requires consent. Commit-message and AI-writing contexts honour global and per-repository path exclusions, can omit recent commit history and apply best-effort sensitive-path detection. Conflict-resolution context never includes recent commit history, but it does not currently apply configured path exclusions or sensitive-path detection. Conflict input is restricted to a repository-contained, unmerged UTF-8 file within the configured context limit. These guards are not a substitute for reviewing the preview.

The commit editor's primary AI action generates one candidate using the repository defaults. Its adjacent menu opens the full composer for one to three candidates, issue keys and one-off instructions. Composer defaults can retain the mode, language and optional Conventional Commit type and scope without retaining issue keys or additional instructions. Existing text requires confirmation before a quick request, generated text has one-step undo, and the full composer writes nothing until a candidate is accepted. Quick generation is cancelled if its repository, workflow or editor contents change, and the backend rejects results when the staged snapshot changes. Normal, amend, merge, rebase, cherry-pick and revert workflows pass their workflow and existing message as context.

Conflict resolution produces structured, per-region proposals without writing files. Gitmun can generate proposals for one conflict file or queue every eligible conflict file, using one generation operation per file and processing multi-file queues sequentially. Before a multi-file queue starts, Gitmun shows the number of prepared prompts and warns about potential paid provider requests. Multi-file results are grouped by file for review, while applying selected regions still revalidates and writes one file at a time. Applying proposals preserves line endings and permissions and writes atomically. Applying every region also stages the file as resolved. Undo restores the original file and unmerged index while the in-memory proposal session remains available, for up to one hour.

The AI writing tools provide preview-only staged-change reviews, branch summaries, pull request descriptions and release notes. They never publish content or write repository files. Branch and pull request tasks use the configured base reference or the current branch's upstream; release notes use the configured base reference or latest tag. Repository policies control history inclusion and exclusions for commit generation and AI writing. Commit generation can also use saved style and language defaults and a repository-relative commit prompt file. Conflict generation can use a repository-relative conflict prompt file; launch-environment prompt overrides take precedence.

OpenRouter defaults to denying provider data collection, allows normal provider fallback and requires requested parameters. Strict ZDR and account-default privacy modes are available. Requests include OpenRouter [app attribution](https://openrouter.ai/docs/app-attribution) for Gitmun using its public project URL, application title and `programming-app` category; attribution never includes repository or user data. Model discovery uses the authenticated `/models/user` catalogue and enriches it with the ZDR endpoint list. Selecting a model also loads its available providers, quantisation, limits, pricing and recent performance metadata. Gitmun applies its model search, filters, sorting and UI pagination locally after fetching the user-aware catalogue. Failure of user-aware discovery is shown instead of falling back to the unrestricted public catalogue. Gitmun does not invoke OpenRouter tools, web search, shell execution, BYOK management, activity or credit-management APIs.

OpenRouter requests use its unified reasoning control and exclude reasoning traces from responses. Automatic disables reasoning for commit messages and connection tests, while conflict resolution uses hidden medium reasoning. Off explicitly requests no reasoning, and Provider default omits the reasoning control. Other providers retain low reasoning for commit messages and medium reasoning for conflict resolution under Automatic.

OpenRouter profiles can authenticate through [OpenRouter OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth). Gitmun opens the system browser, receives the one-use authorisation code on an arbitrary loopback port, exchanges it using an S256 verifier and stores only the resulting profile-scoped API key in the operating system credential store. The verifier and returned key never enter the frontend. Clearing the credential in Gitmun does not revoke the user-controlled key in OpenRouter; revoke it from the OpenRouter account when remote invalidation is required. OAuth is available only for the official `https://openrouter.ai` service and is disabled when the credential is supplied by the launch environment.

Local usage history records provider, profile, the model that actually served the request, task, duration, token counts, returned cost, request identifiers and status. When a new record is added, entries older than 30 days are removed and the history is capped at 1,000 records. It never stores prompts or repository content and can be cleared in Settings.
