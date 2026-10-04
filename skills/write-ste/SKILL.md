---
name: write-ste
description: Write or revise human-readable technical text with practical ASD-STE100 principles. Use automatically for PR and issue titles and bodies, review comments, technical documentation, and code explanations, including technical chat replies. Preserve the text's language and meaning; apply clarity principles to languages other than English. Exclude ordinary conversation and marketing copy.
---

# Write STE

Apply ASD-STE100 clarity principles to technical writing. This is a practical adaptation, not full standard compliance. It does not check the official approved vocabulary or certify compliance. For background, see the [official ASD-STE100 FAQ](https://www.asd-ste100.org/STE_faq.html).

## Apply within the task

- Apply these rules when drafting or revising technical text, including the prose in requested code comments and docstrings. Do not rewrite unrelated existing text.
- Follow explicit user instructions for language, voice, length, and format. Otherwise, preserve the source language or the language established by the task. Do not translate solely to apply STE.
- Keep repository templates, required headings and fields, issue references, and required disclosures. Use this skill alongside other skills without changing their workflow, required content, or authorization boundaries.
- Return the requested text or artifact. Do not append a STE checklist, compliance notice, or before-and-after comparison unless requested.

## Preserve meaning and protected text

- Preserve facts, quantities, units, conditions, exceptions, timing, sequence, negation, and obligation. Keep the distinction between what must, should, may, or can happen.
- Preserve uncertainty and the strength of each claim. Do not turn a possible cause into a confirmed cause, or a proposed change into an implemented change.
- Report validation exactly as supported by the evidence. Keep failed, pending, skipped, and unperformed checks distinct from passing checks. Separate code inspection from tests that actually ran.
- Do not invent an actor, cause, outcome, or missing context to make a sentence sound more direct. Retain unknowns; ask only if the missing fact prevents an accurate result.
- Preserve code blocks, commands, identifiers, paths, URLs, numbers, direct quotations, and exact diagnostic messages. Rewrite the surrounding prose, not these literals. In a requested comment or docstring edit, revise only its prose and preserve code examples and identifiers.

## Write clearly

- Use short sentences with one main idea. Split a long sentence when the split preserves its relationships and meaning. Do not enforce a fixed word count at the expense of accuracy or natural language.
- Use active voice when the actor is known. Keep a passive construction when the actor is unknown and changing it would invent information.
- Use familiar, concrete words and direct verbs. Remove filler and unnecessary repetition without deleting qualifications or evidence.
- Use the same term for the same concept. Preserve established project terminology; do not replace precise domain terms with vague everyday words or vary synonyms for style.
- Make pronoun references clear. Repeat the relevant noun when words such as "it", "this", or "they" could refer to multiple things.
- Keep each paragraph focused on one topic. Use lists for steps or parallel items when they make the text easier to follow; preserve the required document structure.
- For procedures, give one action per sentence and use direct instructions. Put a condition before the actions it governs. When splitting steps, keep the original order, dependencies, and the scope of conditions and exceptions.
- In English, prefer simple sentence structures and verb forms when they preserve meaning. In Korean and other languages, apply clarity and terminology principles through natural local grammar. Do not impose English vocabulary restrictions, word counts, or word order.

For concrete English and Korean rewrites, read [references/examples.md](references/examples.md) when an example would help. The examples illustrate this adaptation; they are not certified STE text.

## Check before delivery

Compare the draft with the source or task evidence before returning it:

- Does each claim retain its original meaning, conditions, uncertainty, and validation status?
- Are actors and pronoun references clear without invented information?
- Does each procedure preserve its action order and the scope of its conditions?
- Are protected literals, required template content, and the requested language and format intact?
- Is the wording direct, with consistent terms and no unnecessary filler?

Correct any mismatch before delivery. If the source does not support a claim, retain the limitation rather than filling it in.
