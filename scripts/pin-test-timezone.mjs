// Pins the timezone the test run interprets local dates in, so assertions
// against local-date/local-time behavior are independent of the host
// machine's or CI runner's configured timezone.
process.env.TZ = 'Europe/Amsterdam';
