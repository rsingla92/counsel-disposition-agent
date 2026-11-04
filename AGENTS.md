# Disposition agent

A Cloudflare Worker that routes one async patient message to one of seven urgency levels, with a Python eval.

## Review guidelines

Review in this order. Flag style nits only after these.

1. Zero-miss gate: no code path may route a case that should be Call 911 or ED now below `ed_now`.
2. Every failure path (timeout, invalid output, provider error) ends at Human review or a higher disposition, never a lower one.
3. A red flag marked present always sets at least its minimum level, whatever the LLM says.
4. Excerpts must be verified as verbatim substrings of the patient message.
5. No Counsel data, patient message text or secrets in the repo. Logs never contain message text or IP addresses.
6. Tests are hermetic, with the LLM mocked.
