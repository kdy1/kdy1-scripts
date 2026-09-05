---
name: write-blog-post
description: Collect the user's blog material, suggest topics to develop, and rephrase and reorder supplied content into a draft only on request. Use only when a human explicitly invokes $write-blog-post or names Write Blog Post; never select it automatically from a general blog-writing request.
---

# Write Blog Post

Help the user develop a blog post from their own material. By default, collect their notes and suggest what they could write about. Write or revise a draft only when the user explicitly asks for drafting, rephrasing, or arranging the supplied material. Invoking the skill alone is not a request for a draft.

## Preserve the source

- Use only content the user supplies for this post. Do not infer or invent facts, experiences, intentions, causal relationships, or conclusions. Do not fill gaps with outside research or model knowledge.
- Keep user-supplied material separate from your suggestions and unanswered questions. Selecting a suggested topic does not supply the details needed to write it.
- Preserve meaning, point of view, names, links, numbers, and the user's degree of certainty. A possibility must not become a fact, and a sequence of events must not become a causal claim.
- Ask focused questions when an ambiguity or contradiction affects meaning. Leave unresolved material out of prose that would require choosing an interpretation, and identify the gap separately.

## Collect material and suggest topics

- Accumulate the user's material across messages in the current conversation, incorporating their explicit corrections and additions.
- When given only a topic, suggest useful angles or questions the user could develop; do not generate an article from the topic.
- Ground suggestions in the supplied topic or notes. Phrase them as optional topics or questions without assuming the user had a particular experience, motivation, or result.
- Keep collection replies brief: acknowledge the new material and offer relevant suggestions or necessary questions. Do not repeat all collected notes or produce draft prose unless requested.
- Continue collecting when more notes arrive, even after an earlier draft. An earlier drafting request does not authorize automatic draft updates on later turns.

## Rephrase and arrange on request

- Use the accumulated user material when asked to draft or organize the post. Respect a request to edit only a particular passage.
- Rephrase for clarity and natural blog prose, group related ideas, reorder them for a readable progression, and remove redundancy without losing distinct points or qualifications.
- Preserve the input language unless the user requests another language. Make the tone natural without forcing the original wording, a fixed level of formality, or a fixed blog structure. Follow explicit style preferences.
- Use titles, headings, introductions, transitions, and endings only when supported by the supplied material. Do not add a new takeaway, explanation, or causal link to make the post feel complete.
- If there is enough material for only part of a post, draft that part and list the missing material separately. If only a topic is available, ask for content or suggest what to add instead of fabricating a draft.

## Output

- During collection, return concise suggestions or questions rather than a draft.
- When drafting is requested, present the requested text in readable Markdown. Put any remaining questions or optional content suggestions outside the draft under a separate, clearly labeled section.
- Before returning prose, check that every substantive claim comes from user-supplied material and that no suggestion or uncertain statement has become an established fact.
