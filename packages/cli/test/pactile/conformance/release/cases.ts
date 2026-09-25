export type ReleaseCaseLane = "artifact" | "runtime" | "install" | "guard";

export interface ReleaseMatrixCase {
  id: string;
  lane: ReleaseCaseLane;
  expectation: string;
}

export const RELEASE_MATRIX_CASES: readonly ReleaseMatrixCase[] = [
  {
    id: "artifact-canonical-core",
    lane: "artifact",
    expectation: "canonical core tarball is first and self-contained",
  },
  {
    id: "artifact-canonical-cli",
    lane: "artifact",
    expectation: "canonical CLI pins canonical core and exposes pactile/cstl",
  },
  {
    id: "artifact-legacy-core",
    lane: "artifact",
    expectation: "legacy core shim pins canonical core",
  },
  {
    id: "artifact-legacy-cli",
    lane: "artifact",
    expectation: "legacy CLI shim pins canonical CLI and exposes cstl",
  },
  {
    id: "runtime-linux-minimum",
    lane: "runtime",
    expectation: "Linux runs Node 20.0.0",
  },
  {
    id: "runtime-linux-lts",
    lane: "runtime",
    expectation: "Linux runs current LTS",
  },
  {
    id: "runtime-linux-current",
    lane: "runtime",
    expectation: "Linux runs current Node",
  },
  {
    id: "runtime-windows-minimum",
    lane: "runtime",
    expectation: "Windows runs Node 20.0.0",
  },
  {
    id: "runtime-windows-lts",
    lane: "runtime",
    expectation: "Windows runs current LTS",
  },
  {
    id: "runtime-windows-current",
    lane: "runtime",
    expectation: "Windows runs current Node",
  },
  {
    id: "install-ambiguous-bin-rejected",
    lane: "install",
    expectation: "unowned cstl collision fails before prefix creation",
  },
  {
    id: "install-canonical-offline",
    lane: "install",
    expectation:
      "canonical profile owns pactile and cstl after offline install",
  },
  {
    id: "install-legacy-offline",
    lane: "install",
    expectation:
      "legacy recovery profile explicitly owns cstl after offline install",
  },
  {
    id: "guard-branch",
    lane: "guard",
    expectation: "wrong candidate branch fails closed",
  },
  {
    id: "guard-tag",
    lane: "guard",
    expectation: "wrong tag namespace fails closed",
  },
  {
    id: "guard-version",
    lane: "guard",
    expectation: "four-package version skew fails closed",
  },
  {
    id: "guard-manifest-checksum",
    lane: "guard",
    expectation: "invalid manifest receipt fails before artifact use",
  },
  {
    id: "guard-provenance",
    lane: "guard",
    expectation: "tag commit outside the required branch fails closed",
  },
  {
    id: "guard-reversed-dag",
    lane: "guard",
    expectation: "reverse publish order fails before npm auth or publish",
  },
];
