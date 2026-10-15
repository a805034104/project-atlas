# AI model / 模型

| Provider | Base URL | Default model |
|---|---|---|
| Anthropic | https://api.anthropic.com | claude-sonnet-5-5 |
| OpenAI-compatible (DeepSeek, Qwen...) | e.g. https://api.deepseek.com/v1 | set `atlas.llm.model` |
| Ollama (local) | http://localhost:11434 | qwen2.5-coder:7b (`ollama pull qwen2.5-coder:7b`) |

Keys are stored in VS Code SecretStorage, never in settings.json. `.env` files, keys and passwords are never sent. Atlas shows the token and cost estimate per phase and sends nothing until you confirm.

Key 保存在 VS Code SecretStorage 中，不会写入 settings.json。`.env`、密钥、密码永远不会发送。Atlas 会按阶段显示 token 和费用预估，确认后才发送。
