# Practical STE examples

These examples illustrate clarity and meaning preservation. They do not demonstrate full ASD-STE100 compliance or approval of individual words.

## English PR: preserve the template and failed validation

Before:

```markdown
## Summary

This PR introduces functionality through which the client makes exactly one additional attempt after 2 seconds when an HTTP request times out.

## Validation

Execution of `pytest tests/test_retry.py` resulted in failure: 1 test failed and 12 tests passed.

Closes #123

[Issue details](https://github.com/example/client/issues/123)
```

After:

```markdown
## Summary

If an HTTP request times out, the client retries it once after 2 seconds.

## Validation

`pytest tests/test_retry.py` failed: 1 test failed and 12 tests passed.

Closes #123

[Issue details](https://github.com/example/client/issues/123)
```

The headings, command, link, issue reference, retry count, delay, condition, and failed test result remain intact. A shorter description does not turn the failed validation into a success.

## Korean explanation: preserve uncertainty

Before:

```text
오래된 캐시를 사용한 상태에서 `/v1/items` 요청이 간헐적으로 실패하는 현상이 관찰되었으며, 캐시 만료가 원인일 가능성이 있는 것으로 추정되지만 아직 원인이 확인된 것은 아닙니다. 정확한 진단 메시지는 "cache entry expired"입니다.
```

After:

```text
오래된 캐시를 사용한 상태에서 `/v1/items` 요청이 간헐적으로 실패합니다. 캐시 만료가 원인일 수 있습니다. 원인은 아직 확인하지 못했습니다. 정확한 진단 메시지는 "cache entry expired"입니다.
```

The explanation stays in Korean. The possible cause remains unconfirmed. The rewrite adds no actor and preserves the path and quoted diagnostic message.

## Procedure: preserve the condition across all steps

Before:

```text
If CI fails because its dependency cache is stale, you should remove only `.cache/deps` and then run `npm ci` and `npm test`, in that order. Do not remove `.cache/results`.
```

After:

```text
If CI fails because its dependency cache is stale, you should:

1. Remove only `.cache/deps`.
2. Run `npm ci`.
3. Run `npm test`.

Do not remove `.cache/results`.
```

All three steps remain conditional recommendations. Their order, commands, deletion boundary, and prohibition remain unchanged.
