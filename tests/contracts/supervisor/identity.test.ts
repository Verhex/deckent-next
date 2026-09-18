import { expect, it } from 'vitest';
import { identifyDockerRequest } from '#adapters/index.js';
import type { SandboxRequest } from '#engine/index.js';
// Frozen pre-extraction 8023fb47 Docker identity outputs, including Unicode escape behavior.
const fixtures = {
  "options": {
    "executable": "/usr/bin/docker",
    "workspaceRoot": "/workspaces",
    "imageId": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "uid": 1000,
    "gid": 1000,
    "logMaxSizeKiB": 64,
    "logMaxFiles": 2,
    "memoryBytes": 268435456,
    "pids": 64,
    "cpus": 1,
    "tmpBytes": 16777216,
    "deadlineMs": 10000,
    "controlTimeoutMs": 10000,
    "outputBytes": 65536
  },
  "vectors": [
    {
      "request": {
        "protocolVersion": 1,
        "identity": {
          "generation": 1,
          "layoutRevision": "l",
          "scopeId": "ascii",
          "attemptId": "a",
          "taskId": "t",
          "runId": "r"
        },
        "workspace": "/workspaces/a",
        "argv": [
          "node",
          "-e",
          "console.log(\"<>&\")"
        ]
      },
      "handle": "deckent-5cac908d843ca266241544545e8051023ebe1a6261aca4f941b08aeb7e5796d3",
      "digest": "ed06d9dc7ab2b25d8e4279cd4ca3df3e4488916d77c7da2d3528bc7034de911d"
    },
    {
      "request": {
        "protocolVersion": 1,
        "identity": {
          "generation": 1,
          "layoutRevision": "l",
          "scopeId": "line\u2028break",
          "attemptId": "a",
          "taskId": "t",
          "runId": "r"
        },
        "workspace": "/workspaces/a",
        "argv": [
          "node",
          "-e",
          "console.log(\"<>&\")"
        ]
      },
      "handle": "deckent-c00e2ba669f255b6724a025fca6a458e69b367dee9f4ac89e6e0ce725649ed50",
      "digest": "05f19178fc16d030393a44923db34a2d2a8fd06bb374cf053277c9729422de8e"
    },
    {
      "request": {
        "protocolVersion": 1,
        "identity": {
          "generation": 1,
          "layoutRevision": "l",
          "scopeId": "\ud83d\ude00\ud800",
          "attemptId": "a",
          "taskId": "t",
          "runId": "r"
        },
        "workspace": "/workspaces/a",
        "argv": [
          "node",
          "-e",
          "console.log(\"<>&\")"
        ]
      },
      "handle": "deckent-6364229c1a4a509e377122481fc0daf90783041a9f138b241d022b0693b0f3ef",
      "digest": "12bd28fe8022bf309293e3fc6e99dc126ddc049285642359c24bd44eba9f6536"
    }
  ]
};
it.each(fixtures.vectors)('preserves existing Docker fence bytes for $request.identity.scopeId', ({ request, handle, digest }) => {
  const result = identifyDockerRequest(request as SandboxRequest, fixtures.options);
  expect(result.handle).toBe(handle); expect(result.digest).toBe(digest);
  expect(identifyDockerRequest({ ...request, identity: { ...request.identity } } as SandboxRequest, { ...fixtures.options })).toEqual(result);
});
