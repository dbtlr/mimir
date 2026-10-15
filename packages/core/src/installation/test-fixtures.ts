/** Executable test fixture for the public installation protocol. */
export const protocolCandidate = `#!/bin/sh
[ "$1" = installation-protocol ] || exit 2
printf '%s\\n' '{"installationProtocol":1}'
`;
