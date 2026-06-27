# FAQ

## Is this official?

No. It is unofficial and not affiliated with Withings.

## What data can it read?

Body measures, daily activity, sleep summaries, sleep periods, workout records and heart records when granted.

## How should agents query large body-measure histories?

Use `withings_list_body_measures` with ISO 8601 `after` and `before` values plus a small `limit`. The server converts the date window to Withings `startdate` / `enddate` before calling the API and caps the response records locally.

## Does it provide raw sensor data?

No raw accelerometer/device telemetry. `raw` mode means upstream Withings Public API JSON for supported endpoints.

## Is it medical advice?

No. It provides wellness/training context only.
