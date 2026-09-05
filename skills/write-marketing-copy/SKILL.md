---
name: write-marketing-copy
description: Write or rephrase platform-native marketing posts for LinkedIn, X, and Threads. Use when explicitly invoked to turn source material into posts or improve existing social copy, with English LinkedIn and X plus formal-polite Korean Threads defaults.
---

# Write Marketing Copy

Create or rephrase publication-ready social copy from the material the user provides. Adapt the same core message to each platform instead of translating it literally. Do not publish the posts.

## Choose the operation

- For a topic, notes, announcement, or a request for platform variants, create platform-native posts using the defaults below.
- When the user asks to rephrase, rewrite, or polish existing copy, return one improved version in the same language and for the same platform. Preserve its point of view, intent, approximate length, and structure unless the user asks to change them. Do not automatically expand a rephrase into all three platforms.
- In a rephrase, improve clarity, flow, naturalness, and platform fit without adding new ideas, calls to action, or hashtags. Return multiple alternatives only when requested.

## Preserve the source

- Treat the user's material as the source of truth.
- Preserve names, links, numbers, and factual claims accurately.
- Do not invent facts, testimonials, customer results, or product capabilities.
- Proceed when the subject and intent are reasonably clear. Ask a question only when the core message cannot be inferred.
- Follow explicit requests for voice, length, format, or a subset of platforms. Otherwise, use the defaults below.

## Default voice

Write in a credible first-person expert voice: clear, specific, confident, and human. Avoid hype, generic marketing language, and unsupported superlatives. Use emojis only when requested. Add a call to action or a small number of relevant hashtags only when they improve the post.

## Platform copy

### LinkedIn

Write in English. Open with a strong, credible lead, then develop the idea in short, readable paragraphs. Include enough context for the post to stand alone.

### X

Write in English. Prefer one post of no more than 280 characters. If that would remove essential meaning, write a thread of two to four posts; keep every post within 280 characters and number them as `1/N`, `2/N`, and so on.

### Threads

Write in natural Korean using consistent formal polite endings such as `-합니다` and `-입니다`. Favor idiomatic Korean social writing over English-derived sentence structure.

## Output

For new copy or cross-platform adaptation, unless the user requests only some platforms, return all three sections in this order:

1. `LinkedIn`
2. `X`
3. `Threads`

For a rephrase, return a single fenced code block under the applicable platform label. If the platform is unknown, use `Rephrased copy` as the label.

Put each ready-to-post copy in its own fenced code block, with the label outside the block. Do not add a language identifier to the fence. If X requires a thread, put each numbered post in a separate fenced code block so it can be copied independently.

Return only the labels and ready-to-post copy. Do not add strategy notes, explanations, or alternative drafts unless requested.
