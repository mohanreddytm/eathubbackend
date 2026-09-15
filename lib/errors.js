const { randomUUID } = require("crypto");
function sendError(error, req, res) {
  const requestId = req.requestId || randomUUID();
  let status = error.status || 500,
    message = error.message;
  if (["42P01", "42703", "SCHEMA_NOT_READY"].includes(error.code)) {
    status = 503;
    message =
      "The service needs a database update. Please contact the restaurant administrator.";
  } else if (
    [
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "57P01",
      "53300",
      "08006",
    ].includes(error.code)
  ) {
    status = 503;
    message =
      "The service is temporarily unavailable. Please try again shortly.";
  } else if (error.code === "23505") {
    status = 409;
    message = "This record already exists.";
  } else if (error.code === "23503") {
    status = 409;
    message = "This record is in use. Resolve its linked records first.";
  } else if (
    ["23514", "22P02", "22003", "22007", "22008"].includes(error.code)
  ) {
    status = 400;
    message = "Check the values entered and try again.";
  } else if (status >= 500)
    message = "We could not save your changes. Please try again.";
  if (status >= 500)
    console.error(
      JSON.stringify({
        requestId,
        method: req.method,
        path: req.path,
        code: error.code || "INTERNAL",
        message: error.message,
      }),
    );
  return res.status(status).json({ error: message, requestId });
}
module.exports = { sendError };
