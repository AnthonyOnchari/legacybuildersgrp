const { onRequest } = require("firebase-functions/v2/https");
const { handleApiRequest } = require("./api-core");

exports.api = onRequest({ region: "us-central1", cors: false }, handleApiRequest);
