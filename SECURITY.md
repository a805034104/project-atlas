# Security

Please report vulnerabilities privately through GitHub: **Security ▸ Report a vulnerability** on this repository (private vulnerability reporting). Do not open a public issue.

Include the version (or commit), what an attacker controls (a repository being analyzed, a request to the local receiver, a model response…), and a minimal reproduction. You should get a first reply within a week.

## Scope

ProjectAtlas analyzes code that may come from untrusted repositories, and in v0.2 runs a local OTLP receiver. In scope, for example:

- Code execution or file writes outside `.atlas/` triggered by analyzing a repository.
- The runtime receiver accepting data from anything other than the traced application (it must listen on 127.0.0.1, require its per-session token, reject `Origin` and unknown `Host`).
- Span attribute values (SQL text, bodies, headers, Redis values) being stored or passed to an LLM or MCP client.
- Secrets in analyzed files reaching an AI provider unmasked.
- The webview executing content from the analyzed repository.

Out of scope: issues that need an attacker to already control your VS Code settings or your machine.
