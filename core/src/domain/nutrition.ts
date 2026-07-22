// Sate — deterministic nutrition target engine.
//
// The implementation now lives in ../shared/nutrition.js, a runtime-agnostic CommonJS module that
// the Hosted (PocketBase/goja) edition requires directly. This file stays as the typed import path
// the Cloud codebase already uses (`import * as nutrition from "../domain/nutrition"`), so the
// engine is defined once and both editions compute identical numbers.

export * from "../shared/nutrition.js";
