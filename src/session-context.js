// Which session a long-running operation belongs to.
//
// Tracks WHICH session a long-running operation (a turn, a background task)
// belongs to, independent of whatever tab the user has since switched to.
// Without this, a turn running for project A would start reading/writing
// project B's messages/checkpoints/etc. the instant the user switched tabs,
// since those are otherwise resolved from the live, shared activeSessionId —
// see the _session getter in extension.js, which prefers this context when
// present.
//
// A module-level singleton on purpose: every module that participates in a turn
// has to see the same store, and it lives here rather than in extension.js so
// the extracted modules can read it without importing their own importer.

const { AsyncLocalStorage } = require('async_hooks');

const sessionContext = new AsyncLocalStorage();

module.exports = { sessionContext };
