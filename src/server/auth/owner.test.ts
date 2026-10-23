import { describe, expect, it } from "vitest";
import { isLoopbackHost } from "./owner";

describe("isLoopbackHost", () => {
  it.each(["localhost", "localhost:3000", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST"])("allows %s", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each([
    null,
    "",
    "192.168.1.20:3000", // another device on the network
    "solas.example.com", // a public host name
    "localhost.evil.com", // DNS-rebinding style look-alike
    "127.0.0.1.nip.io",
  ])("rejects %s", (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });
});
