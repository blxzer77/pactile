import { describe, expect, it } from "vitest";
import { getAllMigrationVersions, getAllMigrations, getMigrationsForVersion } from "../../src/migrations/index.js";

describe("historical migration data integrity", () => {
  it("orders numeric prereleases and excludes the source version", () => {
    const versions = getAllMigrationVersions();
    const beta2 = versions.indexOf("0.3.0-beta.2");
    const beta10 = versions.indexOf("0.3.0-beta.10");
    if (beta2 >= 0 && beta10 >= 0) expect(beta2).toBeLessThan(beta10);
    expect(getMigrationsForVersion("0.3.0-beta.5", "0.3.0-beta.5")).toEqual([]);
  });

  it("keeps migration paths and safe-delete hashes valid", () => {
    for (const migration of getAllMigrations()) {
      expect(migration.from).toEqual(expect.any(String));
      expect(migration.from.length).toBeGreaterThan(0);
      expect(["rename", "rename-dir", "delete", "safe-file-delete"]).toContain(migration.type);
      if (migration.type === "rename" || migration.type === "rename-dir") expect(migration.to).toEqual(expect.any(String));
      if (migration.type === "safe-file-delete") {
        expect(migration.allowed_hashes?.length).toBeGreaterThan(0);
        for (const hash of migration.allowed_hashes ?? []) expect(hash).toMatch(/^[a-f0-9]{64}$/);
      }
    }
  });
});
