# AI extension

Gitmun ships AI support as a bundled, experimental extension. It is disabled by default on new installations. Enabling or disabling it does not remove profiles or credentials, and the module boundary is designed so the feature can move to a separately installed Gitmun extension later. Gitmun does not currently load third-party extension code.

## Providers

The provider list contains OpenAI, Anthropic Claude, Mistral, Google Gemini, OpenRouter, Azure OpenAI, Ollama, LM Studio and an advanced OpenAI-compatible option. Mistral and Gemini use their OpenAI-compatible APIs through Gitmun's shared transport. OpenRouter uses the same transport with additional privacy, routing, catalogue, pricing and usage handling.

Profiles keep the provider, canonical endpoint, protocol, model and provider-specific settings together. Credentials are stored separately in the operating-system credential store and are scoped to the profile, provider and endpoint authority. Changing a destination does not reuse the previous destination's credential. Environment-provided secrets are never returned to the UI, written to the configuration file or copied to the credential store.

Remote providers must use HTTPS. Plain HTTP is accepted only for loopback addresses such as `127.0.0.1`, `localhost` and `::1`. URLs containing credentials are rejected, authenticated redirects are not followed, responses are size-limited and paid generation requests are not retried automatically.

## Environment overrides

Gitmun reads AI overrides once at launch. Precedence is explicit `GITMUN_AI_*` values, standard variables for the explicitly selected provider, the selected stored profile, then provider defaults. Invalid values fail closed and errors identify the variable name without including its value. Environment-managed controls are read-only in Settings.

The supported variables are:

```text
GITMUN_AI_ENABLED
GITMUN_AI_PROVIDER
GITMUN_AI_ENDPOINT
GITMUN_AI_MODEL
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

When a provider is explicitly selected, Gitmun also recognises its standard secret variable: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, `GEMINI_API_KEY` (then `GOOGLE_API_KEY`), `OPENROUTER_API_KEY` or `AZURE_OPENAI_API_KEY`. Established endpoint variables including `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL` and `AZURE_OPENAI_ENDPOINT` are supported in the same provider-scoped way.

## Privacy and workflows

Before sending repository content to a provider authority for the first time, Gitmun shows an outbound-context preview and requires consent. Global and per-repository exclusions can block repository-relative paths, and recent commit history can be excluded. Sensitive-path detection is a best-effort guard, not a substitute for reviewing the preview.

Commit messages are generated as one to three candidates. Normal, amend, merge, rebase, cherry-pick and revert workflows pass their workflow and existing message as context. Nothing replaces the editor until a candidate is accepted, and existing text requires confirmation. Requests are cancelled or rejected when their repository or staged snapshot becomes stale.

Conflict resolution produces structured, per-region proposals without writing files. Applying selected regions explicitly revalidates the repository, index and file, preserves line endings and permissions, writes atomically, and offers session-scoped undo.

The AI writing tools provide preview-only staged-change reviews, branch summaries, pull request descriptions and release notes. They never publish content or write repository files. Branch and pull request tasks use the configured base reference or the current branch's upstream; release notes use the configured base reference or latest tag. Repository policies can override history inclusion, exclusions, commit style, language and repository-relative commit or conflict prompt files.

OpenRouter defaults to denying provider data collection, allows normal provider fallback and requires requested parameters. Strict ZDR and account-default privacy modes are available. Requests include OpenRouter [app attribution](https://openrouter.ai/docs/app-attribution) for Gitmun using its public project URL, application title and `programming-app` category; attribution never includes repository or user data. Model discovery uses the authenticated `/models/user` catalogue and enriches it with the ZDR endpoint list. Selecting a model also loads its available providers, quantisation, limits, pricing and recent performance metadata. Search, filters, sorting and pagination are applied locally because the catalogue endpoint exposes only offset and limit. Failure of user-aware discovery is shown instead of falling back to the unrestricted public catalogue. Gitmun does not invoke OpenRouter tools, web search, shell execution, BYOK management, activity or credit-management APIs.

OpenRouter profiles can authenticate through [OpenRouter OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth). Gitmun opens the system browser, receives the one-use authorisation code on an arbitrary loopback port, exchanges it using an S256 verifier and stores only the resulting profile-scoped API key in the operating system credential store. The verifier and returned key never enter the frontend. Clearing the credential in Gitmun does not revoke the user-controlled key in OpenRouter; revoke it from the OpenRouter account when remote invalidation is required. OAuth is available only for the official `https://openrouter.ai` service and is disabled when the credential is supplied by the launch environment.

Local usage history retains provider, profile, model, task, duration, token counts, returned cost, request identifiers and status for 30 days. It never stores prompts or repository content and can be cleared in Settings.
