import type { WeightHistoryPoint } from "../../src/lib/contract";

const MOCK_OWNERS = [
  "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4IQDNC",
  "GBPLX2P3VWYKPQ7L5RI5OGXQ6T4G7QZMJ3HPQD7FZX5KJ3H2Z4YK5ABC",
];

export async function getOwners(): Promise<string[]> {
  return MOCK_OWNERS;
}

export async function getThreshold(): Promise<number> {
  return 2;
}

export async function getRequiredQuorumWeight(): Promise<number> {
  return 10;
}

export async function getOwnerWeight(_address: string): Promise<number> {
  return 5;
}

export async function getWeightCapPct(): Promise<number> {
  return 50;
}

export async function getTotalWeight(): Promise<number> {
  return 20;
}

export async function getOwnerWeights(): Promise<
  Array<{ address: string; weight: number }>
> {
  return MOCK_OWNERS.map((address, index) => ({
    address,
    weight: index === 0 ? 12 : 8,
  }));
}

export async function getClaimableAmount(_scheduleId: number): Promise<bigint> {
  return 5_000_000n;
}

export async function getHistoricalWeightChangeEvents() {
  return [
    {
      owner: MOCK_OWNERS[0],
      oldWeight: 10,
      newWeight: 12,
      timestamp: "2026-01-15",
      ledger: 100,
    },
  ];
}

export function reconstructTotalWeightHistory(
  _events: unknown[],
  currentTotalWeight: number,
): WeightHistoryPoint[] {
  const base = new Date("2026-01-15T12:00:00.000Z");
  return [
    {
      timestamp: "2026-01-01",
      ledger: 90,
      totalWeight: currentTotalWeight - 2,
      date: new Date("2026-01-01T12:00:00.000Z"),
    },
    {
      timestamp: "2026-01-15",
      ledger: 100,
      totalWeight: currentTotalWeight,
      date: base,
    },
  ];
}

export type { WeightHistoryPoint };
