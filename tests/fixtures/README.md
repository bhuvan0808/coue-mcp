# Test fixtures

These fixtures feed COUE's own analyzers.

## About the credential-shaped strings

Several fixtures contain strings that look like AWS keys, GitHub tokens, Slack tokens,
and database passwords. **None of them are real.** They exist so the test suite can prove
two things:

1. COUE detects credential *shapes* in submitted source, and
2. COUE never returns, logs, or stores the value it detected.

They are constructed to be unmistakably synthetic:

- `AKIAIOSFODNN7EXAMPLE` is AWS's own published example access key ID.
- Other values use obvious filler (`abcdefghijklmnop`, `123456789012`, `FAKEKEY`).
- `hunter2` is a well-known joke password.

If a secret scanner flags this directory, this is why. Please do not "fix" it by
weakening the fixtures — the tests would stop proving anything.
