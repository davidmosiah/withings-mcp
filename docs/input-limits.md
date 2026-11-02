# Transport input boundaries

Both stdio and HTTP explicitly cap MCP tool inputs at 10,000 combined object
members and array elements, using the SDK limit before input-schema processing.
The checked-in lockfile already uses SDK 1.32.2; no dependency update is needed.

HTTP JSON bodies remain limited to 1 MiB. Compressed request bodies (gzip, deflate
and Brotli) are rejected with HTTP 415 instead of being inflated. Oversized bodies
return 413. These limits do not authenticate clients or impose a total process
memory budget. Use stdio or local loopback HTTP as described in
[local-only HTTP](local-http-transport.md).

Synthetic tests cover both transports, the exact element boundary and above-limit
arrays/objects/nesting, recovery after rejected calls, compressed payloads with
trailing bytes, uncompressed UTF-16, malformed JSON and the HTTP byte limit.
No provider, credentials or real user data is involved.
