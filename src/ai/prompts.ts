// Sate core — AI function registry, system prompts, and defensive JSON parsing / normalization.
//
// The implementation now lives in ../shared/prompts.js, a runtime-agnostic CommonJS module that the
// Hosted (PocketBase/goja) edition requires directly. This file stays as the typed import path the
// Cloud codebase already uses, so the prompt text is defined once and both editions send the model
// exactly the same instructions.
//
// PocketBase-specific concerns (provider-key encryption via $security, DB provider lookup) are not
// here and not shared — Cloud gets keys from the Secrets port and provider config from DataStore.

export * from "../shared/prompts.js";
