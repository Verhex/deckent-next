// FIX8a R27: React, its reconciler and scheduler pick their build from NODE_ENV on first load, which a person's shell rarely sets; the CLI entry imports
// this first in every distribution (npm package and source-built dist alike), so the terminal runs production React. A mode the caller set (the test runner's) is kept.
process.env.NODE_ENV ||= 'production'; export {};
