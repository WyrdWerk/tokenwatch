> ## Documentation Index
> Fetch the complete documentation index at: /docs/llms.txt
> Use this file to discover all available pages before exploring further.

# Models

> Models available on serverless, with context windows and prices.

## Choosing a model

Start from what your task needs, then compare prices below. We don't publish speed
or quality rankings yet.

| If you need | Consider | Why |
| - | - | - |
| The lowest price per token | GLM 5.3 Flash | Lowest uncached input and output prices in the catalog. It reasons before answering, so give it enough `max_tokens`. |
| Short, direct answers, or long prompts you resend often | DeepSeek V4.1 Flash 1017 | Answers without a reasoning step, and has the lowest cached input price. This is the model the [quickstart](/docs/quickstart.md) uses. |
| Image input | Kimi K3, GLM 5.3 Flash or DeepSeek V4.1 Flash 1017 | The models that accept images. |
| Reasoning on text only | GLM 5.3 | Mid-priced, text-only reasoning model. |
| The largest model | Kimi K3 | 2.8T parameters, with image input and reasoning. The highest price in the catalog. |

## Model IDs

Pass the model ID as `model`. IDs are case-sensitive.
[`GET /v1/models`](/docs/api-reference/list-models) returns the models your API key can
call, with each model's `max_context` and `max_output` in tokens.

## Serverless models

Prices are USD per 1M tokens.

| Model | ID | Context | Max output | Input | Input price | Cached input price | Output price |
| - | - | - | - | - | - | - | - |
| Kimi K3 | `moonshotai/Kimi-K3` | 1,048,576 | 131,072 | Text, image | \$2.50 | \$0.252 | \$12.82 |
| GLM 5.3 | `zai-org/GLM-5.3` | 1,048,576 | 131,072 | Text | \$1.01 | \$0.162 | \$3.31 |
| GLM 5.3 Flash | `zai-org/GLM-5.3-Flash` | 1,048,576 | 131,072 | Text, image | \$0.11 | \$0.018 | \$0.39 |
| DeepSeek V4.1 Flash 1017 | `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 1,048,576 | 131,072 | Text, image | \$0.22 | \$0.006 | \$0.89 |

The prompt plus the output limit must fit in the context window. If you don't set
`max_tokens` (`max_output_tokens` on Responses), it defaults to the model's max
output.

## Features

| Model | [Tool calling](/docs/tool-calling.md) | [Structured output](/docs/structured-output.md) | [Images](/docs/images.md) | [Reasoning](/docs/reasoning.md) | [Prompt caching](/docs/prompt-caching.md) |
| - | - | - | - | - | - |
| Kimi K3 | Yes | Yes | Yes | Yes | Yes |
| GLM 5.3¹ | Yes | Yes | No | Yes | Yes |
| GLM 5.3 Flash | Yes | Yes | Yes | Yes | Yes |
| DeepSeek V4.1 Flash 1017 | Yes | Yes | Yes | No | Yes |

¹ New in the catalog. Its features come from the model provider's documentation
and haven't been fully tested through this API yet.

Every model is served on Chat Completions, Responses and Completions, with streaming.

`max_tokens` up to the model's max output is a limit you can set, not an amount the
model will produce. A long generation can reach the 290-second request timeout before
it reaches the limit, so keep limits to what you need.

Need guaranteed capacity or a model that isn't listed? See
[Dedicated deployments](/docs/dedicated.md).


This documentation is built and hosted on [Mintlify](https://mintlify.com), a developer documentation platform.