import { describe, expect, test } from "vitest";
import { getRoleAccessBanner, getWalletRoles } from "../useRoles";

const ownerAddress = "GOWNER";
const viewerAddress = "GVIEWER";
const guardianAddress = "GGUARDIAN";
const strangerAddress = "GSTRANGER";

describe("useRoles helpers", () => {
  test("returns Owner from the current owner set", () => {
    expect(
      getWalletRoles({
        walletAddress: ownerAddress,
        ownerAddresses: [ownerAddress],
      })
    ).toEqual(["Owner"]);
  });

  test("returns configured Viewer and limited roles", () => {
    expect(
      getWalletRoles({
        walletAddress: viewerAddress,
        ownerAddresses: [],
        viewerAddresses: [viewerAddress],
      })
    ).toEqual(["Viewer"]);

    expect(
      getWalletRoles({
        walletAddress: guardianAddress,
        ownerAddresses: [],
        roleAssignments: { [guardianAddress]: ["Guardian"] },
      })
    ).toEqual(["Guardian"]);
  });

  test("classifies Viewer, limited-role, and unrecognized banner states", () => {
    expect(
      getRoleAccessBanner({
        walletAddress: viewerAddress,
        roles: ["Viewer"],
      })?.variant
    ).toBe("viewer");

    expect(
      getRoleAccessBanner({
        walletAddress: guardianAddress,
        roles: ["Guardian"],
      })?.variant
    ).toBe("role-holder");

    expect(
      getRoleAccessBanner({
        walletAddress: strangerAddress,
        roles: [],
      })?.variant
    ).toBe("unrecognized");
  });

  test("does not show a role banner for Owners or disconnected wallets", () => {
    expect(
      getRoleAccessBanner({
        walletAddress: ownerAddress,
        roles: ["Owner"],
      })
    ).toBeNull();

    expect(
      getRoleAccessBanner({
        walletAddress: null,
        roles: [],
      })
    ).toBeNull();
  });
});
