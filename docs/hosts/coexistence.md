# Cursor and Codex coexistence (historical)

English | [简体中文](coexistence.zh-CN.md)

Pactile v0.5 could project both Cursor and Codex from one canonical generation.
That installation mode has been retired. New installations and updates select
only Codex. Older Cursor claims remain available for safe exit and are not
refreshed by a Codex update.

For an existing mixed project, run `pactile detach cursor --dry-run` and review
the ownership plan. Applying `pactile detach cursor` releases that claim while
preserving modified, borrowed, and user-owned files. See
[projection and ownership](../concepts/projection-and-ownership.md).
