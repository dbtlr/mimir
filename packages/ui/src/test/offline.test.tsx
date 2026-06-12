import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { OfflineBanner } from "../components/offline-banner";
import { connectivity } from "../lib/connectivity";
import { shouldPersistQuery } from "../lib/persist";

describe("connectivity", () => {
  test("any errored query means offline; lastSync is the freshest read", () => {
    const conn = connectivity([
      { isError: false, dataUpdatedAt: 1_000 },
      { isError: true, dataUpdatedAt: 5_000 },
      { isError: false, dataUpdatedAt: 3_000 },
    ]);
    expect(conn.offline).toBe(true);
    expect(conn.lastSync).toBe(5_000);
  });

  test("all queries healthy means online", () => {
    const conn = connectivity([{ isError: false, dataUpdatedAt: 1_000 }]);
    expect(conn.offline).toBe(false);
  });

  test("never-synced has a null lastSync", () => {
    const conn = connectivity([{ isError: true, dataUpdatedAt: 0 }]);
    expect(conn).toEqual({ offline: true, lastSync: null });
  });
});

describe("shouldPersistQuery", () => {
  test("a failed poll over last-known data stays in the snapshot", () => {
    // v5 flips status to "error" on a failed refetch while keeping data —
    // the status-based default would erase the offline cache as the server dies
    expect(shouldPersistQuery({ state: { data: { items: [] } } })).toBe(true);
  });

  test("a query that never got data is not persisted", () => {
    expect(shouldPersistQuery({ state: { data: undefined } })).toBe(false);
  });
});

describe("OfflineBanner", () => {
  test("renders the persistent banner when queries error over cached data", () => {
    render(<OfflineBanner offline={true} lastSync={Date.now() - 5 * 60_000} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Offline — last synced");
    expect(banner.textContent).toContain("5m ago");
  });

  test("names the never-synced case", () => {
    render(<OfflineBanner offline={true} lastSync={null} />);
    expect(screen.getByRole("status").textContent).toContain("never");
  });

  test("renders nothing while the server answers", () => {
    render(<OfflineBanner offline={false} lastSync={Date.now()} />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
