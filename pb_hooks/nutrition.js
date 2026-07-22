/// <reference path="../pb_data/types.d.ts" />

// Sate — deterministic nutrition target engine.
//
// The implementation is shared with the Cloud edition and lives in core/src/shared/nutrition.js,
// copied into the image at /pb/pb_hooks/shared/ by the Dockerfile. This file stays as the require
// path api.js already uses, so the engine is defined once and both editions agree on the math.

module.exports = require(`${__hooks}/shared/nutrition.js`);
