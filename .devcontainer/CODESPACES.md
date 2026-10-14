# DeepTutor in GitHub Codespaces

This fork runs DeepTutor entirely in the cloud — nothing is installed on your PC.

## Start it

1. On the repo page click **Code → Codespaces → Create codespace on main**
   (choose the **4-core / 16 GB** machine).
2. The first build takes roughly 10–20 minutes: it installs DeepTutor, Ollama, and
   downloads two free local models (`qwen2.5:3b` for chat, `nomic-embed-text` for
   knowledge bases).
3. When it finishes, open the **Ports** tab and click the globe icon next to
   **DeepTutor (3782)**. Later starts take under a minute.

## Two ways to use a model

| Mode | Works without an API key | How |
| --- | --- | --- |
| **Local (default)** | Yes — runs on Ollama inside the Codespace, free | Already configured |
| **Cloud provider** | No — needs your key (OpenAI, Anthropic, Gemini, DeepSeek, …) | **Settings → Providers**, add the key there, then pick the model in **Language models** |

You can switch between them at any time in Settings. Web search uses DuckDuckGo (no key).

The local model runs on CPU, so answers are slower and simpler than a cloud model's.

## Useful commands (Codespace terminal)

```bash
.venv/bin/deeptutor doctor                            # health check
.venv/bin/deeptutor stop                              # stop the app
bash .devcontainer/post-start.sh                      # start it again
ollama pull llama3.2                                  # add another local model
```

## Costs and data

- Free GitHub accounts get 120 core-hours/month — about **30 hours** on a 4-core
  machine. Stop the Codespace when you are done (it auto-stops after 30 min idle).
- Your settings, API keys, and knowledge bases live in `/workspaces/.deeptutor-home`
  inside the Codespace. They persist across stops, but are **deleted if you delete
  the Codespace**, and they are never committed to the repo.
